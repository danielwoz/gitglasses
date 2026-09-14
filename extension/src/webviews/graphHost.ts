// Extension-host side of the commit graph webview: a singleton panel that
// streams graph/rows pages to the canvas renderer, services its requests, and
// executes the context-menu mutation actions.

import * as vscode from 'vscode';
import { CommitSummaryInfo, GraphRow } from '@gitglasses/protocol';
import { EngineClient } from '@gitglasses/rpc';
import { CLI_UNAVAILABLE_MESSAGE, isMethodAvailable } from '../engine/capabilityGate';
import { RepositoryService } from '../model/repositoryService';
import { ActiveRepo, activeWorkspaceRepo } from '../views/viewBase';
import { openCommitDoc } from '../views/nodes';
import { shortSha } from '@gitglasses/protocol/sha';
import { renderWebviewHtml } from './webviewHtml';
import {
  confirmCherryPick,
  confirmMerge,
  confirmResetHard,
  confirmRevert,
} from '../commands/confirmations';
import {
  confirmDestructive,
  errorMessage,
  setStatus,
  showConflictGuidance,
} from '../commands/ui';
import { allowedDespiteConflicts } from '../commands/conflictGuard';
import { graphPageSize } from '../system/settings';

const REFRESH_DEBOUNCE_MS = 300;

type GraphActionId =
  | 'createBranch'
  | 'switchDetached'
  | 'cherryPick'
  | 'revert'
  | 'reset'
  | 'merge'
  | 'rebase';

const ACTION_LABELS: Record<GraphActionId, string> = {
  createBranch: 'create branch',
  switchDetached: 'switch',
  cherryPick: 'cherry-pick',
  revert: 'revert',
  reset: 'reset',
  merge: 'merge',
  rebase: 'rebase',
};

// Actions git refuses while a merge, rebase or cherry-pick is unresolved.
// Creating a branch is not one of them.
const CONFLICT_GUARDED: readonly GraphActionId[] = [
  'switchDetached',
  'cherryPick',
  'revert',
  'reset',
  'merge',
  'rebase',
];

// Engine method each context-menu action leads with, for capability gating.
const ACTION_METHODS: Record<GraphActionId, string> = {
  createBranch: 'mutate/branchCreate',
  switchDetached: 'mutate/switch',
  cherryPick: 'mutate/cherryPick',
  revert: 'mutate/revert',
  reset: 'mutate/reset',
  merge: 'mutate/merge',
  rebase: 'rebase/start',
};

type HostToWebviewMessage =
  | { type: 'reset' }
  | { type: 'rows'; rows: GraphRow[]; nextCursor?: string }
  | { type: 'theme' }
  | { type: 'error'; message: string };

type WebviewToHostMessage =
  | { type: 'ready' }
  | { type: 'loadMore'; cursor: string }
  | { type: 'select'; shas: string[] }
  | { type: 'openCommit'; sha: string }
  | { type: 'copySha'; sha: string }
  | { type: 'action'; action: GraphActionId; shas: string[] };

