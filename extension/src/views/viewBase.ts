import * as vscode from 'vscode';
import { CommitSummaryInfo, ErrorCodes } from '@gitglasses/protocol';
import { EngineClient, EngineError } from '@gitglasses/rpc';
import { RepositoryService } from '../model/repositoryService';
import { ActiveRepo, discoverWorkspaceRepos } from '../model/activeRepo';
import { errorMessage } from '../commands/ui';
import { DiffSpec } from './viewLogic';
import { StateHost, ViewFailure, ViewState, failureLines, stateLines } from './viewStateContent';

export type { ActiveRepo, ViewState };

type ActiveRepoResolver = () => Promise<ActiveRepo | undefined>;

let resolveActive: ActiveRepoResolver | undefined;

/** Installs the workspace's active-repo selection (core does this at startup);
 *  without one, the first workspace folder that is a repository is used. */
export function setActiveRepoResolver(resolver: ActiveRepoResolver | undefined): void {
  resolveActive = resolver;
}

/** The repository the repo-scoped commands and views act on. */
export async function activeWorkspaceRepo(
  repos: RepositoryService,
): Promise<ActiveRepo | undefined> {
  if (resolveActive) return resolveActive();
  return (await discoverWorkspaceRepos(repos))[0];
}

/** Resolves the active repo, reporting when there is none. */
export async function requireRepo(repos: RepositoryService): Promise<ActiveRepo | undefined> {
  let repo: ActiveRepo | undefined;
  try {
    repo = await activeWorkspaceRepo(repos);
  } catch {
    repo = undefined;
  }
  if (!repo) {
    void vscode.window.showWarningMessage('GitGlasses: no git repository in this workspace.');
  }
  return repo;
}

/** Runs `action` against the workspace repo, reporting a missing repo and
 *  surfacing a failure as "<label> failed". */
export async function withRepo(
  repos: RepositoryService,
  label: string,
  action: (repo: ActiveRepo) => Promise<void>,
): Promise<void> {
  const repo = await requireRepo(repos);
  if (!repo) return;
  try {
    await action(repo);
  } catch (error) {
    void vscode.window.showErrorMessage(`GitGlasses: ${label} failed: ${errorMessage(error)}`);
  }
}

let lastViewState: ViewState | undefined;
const viewStateChanged = new vscode.EventEmitter<ViewState>();

/** Fires when the workspace-wide view state changes. */
export const onDidChangeViewState = viewStateChanged.event;

/** The workspace-wide view state, undefined until a view first resolved it. */
export function currentViewState(): ViewState | undefined {
  return lastViewState;
}

/** Publishes the workspace-wide view state, also as when-clause context keys
 *  for menus. Returns no nodes: the view shows the state's own lines instead
 *  (see ViewWithStates). */
export function setViewState(state: ViewState): ViewNode[] {
  if (state !== lastViewState) {
    lastViewState = state;
    void vscode.commands.executeCommand(
      'setContext',
      'gitglasses.noRepository',
      state === 'noRepository',
    );
    void vscode.commands.executeCommand(
      'setContext',
      'gitglasses.engineUnavailable',
      state === 'engineUnavailable',
    );
    viewStateChanged.fire(state);
  }
  return [];
}

/** How long a view's first render waits for the engine's handshake before
 *  it reports the engine as unavailable. */
const ENGINE_START_GRACE_MS = 20_000;

/** Resolves true once the engine has completed a handshake, so a view
 *  rendered while the extension is still starting waits (with the view's
 *  progress bar) instead of reporting a dead engine. */
function engineStarted(engine: EngineClient): Promise<boolean> {
  if (engine.capabilities() !== undefined) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      subscription.dispose();
      resolve(false);
    }, ENGINE_START_GRACE_MS);
    const subscription = engine.onDidChangeCapabilities(() => {
      clearTimeout(timer);
      subscription.dispose();
      resolve(true);
    });
  });
}

/** Tree element: a prebuilt item plus payload the command handlers read. */
export interface ViewNode {
  item: vscode.TreeItem;
  children?: () => vscode.ProviderResult<ViewNode[]>;
  sha?: string;
  commit?: CommitSummaryInfo;
  diff?: DiffSpec;
}

export function messageNode(message: string): ViewNode {
  const item = new vscode.TreeItem(message, vscode.TreeItemCollapsibleState.None);
  item.iconPath = new vscode.ThemeIcon('info');
  item.contextValue = 'gitglassesMessage';
  return { item };
}

export function loadMoreNode(loadMore: () => void): ViewNode {
  const item = new vscode.TreeItem('Load more…', vscode.TreeItemCollapsibleState.None);
  item.iconPath = new vscode.ThemeIcon('ellipsis');
  item.contextValue = 'gitglassesLoadMore';
  item.command = { command: 'gitglasses.loadMore', title: 'Load More', arguments: [loadMore] };
  return { item };
}

// Shared provider skeleton: engine readiness, active-repo resolution, error
// and empty states, and refresh() that also drops any per-view cache.
export abstract class ViewBase implements vscode.TreeDataProvider<ViewNode>, vscode.Disposable {
  private emitter = new vscode.EventEmitter<ViewNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  protected disposables: vscode.Disposable[] = [];
  /** Why the last render of the root failed, if it did. */
  failure: ViewFailure | undefined;
  /** The name failures are logged under: the view id once registered. */
  logName = 'view';

