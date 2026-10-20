import * as vscode from 'vscode';
import { UNCOMMITTED_SHA, type BlameHunk, type CommitDetails } from '@gitglasses/protocol';
import type { CancellationLike, EngineClient } from '@gitglasses/rpc';
import type { RepoDescriptor } from '@gitglasses/integrations';
import { escapeMarkdown } from '../system/markdown';
import { supportsRemoteUrls } from '../integrations/remoteUrls';
import type { FileBlame } from '../model/blameModel';
import { lfsHasUncommittedChange, lfsLastChange } from './blameFormat';
import {
  BLAME_HOVER_COMMANDS,
  joinBlocks,
  messageBlocks,
  pullRequestNumber,
  pullRequestUrl,
  renderCommitHover,
  renderLfsNotice,
  renderUncommittedHover,
} from './blameHoverLogic';
import { BlameTarget, DocumentBlameService } from './documentBlame';

/** How long a hover waits for the full commit message before showing the
 *  summary line alone. */
const DETAILS_WAIT_MS = 1500;
/** Commits whose details are kept for later hovers. */
const MAX_CACHED_DETAILS = 100;

export interface HoverEnrichment {
  /** Autolinks issue references in commit text (pure text substitution — must
   *  never hit the network). It returns markdown with the surrounding text
   *  already escaped. */
  autolink?(text: string, repoRoot: string): Promise<string>;
  /** The forge hosting a repository, from its remotes (no network). */
  hosting?(repoRoot: string): Promise<{ providerId: string; repo: RepoDescriptor } | undefined>;
}

function delay(ms: number): Promise<undefined> {
  return new Promise((resolve) => setTimeout(() => resolve(undefined), ms));
}

// Renders the blame of one line as markdown, for the editor hover and the
// status bar tooltip alike: the commit's full message (commit/details,
// fetched once per commit and kept), its pull request when the message names
// one, and command links to the commit, its changes and the file before it.
export class BlameHoverRenderer {
  private details = new Map<string, Promise<CommitDetails | undefined>>();

  constructor(
    private readonly engine: EngineClient,
    private readonly enrichment: HoverEnrichment = {},
  ) {}

  /** The hover for 1-based `line`, or undefined when the line has no blame. */
  async render(
    blame: FileBlame,
    target: BlameTarget,
    line: number,
    token?: CancellationLike,
  ): Promise<vscode.MarkdownString | undefined> {
    let notice: string | undefined;
    let hunk: BlameHunk | undefined;
    if (blame.lfs) {
      const last = lfsLastChange(blame);
      if (!last) return undefined;
      notice = renderLfsNotice(lfsHasUncommittedChange(blame));
      hunk = blame.hunks.find((h) => h.sha === last.sha);
    } else {
      hunk = blame.hunks.find((h) => line >= h.resultLine && line < h.resultLine + h.lineCount);
    }
    if (!hunk) return undefined;

    const markdown = new vscode.MarkdownString();
    markdown.supportThemeIcons = true;
    markdown.isTrusted = { enabledCommands: [...BLAME_HOVER_COMMANDS] };
    if (hunk.sha === UNCOMMITTED_SHA) {
      markdown.appendMarkdown(renderUncommittedHover(target.documentUri));
      return markdown;
    }
    const commit = blame.commits[hunk.sha];
    if (!commit) return undefined;

    const [details, hosting] = await Promise.all([
      Promise.race([this.commitDetails(target.repoId, hunk.sha), delay(DETAILS_WAIT_MS)]),
      target.rootPath && this.enrichment.hosting
        ? this.enrichment.hosting(target.rootPath).catch(() => undefined)
        : undefined,
    ]);
    if (token?.isCancellationRequested) return undefined;

    const linkify = async (text: string): Promise<string> =>
      this.enrichment.autolink && target.rootPath
        ? this.enrichment.autolink(text, target.rootPath).catch(() => escapeMarkdown(text))
        : escapeMarkdown(text);

    const subject = details?.subject || commit.summary;
    const { blocks, truncated } = messageBlocks(details?.body ?? '');
    const rendered = await Promise.all(
      blocks.map(async (block) => ({
        markdown: await linkify(block.text),
        listItem: block.listItem,
      })),
    );
    const number = pullRequestNumber(subject, details?.body ?? '');
    const prUrl =
      number !== undefined && hosting
        ? pullRequestUrl(hosting.providerId, hosting.repo, number)
        : undefined;

    const body = renderCommitHover({
      hunk,
      commit,
      line: blame.lfs ? hunk.resultLine : line,
      target: { repoId: target.repoId, repoPath: target.rootPath, path: target.relativePath },
      subject: await linkify(subject),
      body: rendered.length > 0 ? joinBlocks(rendered) : undefined,
      bodyTruncated: truncated,
      stats: details?.stats,
      pullRequest: prUrl && number !== undefined ? { number, url: prUrl } : undefined,
      remote: hosting !== undefined && supportsRemoteUrls(hosting.providerId),
    });
    markdown.appendMarkdown(notice ? `${notice}\n\n${body}` : body);
    return markdown;
  }

  /** The commit's details, asked of the engine once and kept. */
  private commitDetails(repoId: string, sha: string): Promise<CommitDetails | undefined> {
    const key = `${repoId}\0${sha}`;
    let cached = this.details.get(key);
    if (cached) {
      this.details.delete(key);
      this.details.set(key, cached);
      return cached;
    }
    cached = this.engine.request('commit/details', { repoId, sha }).catch(() => {
      // Not kept, so a later hover asks again.
      this.details.delete(key);
      return undefined;
    });
    this.details.set(key, cached);
    if (this.details.size > MAX_CACHED_DETAILS) {
      const oldest = this.details.keys().next().value;
      if (oldest !== undefined) this.details.delete(oldest);
    }
    return cached;
  }
}

// Commit details on hover over any line, from the same blame every other
// surface uses.
export class BlameHoverProvider implements vscode.HoverProvider {
  constructor(
    private readonly blame: DocumentBlameService,
    private readonly renderer: BlameHoverRenderer,
  ) {}

  async provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
  ): Promise<vscode.Hover | undefined> {
    if (!this.blame.settings.hoversEnabled || !this.blame.supports(document)) return undefined;
    const result = await this.blame.blameDocument(document, token);
    if (result.kind !== 'blame' || token.isCancellationRequested) return undefined;
    const markdown = await this.renderer.render(
      result.blame,
      result.target,
      position.line + 1,
      token,
    );
    if (!markdown || token.isCancellationRequested) return undefined;
    return new vscode.Hover(markdown, document.lineAt(position.line).range);
  }
}
