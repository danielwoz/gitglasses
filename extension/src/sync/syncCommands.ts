// Push, pull and fetch as the user runs them from Home and the Git Commands
// palette: a progress notification with Cancel (which stops the engine's
// git), publishing a new branch to the remote git's config names or one the
// user picks, a choice of merge or rebase when a pull finds the branches
// diverged, and failures explained with the next step to take. Also the
// commands that continue, skip or abort an operation stopped half-way.

import * as vscode from 'vscode';
import type { CancellationLike, EngineClient } from '@gitglasses/rpc';
import type { SequencerOperation } from '@gitglasses/protocol';
import { ActiveRepo, activeWorkspaceRepo, requireRepo } from '../views/viewBase';
import type { RepositoryService } from '../model/repositoryService';
import {
  ABORT_OPERATION_COMMAND,
  CONTINUE_OPERATION_COMMAND,
  OPEN_CONFLICTS_COMMAND,
  SKIP_OPERATION_COMMAND,
  setStatus,
  showConflictGuidance,
} from '../commands/ui';
import {
  type FailureAction,
  type PullChoice,
  describeFailure,
  divergedPullChoices,
  gitErrorData,
  gitMessage,
  operationLabel,
} from './syncLogic';

/** What the sync flows need from the host. */
export interface SyncHost {
  log(line: string): void;
  showLog(): void;
  /** Integration answers to credential prompts, for the retry that asks the
   *  user instead when git refused a stored token. */
  askpass?: {
    answeredFromIntegrationSince(host: string, since: number): boolean;
    refuseIntegrationFor(host: string): void;
  };
}

let host: SyncHost = { log: () => undefined, showLog: () => undefined };

/** Installs the host's logging and prompt service (the extension does this
 *  at activation). */
export function configureSync(next: SyncHost): void {
  host = next;
}

type Repo = ActiveRepo;

/** Runs `run` under a notification with a Cancel button; cancelling stops
 *  the engine's git. */
function withProgress<T>(title: string, run: (token: CancellationLike) => Promise<T>): Thenable<T> {
  return vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `GitGlasses: ${title}`,
      cancellable: true,
    },
    (_progress, token) => run(token),
  );
}

function cancelledByUser(error: unknown): boolean {
  return (error as { code?: unknown } | undefined)?.code === -32800;
}

/**
 * Reports a failed action with the next steps that fit it. `retry` re-runs
 * the action. When a credential prompt was answered from an integration and
 * the remote refused it, the action is retried once asking the user instead.
 */
export async function reportFailure(
  label: string,
  error: unknown,
  context: { retry?: () => Promise<unknown>; started?: number } = {},
): Promise<void> {
  if (cancelledByUser(error)) {
    setStatus(`${label} cancelled`);
    return;
  }
  host.log(`${label} failed: ${error instanceof Error ? error.message : String(error)}`);
  const data = gitErrorData(error);
  if (
    data?.kind === 'auth' &&
    data.host &&
    context.retry &&
    context.started !== undefined &&
    host.askpass?.answeredFromIntegrationSince(data.host, context.started)
  ) {
    host.log(`${data.host} refused the integration's token for git; asking for credentials`);
    host.askpass.refuseIntegrationFor(data.host);
    await context.retry();
    return;
  }
  const presentation = describeFailure(label, error, { canRetry: context.retry !== undefined });
  if (presentation.silent) {
    setStatus(presentation.message.replace(/\.$/, ''));
    return;
  }
  const choice = await vscode.window.showErrorMessage(
    `GitGlasses: ${presentation.message}`,
    ...presentation.actions.map((action) => action.label),
  );
  const action = presentation.actions.find((candidate) => candidate.label === choice)?.action;
  if (action) await runFailureAction(action, context.retry);
}

// The next steps run as commands on the active repository, which is the one
// the failed action ran on.
const FAILURE_COMMANDS: Partial<Record<FailureAction, string>> = {
  pull: 'gitglasses.home.pull',
  // Push publishes a branch that tracks nothing.
  publish: 'gitglasses.home.push',
  continue: CONTINUE_OPERATION_COMMAND,
  skip: SKIP_OPERATION_COMMAND,
  abort: ABORT_OPERATION_COMMAND,
  openConflicts: OPEN_CONFLICTS_COMMAND,
};

async function runFailureAction(
  action: FailureAction,
  retry: (() => Promise<unknown>) | undefined,
): Promise<void> {
  if (action === 'retry') {
    await retry?.();
    return;
  }
  if (action === 'showLog') {
    host.showLog();
    return;
  }
  const command = FAILURE_COMMANDS[action];
  if (command) await vscode.commands.executeCommand(command);
}

