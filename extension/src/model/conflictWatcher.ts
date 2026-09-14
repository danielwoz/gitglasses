// Unresolved-conflict indicator. A merge, rebase or cherry-pick started
// anywhere — the palette, the graph, or a terminal outside the window —
// leaves conflicted files behind, and nothing else in the UI says so. This
// polls status/summary when the repository changes and publishes the count to
// a status bar item and a when-clause context key.

import * as vscode from 'vscode';
import type { EngineClient } from '@gitglasses/rpc';
import type { RepositoryService } from './repositoryService';
import { activeWorkspaceRepo } from '../views/viewBase';
import { conflictLabel, conflictTooltip } from './conflictLogic';

const REFRESH_DEBOUNCE_MS = 300;

export class ConflictWatcher implements vscode.Disposable {
  private readonly statusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    96,
  );
  private conflicted: string[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private disposables: vscode.Disposable[] = [];

  constructor(
    private readonly engine: EngineClient,
    private readonly repos: RepositoryService,
  ) {
    this.statusBar.command = 'workbench.view.scm';
    this.statusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    this.disposables.push(
      this.statusBar,
      // The handshake is the first moment the engine can answer, and the one
      // it can answer again after a restart.
      engine.onDidChangeCapabilities(() => this.schedule()),
      engine.onNotification('repo/didChange', (params) => {
        if (!Array.isArray(params?.changed)) return;
        const relevant: readonly string[] = ['index', 'HEAD', 'refs'];
        if (params.changed.some((kind: string) => relevant.includes(kind))) this.schedule();
      }),
    );
  }

  /** Conflicted paths as of the last refresh. */
  current(): readonly string[] {
    return this.conflicted;
  }

  /** Re-reads the active repo's conflicted files, coalescing bursts. */
  schedule(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.refresh();
    }, REFRESH_DEBOUNCE_MS);
  }

  async refresh(): Promise<void> {
    let conflicted: string[] = [];
    try {
      const repo = await activeWorkspaceRepo(this.repos);
      if (repo) {
        const status = await this.engine.request('status/summary', { repoId: repo.repoId });
        conflicted = [...status.conflicted];
      }
    } catch {
      // Engine down or restarting: report nothing rather than a stale count.
    }
    this.conflicted = conflicted;
    this.render();
  }

  private render(): void {
    const count = this.conflicted.length;
    void vscode.commands.executeCommand('setContext', 'gitglasses.hasConflicts', count > 0);
    if (count === 0) {
      this.statusBar.hide();
      return;
    }
    this.statusBar.text = `$(warning) ${conflictLabel(count)}`;
    this.statusBar.tooltip = conflictTooltip(this.conflicted);
    this.statusBar.show();
  }

  dispose(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    for (const disposable of this.disposables.splice(0)) disposable.dispose();
  }
}