  constructor(
    protected readonly engine: EngineClient,
    protected readonly repos: RepositoryService,
  ) {}

  /** Full reload: drop cached pages/results and re-render. */
  refresh(): void {
    this.invalidate();
    this.emitter.fire(undefined);
  }

  /** Re-render only (cached state kept) — used after appending a page. */
  protected fireChange(): void {
    this.emitter.fire(undefined);
  }

  /** Re-render a single node, leaving the rest of the tree in place. */
  protected fireNode(node: ViewNode): void {
    this.emitter.fire(node);
  }

  /** Overridden by views that cache fetched state. */
  protected invalidate(): void {}

  getTreeItem(node: ViewNode): vscode.TreeItem {
    return node.item;
  }

  // Resolving the repository decides the workspace-wide state (no
  // repository, engine unavailable); a failure of this view's own request
  // is recorded on the view alone, so a method one view cannot use (say, in
  // Restricted Mode) never changes what the other views show. Either way
  // the root is empty and ViewWithStates renders the lines that explain it.
  async getChildren(node?: ViewNode): Promise<ViewNode[]> {
    if (node) return node.children ? ((await node.children()) ?? []) : [];

    this.failure = undefined;
    if (!(await engineStarted(this.engine))) return setViewState('engineUnavailable');
    let repo: ActiveRepo | undefined;
    try {
      repo = await activeWorkspaceRepo(this.repos);
    } catch (error) {
      logViewError(`resolving the repository failed: ${errorMessage(error)}`);
      return setViewState('engineUnavailable');
    }
    if (!repo) {
      // Discovery failures swallow errors, so probe the engine to tell
      // "no repository" apart from "engine down".
      try {
        await this.engine.request('repo/list', {});
      } catch (error) {
        logViewError(`the engine did not answer repo/list: ${errorMessage(error)}`);
        return setViewState('engineUnavailable');
      }
      return setViewState('noRepository');
    }
    setViewState('ready');
    try {
      return await this.getRootNodes(repo);
    } catch (error) {
      this.recordFailure(error);
      return [];
    }
  }

  /** Records and logs why the root could not be listed. */
  protected recordFailure(error: unknown): void {
    this.failure = describeFailure(error);
    this.logFailure(error);
  }

  /** Logs a failed request whose view keeps what it already shows. */
  protected logFailure(error: unknown): void {
    logViewError(`${this.logName}: ${errorMessage(error)}`);
  }

  protected abstract getRootNodes(repo: ActiveRepo): Promise<ViewNode[]>;

  dispose(): void {
    for (const disposable of this.disposables.splice(0)) disposable.dispose();
    this.emitter.dispose();
  }
}

let viewLog: ((line: string) => void) | undefined;

/** Installs the log sink view failures are written to (core does this). */
export function setViewLogger(log: ((line: string) => void) | undefined): void {
  viewLog = log;
}

function logViewError(line: string): void {
  viewLog?.(`views: ${line}`);
}

function describeFailure(error: unknown): ViewFailure {
  return {
    restricted: error instanceof EngineError && error.code === ErrorCodes.Restricted,
    message: errorMessage(error),
  };
}

function stateNode(line: StateLineLike): ViewNode {
  const item = new vscode.TreeItem(line.label, vscode.TreeItemCollapsibleState.None);
  item.iconPath = new vscode.ThemeIcon(line.icon);
  item.description = line.description;
  item.tooltip = line.tooltip;
  if (line.command) {
    item.command = { command: line.command, title: line.label };
    item.contextValue = 'gitglassesStateAction';
  } else {
    item.contextValue = 'gitglassesMessage';
  }
  return { item };
}

type StateLineLike = ReturnType<typeof stateLines>[number];

/**
 * A view's data provider plus what it shows while it has nothing to list:
 * the workspace's state (no repository, engine unavailable) or the view's
 * own empty-state lines, with actions. A view that shows such lines renders
 * again when the workspace's state moves on.
 */
export class ViewWithStates implements vscode.TreeDataProvider<ViewNode>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<ViewNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  /** The state the lines on screen describe; undefined while the view lists
   *  its own nodes. */
  private shown: ViewState | 'initial' | undefined;
  private readonly subscriptions: vscode.Disposable[];

  constructor(
    readonly viewId: string,
    readonly inner: ViewBase,
    private readonly host: () => StateHost,
  ) {
    inner.logName = viewId;
    this.subscriptions = [
      inner.onDidChangeTreeData((node) => this.emitter.fire(node)),
      onDidChangeViewState((state) => {
        if (this.shown !== undefined && this.shown !== state) this.emitter.fire(undefined);
      }),
    ];
  }

  getTreeItem(node: ViewNode): vscode.TreeItem {
    return this.inner.getTreeItem(node);
  }

  async getChildren(node?: ViewNode): Promise<ViewNode[]> {
    const children = await this.inner.getChildren(node);
    if (node || children.length > 0) {
      if (!node) this.shown = undefined;
      return children;
    }
    const failure = this.inner.failure;
    if (failure) {
      this.shown = undefined;
      return failureLines(failure).map(stateNode);
    }
    const state = currentViewState();
    this.shown = state ?? 'initial';
    return stateLines(this.viewId, state, this.host()).map(stateNode);
  }

  dispose(): void {
    for (const subscription of this.subscriptions.splice(0)) subscription.dispose();
    this.emitter.dispose();
  }
}
