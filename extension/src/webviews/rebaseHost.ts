// Extension-host side of the interactive rebase editor: fetches the rebase
// preview, opens a singleton panel with the editable plan, and drives
// rebase/start + the conflict continue/abort loop.

import * as vscode from 'vscode';
import { RebaseEntry } from '@gitglasses/protocol';
import { EngineClient } from '../engine/engineClient';
import { RepositoryService } from '../model/repositoryService';
import { firstWorkspaceRepo } from '../views/viewBase';
import { renderWebviewHtml } from './webviewHtml';
import { confirmRebase } from '../commands/confirmations';
import { confirmDestructive, errorMessage, setStatus } from '../commands/ui';

type HostToWebviewMessage =
  | { type: 'init'; upstream: string; entries: { sha: string; summary: string }[] }
  | { type: 'busy'; busy: boolean };

type WebviewToHostMessage =
  | { type: 'ready' }
  | { type: 'start'; plan: RebaseEntry[] }
  | { type: 'cancel' };

export class RebaseWebviewHost implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private panelDisposables: vscode.Disposable[] = [];
  private repoId: string | undefined;
  private upstream: string | undefined;
  private pendingInit: { upstream: string; entries: { sha: string; summary: string }[] } | undefined;
  private running = false;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly engine: EngineClient,
    private readonly repos: RepositoryService,
  ) {}

  /** Opens the editor for `upstream`, prompting for one when not given. */
  async open(upstream?: string): Promise<void> {
    let repo;
    try {
      repo = await firstWorkspaceRepo(this.repos);
    } catch {
      repo = undefined;
    }
    if (!repo) {
      void vscode.window.showWarningMessage('GitGlasses: no git repository in this workspace.');
      return;
    }
    this.repoId = repo.repoId;

    if (!upstream) {
      const entered = await vscode.window.showInputBox({
        prompt: 'Rebase upstream (branch, tag, or sha)',
        placeHolder: 'e.g. origin/main',
        validateInput: (value) => (value.trim() ? undefined : 'Upstream is required'),
      });
      if (!entered?.trim()) return;
      upstream = entered.trim();
    }

    let entries: { sha: string; summary: string }[];
    try {
      ({ entries } = await this.engine.request('rebase/preview', {
        repoId: this.repoId,
        upstream,
      }));
    } catch (error) {
      void vscode.window.showErrorMessage(
        `GitGlasses: rebase preview failed: ${errorMessage(error)}`,
      );
      return;
    }
    if (entries.length === 0) {
      void vscode.window.showInformationMessage(
        `GitGlasses: no commits to rebase onto ${upstream}.`,
      );
      return;
    }

    this.upstream = upstream;
    this.pendingInit = { upstream, entries };

    if (this.panel) {
      this.panel.reveal();
      await this.postInit();
      return;
    }

    const distRoot = vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webviews');
    const panel = vscode.window.createWebviewPanel(
      'gitglasses.rebase',
      'Interactive Rebase',
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
      script: 'rebase.js',
      style: 'rebase.css',
      title: 'Interactive Rebase',
    });
    this.panelDisposables.push(
      panel.webview.onDidReceiveMessage((message: WebviewToHostMessage) =>
        this.onMessage(message),
      ),
      panel.onDidDispose(() => this.onPanelDisposed()),
    );
  }

  private async postInit(): Promise<void> {
    if (!this.pendingInit) return;
    await this.post({ type: 'init', ...this.pendingInit });
  }

  private async post(message: HostToWebviewMessage): Promise<void> {
    await this.panel?.webview.postMessage(message);
  }

  private async onMessage(message: WebviewToHostMessage): Promise<void> {
    switch (message.type) {
      case 'ready':
        await this.postInit();
        break;
      case 'cancel':
        this.panel?.dispose();
        break;
      case 'start':
        await this.startRebase(message.plan);
        break;
    }
  }

  private async startRebase(plan: RebaseEntry[]): Promise<void> {
    if (this.running || !this.repoId || !this.upstream) return;
    let branch = 'HEAD';
    try {
      const { head } = await this.engine.request('repo/state', { repoId: this.repoId });
      if (!head.detached && head.branch) branch = head.branch;
    } catch {
      // Branch name is presentational only; the confirmation still shows.
    }
    if (!(await confirmDestructive(confirmRebase(branch, this.upstream)))) return;

    this.running = true;
    await this.post({ type: 'busy', busy: true });
    try {
      const result = await this.engine.request('rebase/start', {
        repoId: this.repoId,
        upstream: this.upstream,
        plan,
      });
      await this.settle(result);
    } catch (error) {
      void vscode.window.showErrorMessage(`GitGlasses: rebase failed: ${errorMessage(error)}`);
    } finally {
      this.running = false;
      await this.post({ type: 'busy', busy: false });
    }
  }

  /** Drives the conflict loop until the rebase completes, aborts, or the user
   *  chooses to leave it paused. Closes the panel when the plan is done. */
  private async settle(result: { conflicts: boolean; completed: boolean }): Promise<void> {
    while (!result.completed) {
      if (!result.conflicts) break;
      const choice = await vscode.window.showWarningMessage(
        'Rebase paused on conflicts.',
        {
          modal: true,
          detail:
            'Resolve the conflicted files, stage them in Source Control, then choose Continue. Abort restores the branch to its pre-rebase state.',
        },
        'Open Files',
        'Continue',
        'Abort',
      );
      if (choice === 'Open Files') {
        await vscode.commands.executeCommand('workbench.view.scm');
        continue;
      }
      if (choice === 'Continue') {
        result = await this.engine.request('rebase/continue', { repoId: this.repoId! });
        continue;
      }
      if (choice === 'Abort') {
        await this.engine.request('rebase/abort', { repoId: this.repoId! });
        setStatus('Rebase aborted');
        this.panel?.dispose();
        return;
      }
      setStatus('Rebase paused on conflicts');
      return;
    }
    void vscode.window.showInformationMessage('GitGlasses: rebase completed.');
    this.panel?.dispose();
  }

  private onPanelDisposed(): void {
    for (const disposable of this.panelDisposables) disposable.dispose();
    this.panelDisposables = [];
    this.panel = undefined;
    this.pendingInit = undefined;
  }

  dispose(): void {
    this.panel?.dispose();
    this.onPanelDisposed();
  }
}

/** Registers the interactive-rebase command; the host lazily creates its
 *  panel. The returned host is also the entry point for the graph action. */
export function registerRebaseWebview(
  context: vscode.ExtensionContext,
  engine: EngineClient,
  repos: RepositoryService,
): { host: RebaseWebviewHost; disposables: vscode.Disposable[] } {
  const host = new RebaseWebviewHost(context, engine, repos);
  return {
    host,
    disposables: [
      host,
      vscode.commands.registerCommand('gitglasses.interactiveRebase', () => host.open()),
    ],
  };
}
