// Extension-host side of the interactive rebase editor: checks the working
// tree and picks the upstream before anything else, fetches the rebase
// preview, opens a singleton panel with the editable plan, and drives
// rebase/start. A stopped rebase (conflicts, an edit step) stays in the panel
// as a non-modal paused state with Continue, Skip and Abort, which the
// gitglasses.rebase.* commands and a status bar item also reach, so the user
// can work on the files in between.

import * as vscode from 'vscode';
import type { RebaseEntry } from '@gitglasses/protocol';
import { EngineClient } from '@gitglasses/rpc';
import { isMethodAvailable, unavailableMessage } from '../engine/capabilityGate';
import { RepositoryService } from '../model/repositoryService';
import { ActiveRepo, activeWorkspaceRepo } from '../views/viewBase';
import { renderWebviewHtml } from './webviewHtml';
import { confirmRebase } from '../commands/confirmations';
import { confirmDestructive, errorMessage, setStatus } from '../commands/ui';
import { LogFn, reportGitError } from '../views/errorReport';
import { pickRebaseTarget } from '../views/refPicker';
import type {
  HostToWebviewMessage,
  RebaseInit,
  RebasePaused,
  WebviewToHostMessage,
} from '../../webviews-src/rebase/ipc';
import {
  RebaseSession,
  autoStashPrompt,
  isDirty,
  staleReason,
} from './rebaseHostLogic';

const RECHECK_DELAY_MS = 300;

type ResumeAction = 'continue' | 'skip' | 'abort';