/** Pushes the current branch, publishing it first when it tracks nothing. */
export async function push(engine: EngineClient, repo: Repo): Promise<void> {
  const status = await engine.request('status/summary', { repoId: repo.repoId });
  if (!status.upstream) {
    await publish(engine, repo, status.branch);
    return;
  }
  const started = Date.now();
  try {
    await withProgress(`Pushing '${status.branch}'…`, (token) =>
      engine.request('mutate/push', { repoId: repo.repoId }, token),
    );
    setStatus(`Pushed '${status.branch}'`);
  } catch (error) {
    await reportFailure('Push', error, { started, retry: () => push(engine, repo) });
  }
}

/** Publishes the current branch to `remote`, or to the remote git's config
 *  names for it; with several remotes and none configured, the user picks. */
export async function publish(
  engine: EngineClient,
  repo: Repo,
  branch?: string,
  remote?: string,
): Promise<void> {
  const name = branch ?? (await engine.request('status/summary', { repoId: repo.repoId })).branch;
  const started = Date.now();
  try {
    const result = await withProgress(`Publishing '${name}'…`, (token) =>
      engine.request('mutate/push', { repoId: repo.repoId, setUpstream: true, remote }, token),
    );
    setStatus(`Published '${name}' to '${result.remote ?? remote ?? 'its remote'}'`);
  } catch (error) {
    const data = gitErrorData(error);
    if (data?.kind === 'noRemote' && (data.remotes?.length ?? 0) > 1) {
      const picked = await pickRemote(engine, repo, data.remotes ?? [], name);
      if (picked) await publish(engine, repo, name, picked);
      return;
    }
    await reportFailure('Publish', error, {
      started,
      retry: () => publish(engine, repo, name, remote),
    });
  }
}

async function pickRemote(
  engine: EngineClient,
  repo: Repo,
  remotes: readonly string[],
  branch: string,
): Promise<string | undefined> {
  let urls = new Map<string, string>();
  try {
    const listed = await engine.request('remote/list', { repoId: repo.repoId });
    urls = new Map(listed.remotes.map((r) => [r.name, r.pushUrl ?? r.fetchUrl]));
  } catch {
    // The names alone still make a usable list.
  }
  const picked = await vscode.window.showQuickPick(
    remotes.map((name) => ({ label: name, description: urls.get(name) })),
    {
      title: `GitGlasses: Publish '${branch}'`,
      placeHolder: 'Several remotes are configured and none is the default. Publish to which?',
      ignoreFocusOut: true,
    },
  );
  return picked?.label;
}

/** Pulls into the current branch. When the branches diverged and no
 *  strategy is configured, the user chooses merge or rebase. */
export async function pull(
  engine: EngineClient,
  repo: Repo,
  choice:
    Pick<PullChoice, 'strategy' | 'remember'> | { strategy?: undefined; remember?: false } = {},
): Promise<void> {
  const started = Date.now();
  try {
    const { conflicts } = await withProgress('Pulling…', (token) =>
      engine.request(
        'mutate/pull',
        {
          repoId: repo.repoId,
          autoStash: true,
          ...(choice.strategy ? { strategy: choice.strategy } : {}),
          ...(choice.remember ? { remember: true } : {}),
        },
        token,
      ),
    );
    if (conflicts) showConflictGuidance('Pull');
    else setStatus(choice.remember ? `Pulled (${choice.strategy} from now on)` : 'Pulled');
  } catch (error) {
    const data = gitErrorData(error);
    if (data?.kind === 'divergent' && choice.strategy !== 'merge' && choice.strategy !== 'rebase') {
      const picked = await vscode.window.showQuickPick(divergedPullChoices(), {
        title: 'GitGlasses: Pull',
        placeHolder:
          'Your branch and its remote branch have diverged. How should they be combined?',
        ignoreFocusOut: true,
      });
      if (picked) await pull(engine, repo, picked);
      return;
    }
    await reportFailure('Pull', error, {
      started,
      retry: () => pull(engine, repo, choice),
    });
  }
}

/** Fetches from the remotes git fetches from by default. */
export async function fetch(engine: EngineClient, repo: Repo, prune: boolean): Promise<void> {
  const started = Date.now();
  try {
    await withProgress(prune ? 'Fetching (prune)…' : 'Fetching…', (token) =>
      engine.request('mutate/fetch', { repoId: repo.repoId, prune }, token),
    );
    setStatus(prune ? 'Fetched (pruned)' : 'Fetched');
  } catch (error) {
    await reportFailure('Fetch', error, {
      started,
      retry: () => fetch(engine, repo, prune),
    });
  }
}

