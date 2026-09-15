import * as vscode from 'vscode';
import { CommitSummaryInfo } from '@gitglasses/protocol';
import { EngineClient } from '@gitglasses/rpc';
import { RepositoryService } from '../model/repositoryService';
import { ActiveRepo, discoverWorkspaceRepos } from '../model/activeRepo';
import { errorMessage } from '../commands/ui';
import { DiffSpec } from './viewLogic';

export type { ActiveRepo };

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
export async function requireRepo(
  repos: RepositoryService,
): Promise<ActiveRepo | undefined> {
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

type ViewState = 'ready' | 'noRepository' | 'engineUnavailable';

let lastViewState: ViewState | undefined;

/** Publishes the workspace-wide view state as when-clause context keys, which
 *  select the welcome content an empty view shows. Returns no nodes so the
 *  welcome content is what the user sees. */
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
  }
  return [];
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

  // An empty result is what makes VS Code show the view's welcome content, so
  // the "no repository" and "engine unavailable" states return no nodes and
  // set the context keys the viewsWelcome entries are keyed on.
  async getChildren(node?: ViewNode): Promise<ViewNode[]> {
    if (node) return node.children ? ((await node.children()) ?? []) : [];

    let repo: ActiveRepo | undefined;
    try {
      repo = await activeWorkspaceRepo(this.repos);
    } catch {
      return setViewState('engineUnavailable');
    }
    if (!repo) {
      // Discovery failures swallow errors, so probe the engine to tell
      // "no repository" apart from "engine down".
      try {
        await this.engine.request('repo/list', {});
      } catch {
        return setViewState('engineUnavailable');
      }
      return setViewState('noRepository');
    }
    try {
      const nodes = await this.getRootNodes(repo);
      setViewState('ready');
      return nodes;
    } catch {
      return setViewState('engineUnavailable');
    }
  }

  protected abstract getRootNodes(repo: ActiveRepo): Promise<ViewNode[]>;

  dispose(): void {
    for (const disposable of this.disposables.splice(0)) disposable.dispose();
    this.emitter.dispose();
  }
}