export class RebaseWebviewHost implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private panelDisposables: vscode.Disposable[] = [];
  private repo: ActiveRepo | undefined;
  private session: RebaseSession | undefined;
  /** Messages that describe the panel's state, replayed when it (re)loads. */
  private init: RebaseInit | undefined;
  private overlay: HostToWebviewMessage | undefined;
  private ready = false;
  private running = false;
  private recheckTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly emitter = new vscode.EventEmitter<void>();
  /** Fires when a rebase this host drove starts, stops or ends. */
  readonly onDidChangeState = this.emitter.event;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly engine: EngineClient,
    private readonly repos: RepositoryService,
    private readonly log: LogFn,
  ) {}

  private available(): boolean {
    const caps = this.engine.capabilities();
    if (isMethodAvailable(caps, 'rebase/start')) return true;
    void vscode.window.showWarningMessage(`GitGlasses: cannot rebase. ${unavailableMessage(caps)}.`);
    return false;
  }

  private async activeRepo(): Promise<ActiveRepo | undefined> {
    let repo: ActiveRepo | undefined;
    try {
      repo = await activeWorkspaceRepo(this.repos);
    } catch {
      repo = undefined;
    }
    if (!repo) {
      void vscode.window.showWarningMessage('GitGlasses: no git repository in this workspace.');
    }
    return repo;
  }

  private async rebaseInProgress(repo: ActiveRepo): Promise<boolean> {
    const { sequencer } = await this.engine.request('repo/state', { repoId: repo.repoId });
    return sequencer.operation === 'rebase';
  }

  /** Opens the editor for `upstream`, asking for one when not given. A rebase
   *  already under way opens in its paused state instead. */
  async open(upstream?: string): Promise<void> {
    if (!this.available()) return;
    if (this.running) {
      this.panel?.reveal();
      return;
    }
    const repo = await this.activeRepo();
    if (!repo) return;
    try {
      if (await this.rebaseInProgress(repo)) {
        this.repo = repo;
        await this.showPausedPanel();
        return;
      }
      // The working tree is checked before the user does any planning:
      // a rebase git would refuse is not worth setting up.
      const status = await this.engine.request('status/summary', { repoId: repo.repoId });
      if (status.conflicted.length > 0) {
        void vscode.window.showWarningMessage(
          `GitGlasses: ${status.conflicted.length} conflicted file(s) are unresolved. Finish or abort the operation in progress before rebasing.`,
        );
        return;
      }
      let autoStash = false;
      if (isDirty(status)) {
        if (!(await this.askAutoStash(status))) return;
        autoStash = true;
      }
      const target = upstream ?? (await pickRebaseTarget(this.engine, repo));
      if (!target) return;
      const branch = status.branch || 'HEAD';
      const preview = await this.engine.request('rebase/preview', {
        repoId: repo.repoId,
        upstream: target,
      });
      if (preview.entries.length === 0) {
        void vscode.window.showInformationMessage(
          `GitGlasses: '${branch}' has no commits to rebase onto ${target}.`,
        );
        return;
      }
      this.repo = repo;
      this.session = {
        upstream: target,
        branch,
        headSha: preview.headSha,
        upstreamSha: preview.upstreamSha,
        autoStash,
      };
      this.overlay = undefined;
      this.ensurePanel();
      this.setInit({
        mode: 'plan',
        upstream: target,
        branch,
        entries: preview.entries,
        mergeCount: preview.mergeCount,
        autoStash,
        keepPlan: false,
      });
    } catch (error) {
      reportGitError('Rebase', error, this.log);
    }
  }

  private async askAutoStash(status: { staged: unknown[]; unstaged: unknown[] }): Promise<boolean> {
    const prompt = autoStashPrompt(status);
    const choice = await vscode.window.showWarningMessage(
      prompt.message,
      { modal: true, detail: prompt.detail },
      'Stash & Rebase',
    );
    return choice === 'Stash & Rebase';
  }

  /** Shows the paused rebase of the active repository, if there is one. */
  async showPaused(): Promise<void> {
    const repo = this.repo ?? (await this.activeRepo());
    if (!repo) return;
    try {
      if (!(await this.rebaseInProgress(repo))) {
        void vscode.window.showInformationMessage('GitGlasses: no rebase is in progress.');
        return;
      }
      this.repo = repo;
      await this.showPausedPanel();
    } catch (error) {
      reportGitError('Rebase', error, this.log);
    }
  }

  private async showPausedPanel(error?: string, reason?: RebasePaused['reason']): Promise<void> {
    this.ensurePanel();
    await this.enterPaused(error, reason);
  }

  private ensurePanel(): void {
    if (this.panel) {
      this.panel.reveal();
      return;
    }
    const distRoot = vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webviews');
    const panel = vscode.window.createWebviewPanel(
      'gitglasses.rebase',
      'Interactive Rebase',
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        // The plan being edited lives in the webview.
        retainContextWhenHidden: true,
        localResourceRoots: [distRoot],
      },
    );
    this.panel = panel;
    this.ready = false;
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
      this.engine.onNotification('repo/didChange', (params) => {
        if (params?.repoId !== this.repo?.repoId || !Array.isArray(params?.changed)) return;
        const kinds: readonly string[] = ['HEAD', 'refs', 'index'];
        if (params.changed.some((kind: string) => kinds.includes(kind))) this.scheduleRecheck();
      }),
    );
  }

  private setInit(init: RebaseInit): void {
    this.init = init;
    void this.post({ type: 'init', ...init });
  }

  private setOverlay(message: HostToWebviewMessage | undefined): void {
    this.overlay = message;
    if (message) void this.post(message);
  }

  private async post(message: HostToWebviewMessage): Promise<void> {
    if (!this.ready) return;
    await this.panel?.webview.postMessage(message);
  }

  private async onMessage(message: WebviewToHostMessage): Promise<void> {
    switch (message.type) {
      case 'ready':
        this.ready = true;
        if (this.init) await this.post({ type: 'init', ...this.init });
        if (this.overlay) await this.post(this.overlay);
        break;
      case 'cancel':
        this.panel?.dispose();
        break;
      case 'start':
        await this.startRebase(message.plan);
        break;
      case 'reload':
        await this.reload();
        break;
      case 'continue':
      case 'skip':
      case 'abort':
        await this.resume(message.type);
        break;
      case 'openFile':
        if (this.repo) {
          const root = vscode.Uri.file(this.repo.workspacePath ?? this.repo.rootPath);
          await vscode.window.showTextDocument(vscode.Uri.joinPath(root, message.path), {
            preview: false,
          });
        }
        break;
      case 'markResolved':
        await this.markResolved(message.path);
        break;
      case 'showChanges':
        await vscode.commands.executeCommand('workbench.view.scm');
        break;
      case 'fetchMessage':
        await this.sendMessageOf(message.sha);
        break;
    }
  }

  // Stages a conflicted file the user has resolved, as `git add` would.
  private async markResolved(path: string): Promise<void> {
    if (!this.repo) return;
    try {
      await this.engine.request('stage/files', {
        repoId: this.repo.repoId,
        paths: [path],
        action: 'stage',
      });
    } catch (error) {
      reportGitError(`Mark ${path} resolved`, error, this.log);
    }
    await this.enterPaused();
  }

  // A reword starts from the commit's whole message, body included.
  private async sendMessageOf(sha: string): Promise<void> {
    if (!this.repo) return;
    try {
      const details = await this.engine.request('commit/details', {
        repoId: this.repo.repoId,
        sha,
      });
      const message = details.body ? `${details.subject}\n\n${details.body}` : details.subject;
      await this.post({ type: 'message', sha, message });
    } catch (error) {
      this.log(`cannot read the message of ${sha}: ${errorMessage(error)}`);
    }
  }

  private scheduleRecheck(): void {
    // The host's own rebase moves HEAD on every step.
    if (this.running) return;
    if (this.recheckTimer !== undefined) clearTimeout(this.recheckTimer);
    this.recheckTimer = setTimeout(() => {
      this.recheckTimer = undefined;
      void this.recheck().catch((error) =>
        this.log(`rebase editor refresh failed: ${errorMessage(error)}`),
      );
    }, RECHECK_DELAY_MS);
  }

  // Keeps the panel honest about the repository: a paused rebase follows the
  // conflicts as they are resolved (or the rebase finishing elsewhere), and a
  // plan being edited is flagged once the branch or upstream moves.
  private async recheck(): Promise<void> {
    const repo = this.repo;
    if (!repo || !this.panel || this.running) return;
    const inProgress = await this.rebaseInProgress(repo);
    if (this.overlay?.type === 'paused') {
      if (inProgress) {
        await this.enterPaused();
      } else {
        void vscode.window.showInformationMessage('GitGlasses: the rebase is no longer in progress.');
        this.panel.dispose();
      }
      return;
    }
    if (inProgress) {
      await this.enterPaused();
      return;
    }
    const session = this.session;
    if (!session) return;
    const preview = await this.engine.request('rebase/preview', {
      repoId: repo.repoId,
      upstream: session.upstream,
    });
    const reason = staleReason(session, preview);
    if (reason) this.setOverlay({ type: 'stale', reason });
  }

  private async reload(): Promise<void> {
    const repo = this.repo;
    const session = this.session;
    if (!repo || !session) return;
    try {
      const status = await this.engine.request('status/summary', { repoId: repo.repoId });
      if (isDirty(status) && !session.autoStash) {
        if (!(await this.askAutoStash(status))) return;
        session.autoStash = true;
      }
      const preview = await this.engine.request('rebase/preview', {
        repoId: repo.repoId,
        upstream: session.upstream,
      });
      session.headSha = preview.headSha;
      session.upstreamSha = preview.upstreamSha;
      session.branch = status.branch || 'HEAD';
      this.overlay = undefined;
      this.setInit({
        upstream: session.upstream,
        branch: session.branch,
        entries: preview.entries,
        mergeCount: preview.mergeCount,
        autoStash: session.autoStash,
        keepPlan: true,
      });
    } catch (error) {
      this.setOverlay({ type: 'error', message: errorMessage(error) });
    }
  }

  private async startRebase(plan: RebaseEntry[]): Promise<void> {
    const repo = this.repo;
    const session = this.session;
    if (this.running || !repo || !session) return;
    try {
      const status = await this.engine.request('status/summary', { repoId: repo.repoId });
      if (isDirty(status) && !session.autoStash) {
        if (!(await this.askAutoStash(status))) return;
        session.autoStash = true;
      }
    } catch (error) {
      this.log(`status before rebase failed: ${errorMessage(error)}`);
    }
    if (!(await confirmDestructive(confirmRebase(session.branch, session.upstream)))) return;

    await this.run(() =>
      this.engine.request('rebase/start', {
        repoId: repo.repoId,
        upstream: session.upstream,
        plan,
        expectedHead: session.headSha,
        expectedUpstream: session.upstreamSha,
        autoStash: session.autoStash || undefined,
      }),
    );
  }

  /** Continues, skips or aborts the rebase in progress in the active (or
   *  shown) repository. */
  async resume(action: ResumeAction): Promise<void> {
    if (!this.available() || this.running) return;
    const repo = this.repo ?? (await this.activeRepo());
    if (!repo) return;
    try {
      if (!(await this.rebaseInProgress(repo))) {
        void vscode.window.showInformationMessage('GitGlasses: no rebase is in progress.');
        return;
      }
    } catch (error) {
      reportGitError('Rebase', error, this.log);
      return;
    }
    this.repo = repo;
    if (action === 'abort') {
      const choice = await vscode.window.showWarningMessage(
        'Abort the rebase?',
        {
          modal: true,
          detail:
            'git rebase --abort\n\nThe branch returns to where it was before the rebase started; conflict resolutions made so far are discarded.',
        },
        'Abort Rebase',
      );
      if (choice !== 'Abort Rebase') return;
      this.running = true;
      await this.post({ type: 'busy', busy: true });
      try {
        await this.engine.request('rebase/abort', { repoId: repo.repoId });
        setStatus('Rebase aborted');
        this.panel?.dispose();
      } catch (error) {
        reportGitError('Abort rebase', error, this.log);
      } finally {
        this.running = false;
        await this.post({ type: 'busy', busy: false });
        this.emitter.fire();
      }
      return;
    }
    await this.run(() => this.engine.request(`rebase/${action}`, { repoId: repo.repoId }));
  }

  // Runs one rebase step and shows where it left the repository.
  private async run(step: () => Promise<{ completed: boolean; conflicts: boolean }>): Promise<void> {
    this.running = true;
    await this.post({ type: 'busy', busy: true });
    try {
      const result = await step();
      this.running = false;
      if (result.completed) {
        void vscode.window.showInformationMessage('GitGlasses: rebase completed.');
        this.panel?.dispose();
      } else {
        await this.showPausedPanel(undefined, result.conflicts ? 'conflicts' : 'stopped');
      }
    } catch (error) {
      this.running = false;
      await this.settleError(error);
    } finally {
      this.running = false;
      await this.post({ type: 'busy', busy: false });
      this.emitter.fire();
    }
  }

  // A failure that left the rebase under way is a paused rebase with git's
  // explanation; any other one leaves the plan open with it.
  private async settleError(error: unknown): Promise<void> {
    const message = errorMessage(error);
    this.log(`rebase failed: ${message}`);
    const inProgress = this.repo
      ? await this.rebaseInProgress(this.repo).catch(() => false)
      : false;
    if (inProgress) {
      await this.showPausedPanel(message);
      return;
    }
    if (!this.panel || !this.init) {
      reportGitError('Rebase', error, this.log);
      return;
    }
    this.setOverlay({ type: 'error', message });
    if (!this.panel.visible) reportGitError('Rebase', error, this.log);
  }

  // `reason` defaults to what the paused state already says, so resolving
  // the last conflict does not turn it into a different kind of stop.
  private async enterPaused(error?: string, reason?: RebasePaused['reason']): Promise<void> {
    const repo = this.repo;
    if (!repo) return;
    const [state, status] = await Promise.all([
      this.engine.request('repo/state', { repoId: repo.repoId }),
      this.engine.request('status/summary', { repoId: repo.repoId }),
    ]);
    const previous = this.overlay?.type === 'paused' ? this.overlay : undefined;
    const paused: RebasePaused = {
      step: state.sequencer.step,
      total: state.sequencer.total,
      reason:
        reason ??
        (status.conflicted.length > 0 ? 'conflicts' : previous?.reason),
      conflicted: [...status.conflicted],
      error: error ?? previous?.error,
    };
    this.setOverlay({ type: 'paused', ...paused });
  }

  private onPanelDisposed(): void {
    for (const disposable of this.panelDisposables) disposable.dispose();
    this.panelDisposables = [];
    if (this.recheckTimer !== undefined) clearTimeout(this.recheckTimer);
    this.recheckTimer = undefined;
    this.panel = undefined;
    this.ready = false;
    this.init = undefined;
    this.overlay = undefined;
    this.session = undefined;
    this.repo = undefined;
  }

  dispose(): void {
    this.panel?.dispose();
    this.onPanelDisposed();
    this.emitter.dispose();
  }
}

