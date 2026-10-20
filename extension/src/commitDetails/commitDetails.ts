// The gitglasses.showCommitDetails command: shows one commit, as the engine's
// commit/details reports it, in the Commit Details panel, the same view the
// commit graph's details pane renders. Any surface that opens a commit goes
// through the command. It never touches the clipboard; copying is an explicit
// button in the view.

import * as vscode from 'vscode';
import * as path from 'node:path';
import { shortSha } from '@gitglasses/protocol/sha';
import { EngineClient } from '@gitglasses/rpc';
import { RepositoryService } from '../model/repositoryService';
import { errorMessage } from '../commands/ui';
import { renderWebviewHtml } from '../webviews/webviewHtml';
import type {
  CommitPanelState,
  HostToCommitPanelMessage,
  DetailsToHostMessage,
} from '../../webviews-src/graph/ipc';
import {
  copyText,
  errorView,
  loadCommitView,
  openAllChanges,
  openFileDiff,
  registerEmptyDocuments,
} from './commitViews';

export const SHOW_COMMIT_DETAILS_COMMAND = 'gitglasses.showCommitDetails';

/** The panel type, also its serializer's key. */
export const COMMIT_DETAILS_VIEW_TYPE = 'gitglasses.commitDetails';

/** Arguments of gitglasses.showCommitDetails. */
export interface ShowCommitDetailsArgs {
  /** The repository's root, or any path inside it. */
  repoPath: string;
  /** Any revision naming the commit: a full or short sha, HEAD, a branch, a tag. */
  sha: string;
}

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

/** The engine's id for the repository at `repoPath`, registering it when the
 *  repository service does not know it yet. */
async function repoIdFor(repos: RepositoryService, repoPath: string): Promise<string | undefined> {
  const known = repos.repositories().find((repo) => repos.isRootOf(repo.repoId, repoPath));
  if (known) return known.repoId;
  const probe = vscode.Uri.file(path.join(repoPath, PROBE));
  return (await repos.locateOrDiscover(probe, { watch: false }))?.repoId;
}

/** The single Commit Details panel; showing another commit retargets it. */
class CommitDetailsPanel implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private panelDisposables: vscode.Disposable[] = [];
  private target: CommitPanelState | undefined;
  /** Bumped per load, so a slow answer for an earlier commit is dropped. */
  private loads = 0;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly engine: EngineClient,
    private readonly repos: RepositoryService,
  ) {}

  async show(args: ShowCommitDetailsArgs): Promise<void> {
    this.target = { repoPath: args.repoPath, sha: args.sha };
    if (this.panel) {
      this.panel.reveal(undefined, false);
      await this.load();
      return;
    }
    const distRoot = vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webviews');
    this.adopt(
      vscode.window.createWebviewPanel(
        COMMIT_DETAILS_VIEW_TYPE,
        `Commit ${shortSha(args.sha)}`,
        vscode.ViewColumn.Active,
        { enableScripts: true, localResourceRoots: [distRoot] },
      ),
    );
  }

  /** Wires a panel, new or restored after a reload. */
  adopt(panel: vscode.WebviewPanel, restored?: CommitPanelState): void {
    if (restored && isArgs(restored)) this.target ??= restored;
    if (this.panel && this.panel !== panel) this.panel.dispose();
    const distRoot = vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webviews');
    this.panel = panel;
    panel.webview.options = { enableScripts: true, localResourceRoots: [distRoot] };
    panel.iconPath = vscode.Uri.joinPath(this.context.extensionUri, 'media', 'gitglasses.svg');
    panel.webview.html = renderWebviewHtml(panel.webview, distRoot, {
      script: 'commitDetails.js',
      style: 'commitDetails.css',
      title: 'Commit Details',
    });
    this.panelDisposables.push(
      panel.webview.onDidReceiveMessage((message: DetailsToHostMessage | { type: 'ready' }) =>
        this.onMessage(message),
      ),
      panel.onDidDispose(() => this.onPanelDisposed(panel)),
    );
  }

  private async post(message: HostToCommitPanelMessage): Promise<void> {
    await this.panel?.webview.postMessage(message);
  }

  private async load(): Promise<void> {
    const target = this.target;
    if (!target || !this.panel) return;
    const load = ++this.loads;
    this.panel.title = `Commit ${shortSha(target.sha)}`;
    await this.post({ type: 'loading' });
    let view;
    let shown = target;
    try {
      const repoId = await repoIdFor(this.repos, target.repoPath);
      if (!repoId) throw new Error(`no git repository at ${target.repoPath}`);
      view = await loadCommitView(this.engine, repoId, target.sha);
      // Name the panel by the full sha a branch or tag resolved to.
      if (view.kind === 'commit') shown = { ...target, sha: view.details.sha };
    } catch (error) {
      view = errorView(`commit ${shortSha(target.sha)}`, error);
    }
    if (load !== this.loads) return;
    this.target = shown;
    if (this.panel) this.panel.title = `Commit ${shortSha(shown.sha)}`;
    await this.post({ type: 'show', view, state: shown });
  }

  private async onMessage(message: DetailsToHostMessage | { type: 'ready' }): Promise<void> {
    const target = this.target;
    try {
      switch (message.type) {
        case 'ready':
          await this.load();
          break;
        case 'showCommit':
          if (target) await this.show({ repoPath: target.repoPath, sha: message.sha });
          break;
        case 'copy':
          await copyText(message.text, message.label);
          break;
        case 'openFile':
        case 'openChanges': {
          if (!target) return;
          const repoId = await repoIdFor(this.repos, target.repoPath);
          if (!repoId) return;
          if (message.type === 'openFile') {
            await openFileDiff(repoId, target.repoPath, message.target);
          } else {
            await openAllChanges(this.engine, repoId, message.target);
          }
          break;
        }
      }
    } catch (error) {
      void vscode.window.showErrorMessage(`GitGlasses: ${errorMessage(error)}`);
    }
  }

  private onPanelDisposed(panel: vscode.WebviewPanel): void {
    if (this.panel !== panel) return;
    for (const disposable of this.panelDisposables.splice(0)) disposable.dispose();
    this.panel = undefined;
    this.target = undefined;
  }

  dispose(): void {
    this.panel?.dispose();
  }
}

/** Registers the command that opens the Commit Details panel, and the
 *  serializer that brings the panel back after a reload. */
export function registerCommitDetails(
  context: vscode.ExtensionContext,
  engine: EngineClient,
  repos: RepositoryService,
): vscode.Disposable[] {
  const panel = new CommitDetailsPanel(context, engine, repos);
  return [
    panel,
    registerEmptyDocuments(),
    vscode.window.registerWebviewPanelSerializer(COMMIT_DETAILS_VIEW_TYPE, {
      deserializeWebviewPanel: async (webviewPanel, state: unknown) => {
        panel.adopt(webviewPanel, isArgs(state) ? state : undefined);
      },
    }),
    vscode.commands.registerCommand(SHOW_COMMIT_DETAILS_COMMAND, async (args?: unknown) => {
      if (!isArgs(args)) {
        void vscode.window.showWarningMessage(
          'GitGlasses: Show Commit Details needs a repository path and a commit.',
        );
        return;
      }
      try {
        await panel.show(args);
      } catch (error) {
        void vscode.window.showErrorMessage(
          `GitGlasses: cannot show commit ${shortSha(args.sha)}: ${errorMessage(error)}`,
        );
      }
    }),
  ];
}
