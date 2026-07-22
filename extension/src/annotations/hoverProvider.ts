import * as vscode from 'vscode';
import { UNCOMMITTED_SHA } from '@gitglasses/protocol';
import { BlameModel } from '../model/blameModel';
import { RepositoryService } from '../model/repositoryService';

// Commit details on hover over any line, from the same cached whole-file
// blame the inline annotation uses.
export class BlameHoverProvider implements vscode.HoverProvider {
  constructor(
    private readonly blame: BlameModel,
    private readonly repos: RepositoryService,
    /** Optional enrichment: autolinks issue references in the commit summary
     *  (pure text substitution — must never hit the network). */
    private readonly autolink?: (text: string, repoRoot: string) => Promise<string>,
  ) {}

  async provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
  ): Promise<vscode.Hover | undefined> {
    const located = await this.repos.locateOrDiscover(document.uri);
    if (!located || token.isCancellationRequested) return undefined;

    const fileBlame = await this.blame
      .getBlame(
        {
          repoId: located.repoId,
          path: located.relativePath,
          version: document.isDirty ? document.version : -1,
        },
        token,
      )
      .catch(() => undefined);
    if (!fileBlame || token.isCancellationRequested) return undefined;

    const hunk = this.blame.hunkForLine(fileBlame, position.line + 1);
    if (!hunk) return undefined;

    const markdown = new vscode.MarkdownString();
    markdown.supportThemeIcons = true;
    if (hunk.sha === UNCOMMITTED_SHA) {
      markdown.appendMarkdown('$(edit) **Uncommitted changes**');
    } else {
      const commit = fileBlame.commits[hunk.sha];
      if (!commit) return undefined;
      const date = new Date(commit.author.time * 1000);
      let summary = commit.summary;
      if (this.autolink) {
        summary = await this.autolink(summary, located.rootPath).catch(() => commit.summary);
      }
      markdown.appendMarkdown(
        `$(git-commit) **${commit.author.name}** <${commit.author.email}>\n\n` +
          `${summary}\n\n` +
          `\`${hunk.sha.slice(0, 12)}\` • ${date.toLocaleString()}` +
          (hunk.path !== located.relativePath ? ` • was \`${hunk.path}\`` : ''),
      );
    }
    return new vscode.Hover(markdown, document.lineAt(position.line).range);
  }
}