/** Continues, skips or aborts the operation the repository is stopped in. */
export async function runSequencer(
  engine: EngineClient,
  repo: Repo,
  action: 'continue' | 'skip' | 'abort',
): Promise<void> {
  let operation: SequencerOperation = 'none';
  try {
    ({
      sequencer: { operation },
    } = await engine.request('repo/state', { repoId: repo.repoId }));
  } catch {
    // The engine answers with its own error below.
  }
  const label = operationLabel(operation) ?? 'Operation';
  if (operation === 'none') {
    void vscode.window.showInformationMessage(
      'GitGlasses: no merge, rebase, cherry-pick or revert is in progress.',
    );
    return;
  }
  const verb = action === 'continue' ? 'Continuing' : action === 'skip' ? 'Skipping' : 'Aborting';
  try {
    const result = await withProgress(`${verb} ${label.toLowerCase()}…`, (token) =>
      engine.request('mutate/sequencer', { repoId: repo.repoId, action }, token),
    );
    if (result.conflicts) showConflictGuidance(label);
    else if (action === 'abort') setStatus(`${label} aborted`);
    else if (result.completed) setStatus(`${label} completed`);
    else setStatus(`${label} continued`);
  } catch (error) {
    await reportFailure(label, error);
  }
}

/** Opens the conflicted files in editors, where they can be resolved. */
export async function openConflicts(engine: EngineClient, repo: Repo): Promise<void> {
  const OPEN_LIMIT = 10;
  const { conflicted } = await engine.request('status/summary', { repoId: repo.repoId });
  if (conflicted.length === 0) {
    void vscode.window.showInformationMessage('GitGlasses: no files are conflicted.');
    return;
  }
  // Working-tree URIs use the editor's spelling of the root.
  const root = repo.workspacePath ?? repo.rootPath;
  for (const file of conflicted.slice(0, OPEN_LIMIT)) {
    await vscode.commands.executeCommand(
      'vscode.open',
      vscode.Uri.joinPath(vscode.Uri.file(root), file),
      { preview: false },
    );
  }
  if (conflicted.length > OPEN_LIMIT) {
    void vscode.window.showInformationMessage(
      `GitGlasses: opened ${OPEN_LIMIT} of ${conflicted.length} conflicted files; the rest are in Source Control.`,
    );
  }
}

/** Keeps the gitglasses.operationInProgress context key, which shows the
 *  continue and abort commands, in step with the active repository. */
class OperationState implements vscode.Disposable {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly engine: EngineClient,
    private readonly repos: RepositoryService,
  ) {
    this.disposables.push(
      engine.onDidChangeCapabilities(() => this.schedule()),
      engine.onNotification('repo/didChange', (params) => {
        if (!Array.isArray(params?.changed)) return;
        if (params.changed.some((kind: string) => kind === 'sequencer' || kind === 'HEAD')) {
          this.schedule();
        }
      }),
    );
  }

  schedule(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.refresh();
    }, 300);
  }

  private async refresh(): Promise<void> {
    let inProgress = false;
    try {
      const repo = await activeWorkspaceRepo(this.repos);
      if (repo) {
        const { sequencer } = await this.engine.request('repo/state', { repoId: repo.repoId });
        inProgress = sequencer.operation !== 'none';
      }
    } catch (error) {
      host.log(`could not read the repository's operation state: ${gitMessage(error)}`);
    }
    void vscode.commands.executeCommand('setContext', 'gitglasses.operationInProgress', inProgress);
  }

  dispose(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    for (const disposable of this.disposables.splice(0)) disposable.dispose();
  }
}

/** The continue/skip/abort and open-conflicts commands the conflict and
 *  failure notifications offer. */
export function registerSyncCommands(
  engine: EngineClient,
  repos: RepositoryService,
): vscode.Disposable[] {
  const onRepo = (run: (repo: ActiveRepo) => Promise<void>) => async (): Promise<void> => {
    const repo = await requireRepo(repos);
    if (repo) await run(repo);
  };
  const state = new OperationState(engine, repos);
  state.schedule();
  return [
    state,
    vscode.commands.registerCommand(
      CONTINUE_OPERATION_COMMAND,
      onRepo((repo) => runSequencer(engine, repo, 'continue')),
    ),
    vscode.commands.registerCommand(
      ABORT_OPERATION_COMMAND,
      onRepo((repo) => runSequencer(engine, repo, 'abort')),
    ),
    vscode.commands.registerCommand(
      SKIP_OPERATION_COMMAND,
      onRepo((repo) => runSequencer(engine, repo, 'skip')),
    ),
    vscode.commands.registerCommand(
      OPEN_CONFLICTS_COMMAND,
      onRepo((repo) => openConflicts(engine, repo)),
    ),
  ];
}
