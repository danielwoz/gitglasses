// The gitglasses.showCommitDetails command: shows one commit, as the
// engine's commit/details reports it, in a read-only virtual document. Any
// surface that opens a commit goes through the command, so a richer details
// view can take it over without touching the callers.

import * as vscode from 'vscode';
import * as path from 'node:path';
import type { CommitDetails } from '@gitglasses/protocol';
import { shortSha } from '@gitglasses/protocol/sha';
import { EngineClient } from '@gitglasses/rpc';
import { RepositoryService } from '../model/repositoryService';
import { errorMessage } from '../commands/ui';
import { renderCommitDetails } from './commitDetailsLogic';

export const SHOW_COMMIT_DETAILS_COMMAND = 'gitglasses.showCommitDetails';

/** gitglasses-commit:/Commit <short sha>.md?repoPath=<root>&sha=<full sha> */
export const COMMIT_DETAILS_SCHEME = 'gitglasses-commit';

/** Arguments of gitglasses.showCommitDetails. */
export interface ShowCommitDetailsArgs {
  /** The repository's root, or any path inside it. */
  repoPath: string;
  /** Any revision naming the commit: a full or short sha, HEAD, a branch, a tag. */
  sha: string;
}

/** Rendered documents kept for reopening without asking the engine again. */
const MAX_CACHED_DOCUMENTS = 50;

/** A child name that never exists. locateOrDiscover asks about a file's
 *  directory, so probing this child asks about the directory itself. */
const PROBE = '.gitglasses';

function isArgs(value: unknown): value is ShowCommitDetailsArgs {
  const args = value as Partial<ShowCommitDetailsArgs> | undefined;
  return (
    typeof args?.repoPath === 'string' &&
    args.repoPath !== '' &&
    typeof args.sha === 'string' &&
    args.sha !== ''
  );
}

function documentUri(repoPath: string, sha: string): vscode.Uri {
  return vscode.Uri.from({
    scheme: COMMIT_DETAILS_SCHEME,
    path: `/Commit ${shortSha(sha)}.md`,
    query: new URLSearchParams({ repoPath, sha }).toString(),
  });
}

/** The engine's id for the repository at `repoPath`, registering it when the
 *  repository service does not know it yet. */
async function repoIdFor(repos: RepositoryService, repoPath: string): Promise<string | undefined> {
  const known = repos.repositories().find((repo) => repos.isRootOf(repo.repoId, repoPath));
  if (known) return known.repoId;
  const probe = vscode.Uri.file(path.join(repoPath, PROBE));
  return (await repos.locateOrDiscover(probe, { watch: false }))?.repoId;
}

class CommitDetailsDocuments implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly contents = new Map<string, string>();
  private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.emitter.event;

  constructor(
    private readonly engine: EngineClient,
    private readonly repos: RepositoryService,
  ) {}

  /** Asks the engine for the commit; throws when the repository or the
   *  commit cannot be found. */
  async fetch(repoPath: string, sha: string): Promise<CommitDetails> {
    const repoId = await repoIdFor(this.repos, repoPath);
    if (!repoId) throw new Error(`no git repository at ${repoPath}`);
    return this.engine.request('commit/details', { repoId, sha });
  }

  async show(args: ShowCommitDetailsArgs): Promise<void> {
    const details = await this.fetch(args.repoPath, args.sha);
    const uri = documentUri(args.repoPath, details.sha);
    const key = uri.toString();
    this.contents.delete(key);
    if (this.contents.size >= MAX_CACHED_DOCUMENTS) {
      const oldest = this.contents.keys().next().value;
      if (oldest !== undefined) this.contents.delete(oldest);
    }
    this.contents.set(key, renderCommitDetails(details));
    // An open document re-reads its content: refs may have moved since.
    this.emitter.fire(uri);
    await vscode.window.showTextDocument(uri, { preview: true });
  }

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const cached = this.contents.get(uri.toString());
    if (cached !== undefined) return cached;
    // A document restored with the window, or evicted from the cache.
    const query = new URLSearchParams(uri.query);
    const repoPath = query.get('repoPath');
    const sha = query.get('sha');
    if (!repoPath || !sha) return 'Not a GitGlasses commit document.\n';
    try {
      return renderCommitDetails(await this.fetch(repoPath, sha));
    } catch (error) {
      return `Could not load commit ${sha}: ${errorMessage(error)}\n`;
    }
  }

  dispose(): void {
    this.contents.clear();
    this.emitter.dispose();
  }
}

/** Registers the commit document scheme and the command that opens it. */
export function registerCommitDetails(
  engine: EngineClient,
  repos: RepositoryService,
): vscode.Disposable[] {
  const documents = new CommitDetailsDocuments(engine, repos);
  return [
    documents,
    vscode.workspace.registerTextDocumentContentProvider(COMMIT_DETAILS_SCHEME, documents),
    vscode.commands.registerCommand(SHOW_COMMIT_DETAILS_COMMAND, async (args?: unknown) => {
      if (!isArgs(args)) {
        void vscode.window.showWarningMessage(
          'GitGlasses: Show Commit Details needs a repository path and a commit.',
        );
        return;
      }
      try {
        await documents.show(args);
      } catch (error) {
        void vscode.window.showErrorMessage(
          `GitGlasses: cannot show commit ${shortSha(args.sha)}: ${errorMessage(error)}`,
        );
      }
    }),
  ];
}