// Status bar item and when-clause context for a rebase that is under way in
// the active repository, wherever it was started, so it can be continued,
// skipped or aborted after the editor is closed.
class RebaseStatus implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly engine: EngineClient,
    private readonly repos: RepositoryService,
    host: RebaseWebviewHost,
  ) {
    this.item.command = 'gitglasses.rebase.show';
    this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    this.disposables.push(
      this.item,
      engine.onDidChangeCapabilities(() => this.schedule()),
      engine.onNotification('repo/didChange', (params) => {
        if (!Array.isArray(params?.changed)) return;
        const kinds: readonly string[] = ['HEAD', 'refs', 'index'];
        if (params.changed.some((kind: string) => kinds.includes(kind))) this.schedule();
      }),
      host.onDidChangeState(() => this.schedule()),
    );
    this.schedule();
  }

  schedule(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.refresh();
    }, RECHECK_DELAY_MS);
  }

  private async refresh(): Promise<void> {
    let sequencer: { operation: string; step?: number; total?: number } | undefined;
    try {
      const repo = await activeWorkspaceRepo(this.repos);
      if (repo) ({ sequencer } = await this.engine.request('repo/state', { repoId: repo.repoId }));
    } catch {
      // Engine down or restarting: show nothing rather than a stale state.
      sequencer = undefined;
    }
    const rebasing = sequencer?.operation === 'rebase';
    void vscode.commands.executeCommand('setContext', 'gitglasses.rebaseInProgress', rebasing);
    if (!rebasing) {
      this.item.hide();
      return;
    }
    const progress =
      sequencer?.step !== undefined && sequencer.total !== undefined
        ? ` ${sequencer.step}/${sequencer.total}`
        : '';
    this.item.text = `$(debug-pause) Rebasing${progress}`;
    this.item.tooltip = 'A rebase is paused. Click to continue, skip or abort it.';
    this.item.show();
  }

  dispose(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    for (const disposable of this.disposables.splice(0)) disposable.dispose();
  }
}

/** Registers the interactive-rebase commands; the host lazily creates its
 *  panel. The returned host is also the entry point for the graph action. */
export function registerRebaseWebview(
  context: vscode.ExtensionContext,
  engine: EngineClient,
  repos: RepositoryService,
  log: LogFn,
): { host: RebaseWebviewHost; disposables: vscode.Disposable[] } {
  const host = new RebaseWebviewHost(context, engine, repos, log);
  return {
    host,
    disposables: [
      host,
      new RebaseStatus(engine, repos, host),
      vscode.commands.registerCommand('gitglasses.interactiveRebase', () => host.open()),
      vscode.commands.registerCommand('gitglasses.rebase.show', () => host.showPaused()),
      vscode.commands.registerCommand('gitglasses.rebase.continue', () => host.resume('continue')),
      vscode.commands.registerCommand('gitglasses.rebase.skip', () => host.resume('skip')),
      vscode.commands.registerCommand('gitglasses.rebase.abort', () => host.resume('abort')),
    ],
  };
}