export class GraphWebviewHost implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private panelDisposables: vscode.Disposable[] = [];
  /** Fields the openCommit action needs, keyed by sha. The webview keeps the
   *  full rows, so lanes, edges, refs and dates are not retained here. */
  private commitsBySha = new Map<string, CommitSummaryInfo>();
  private repoId: string | undefined;
  private refetchTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly engine: EngineClient,
    private readonly repos: RepositoryService,
    private readonly openRebase: (upstream: string) => void | Promise<void>,
  ) {}

  /** Opens the graph. The repository is resolved first: without one there is
   *  nothing to draw, so the user gets an explanation instead of an empty
   *  panel. */
  async show(): Promise<void> {
    if (this.panel) {
      this.panel.reveal();
      return;
    }
    if (this.repoId === undefined) {
      let repo: ActiveRepo | undefined;
      try {
        repo = await activeWorkspaceRepo(this.repos);
      } catch {
        void vscode.window.showErrorMessage(
          'GitGlasses: cannot show the commit graph — the engine is unavailable.',
        );
        return;
      }
      if (!repo) {
        void vscode.window.showWarningMessage(
          'GitGlasses: no git repository in this workspace, so there is no commit graph to show.',
        );
        return;
      }
      this.repoId = repo.repoId;
    }
    const distRoot = vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webviews');
    const panel = vscode.window.createWebviewPanel(
      'gitglasses.graph',
      'Commit Graph',
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [distRoot],
      },
    );
    this.panel = panel;
    panel.iconPath = vscode.Uri.joinPath(this.context.extensionUri, 'media', 'gitglasses.svg');
    panel.webview.html = renderWebviewHtml(panel.webview, distRoot, {
      script: 'graph.js',
      style: 'graph.css',
      title: 'Commit Graph',
    });

    this.panelDisposables.push(
      panel.webview.onDidReceiveMessage((message: WebviewToHostMessage) =>
        this.onMessage(message),
      ),
      this.engine.onNotification('repo/didChange', (params) => {
        if (!Array.isArray(params?.changed)) return;
        const relevant = ['HEAD', 'refs', 'stash', 'index'] as const;
        if (relevant.some((kind) => params.changed.includes(kind))) this.scheduleRefetch();
      }),
      vscode.window.onDidChangeActiveColorTheme(() => {
        void this.post({ type: 'theme' });
      }),
      panel.onDidDispose(() => this.onPanelDisposed()),
    );
  }

  private onPanelDisposed(): void {
    if (this.refetchTimer !== undefined) clearTimeout(this.refetchTimer);
    this.refetchTimer = undefined;
    for (const disposable of this.panelDisposables) disposable.dispose();
    this.panelDisposables = [];
    this.panel = undefined;
    this.commitsBySha.clear();
  }

  dispose(): void {
    this.panel?.dispose();
    this.onPanelDisposed();
  }

  private async post(message: HostToWebviewMessage): Promise<void> {
    await this.panel?.webview.postMessage(message);
  }

  private async onMessage(message: WebviewToHostMessage): Promise<void> {
    switch (message.type) {
      case 'ready':
        await this.fetchAndPost();
        break;
      case 'loadMore':
        await this.fetchAndPost(message.cursor);
        break;
      case 'openCommit': {
        const commit = this.commitsBySha.get(message.sha);
        if (commit) await openCommitDoc(commit);
        break;
      }
      case 'copySha':
        await vscode.env.clipboard.writeText(message.sha);
        vscode.window.setStatusBarMessage(`Copied ${shortSha(message.sha)}`, 3000);
        break;
      case 'select':
        break; // Selection currently only drives webview-local rendering.
      case 'action':
        await this.handleAction(message.action, message.shas);
        break;
    }
  }

  private async handleAction(action: GraphActionId, shas: string[]): Promise<void> {
    const repoId = this.repoId;
    const sha = shas[0];
    if (!repoId || !sha) return;
    if (!isMethodAvailable(this.engine.capabilities(), ACTION_METHODS[action])) {
      void vscode.window.showWarningMessage(
        `GitGlasses: cannot ${ACTION_LABELS[action]}. ${CLI_UNAVAILABLE_MESSAGE}.`,
      );
      return;
    }
    if (
      CONFLICT_GUARDED.includes(action) &&
      !(await allowedDespiteConflicts(this.engine, repoId, ACTION_LABELS[action]))
    ) {
      return;
    }
    try {
      switch (action) {
        case 'createBranch':
          await this.createBranchAt(repoId, sha);
          break;
        case 'switchDetached':
          await this.engine.request('mutate/switch', { repoId, ref: sha });
          setStatus(`Checked out ${shortSha(sha)} (detached HEAD)`);
          break;
        case 'cherryPick': {
          // The webview sends selection newest-first; apply oldest-first.
          const ordered = [...shas].reverse();
          if (!(await confirmDestructive(confirmCherryPick(ordered)))) return;
          const { conflicts } = await this.engine.request('mutate/cherryPick', {
            repoId,
            shas: ordered,
          });
          if (conflicts) showConflictGuidance('Cherry-pick');
          else setStatus(`Cherry-picked ${ordered.length} commit${ordered.length === 1 ? '' : 's'}`);
          break;
        }
        case 'revert': {
          if (!(await confirmDestructive(confirmRevert(shas)))) return;
          const { conflicts } = await this.engine.request('mutate/revert', { repoId, shas });
          if (conflicts) showConflictGuidance('Revert');
          else setStatus(`Reverted ${shas.length} commit${shas.length === 1 ? '' : 's'}`);
          break;
        }
        case 'reset':
          await this.resetTo(repoId, sha);
          break;
        case 'merge': {
          const branch = await this.currentBranch(repoId);
          if (!(await confirmDestructive(confirmMerge(shortSha(sha), branch)))) return;
          const { conflicts } = await this.engine.request('mutate/merge', { repoId, ref: sha });
          if (conflicts) showConflictGuidance('Merge');
          else setStatus(`Merged ${shortSha(sha)} into '${branch}'`);
          break;
        }
        case 'rebase':
          // Opens the interactive rebase editor with this commit as the
          // upstream instead of rebasing immediately.
          await this.openRebase(sha);
          break;
      }
    } catch (error) {
      void vscode.window.showErrorMessage(
        `GitGlasses: ${ACTION_LABELS[action]} failed: ${errorMessage(error)}`,
      );
    }
  }

  private async currentBranch(repoId: string): Promise<string> {
    const { head } = await this.engine.request('repo/state', { repoId });
    return head.detached || !head.branch ? 'HEAD' : head.branch;
  }

  private async createBranchAt(repoId: string, sha: string): Promise<void> {
    const name = await vscode.window.showInputBox({
      prompt: `Branch name (created at ${shortSha(sha)})`,
      validateInput: (value) => (value.trim() ? undefined : 'Branch name is required'),
    });
    if (!name?.trim()) return;
    const mode = await vscode.window.showQuickPick(['Create', 'Create and Switch'], {
      placeHolder: `Create '${name.trim()}' at ${shortSha(sha)}`,
    });
    if (!mode) return;
    await this.engine.request('mutate/branchCreate', {
      repoId,
      name: name.trim(),
      startPoint: sha,
      checkout: mode === 'Create and Switch',
    });
    setStatus(`Created branch '${name.trim()}' at ${shortSha(sha)}`);
  }

  private async resetTo(repoId: string, sha: string): Promise<void> {
    const branch = await this.currentBranch(repoId);
    const mode = await vscode.window.showQuickPick(
      [
        { label: 'Soft', description: 'keep index and working tree', mode: 'soft' as const },
        { label: 'Mixed', description: 'reset index, keep working tree', mode: 'mixed' as const },
        {
          label: 'Hard',
          description: 'discard index and working tree changes',
          mode: 'hard' as const,
        },
      ],
      { placeHolder: `Reset '${branch}' to ${shortSha(sha)}` },
    );
    if (!mode) return;
    if (mode.mode === 'hard' && !(await confirmDestructive(confirmResetHard(branch, shortSha(sha))))) {
      return;
    }
    await this.engine.request('mutate/reset', { repoId, ref: sha, mode: mode.mode });
    setStatus(`Reset '${branch}' to ${shortSha(sha)} (${mode.mode})`);
  }

  private async fetchAndPost(cursor?: string): Promise<void> {
    if (!this.panel) return;
    try {
      if (!this.repoId) {
        const repo = await activeWorkspaceRepo(this.repos);
        if (!repo) {
          await this.post({
            type: 'error',
            message: 'No git repository in this workspace.',
          });
          return;
        }
        this.repoId = repo.repoId;
      }
      const result = await this.engine.request('graph/rows', {
        repoId: this.repoId,
        cursor,
        limit: graphPageSize(),
        include: { stashes: true, wip: true },
      });
      for (const row of result.rows) {
        this.commitsBySha.set(row.sha, {
          sha: row.sha,
          parents: row.parents,
          author: row.author,
          committer: row.author,
          summary: row.summary,
        });
      }
      await this.post({ type: 'rows', rows: result.rows, nextCursor: result.nextCursor });
    } catch (error) {
      // The panel shows why it is empty; the next repo change refetches.
      await this.post({
        type: 'error',
        message: `Could not load the commit graph: ${errorMessage(error)}`,
      });
    }
  }

  private scheduleRefetch(): void {
    if (this.refetchTimer !== undefined) clearTimeout(this.refetchTimer);
    this.refetchTimer = setTimeout(() => {
      this.refetchTimer = undefined;
      this.commitsBySha.clear();
      void this.post({ type: 'reset' }).then(() => this.fetchAndPost());
    }, REFRESH_DEBOUNCE_MS);
  }

}

/** Registers the show-graph command; the host lazily creates its panel. */
export function registerGraphWebview(
  context: vscode.ExtensionContext,
  engine: EngineClient,
  repos: RepositoryService,
  openRebase: (upstream: string) => void | Promise<void>,
): vscode.Disposable[] {
  const host = new GraphWebviewHost(context, engine, repos, openRebase);
  return [host, vscode.commands.registerCommand('gitglasses.showGraph', () => host.show())];
}
