// Extension-host side of the commit graph webview: a singleton panel that
// streams graph/rows pages to the canvas renderer, keeps them current as the
// repository changes, serves the details pane, find and the branch filter,
// and runs the context-menu actions. The graph follows the active repository
// (Select Repository) and survives engine restarts and window reloads.

import * as vscode from 'vscode';
import type { GraphRow } from '@gitglasses/protocol';
import { shortSha } from '@gitglasses/protocol/sha';
import { EngineClient } from '@gitglasses/rpc';
import { isMethodAvailable } from '../engine/capabilityGate';
import { RepositoryService, repoName } from '../model/repositoryService';
import { ActiveRepo, activeWorkspaceRepo } from '../views/viewBase';
import { errorMessage } from '../commands/ui';
import { graphPageSize } from '../system/settings';
import {
  copyText,
  errorView,
  loadCommitView,
  loadCompareView,
  loadWipView,
  openAllChanges,
  openFileDiff,
} from '../commitDetails/commitViews';
import type {
  DetailsTarget,
  DetailsView,
  GraphViewState,
  HostToWebviewMessage,
  WebviewToHostMessage,
} from '../../webviews-src/graph/ipc';
import { renderWebviewHtml } from './webviewHtml';
import { REF_MANAGEMENT, runRefAction, runRowAction } from './graphActions';
import {
  RefreshKind,
  branchOptions,
  findQueries,
  isStaleCursorError,
  liveFilter,
  maxLanesSetting,
  refreshFor,
  replaceLimit,
} from './graphHostLogic';

/** The panel type, also its serializer's key. */
export const GRAPH_VIEW_TYPE = 'gitglasses.graph';

const REFRESH_DEBOUNCE_MS = 300;
const FIND_LIMIT = 1000;
/** Retries, with doubling delays, of finding the repository for a panel
 *  restored before the engine was ready (about 15 seconds in all). */
const RESOLVE_RETRIES = 5;
const RESOLVE_RETRY_MS = 500;

export interface GraphHostDeps {
  context: vscode.ExtensionContext;
  engine: EngineClient;
  repos: RepositoryService;
  /** Fires when the user picks another repository or the workspace's
   *  repositories change. */
  onDidChangeActiveRepo: vscode.Event<void>;
  /** Fires once repositories are registered again after an engine restart. */
  onDidReload: vscode.Event<void>;
  openRebase(upstream: string): void | Promise<void>;
  log(line: string): void;
}

export class GraphWebviewHost implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private panelDisposables: vscode.Disposable[] = [];
  private readonly disposables: vscode.Disposable[] = [];
  /** The graphed repository. */
  private repo: ActiveRepo | undefined;
  /** Bumped by every reset and refresh; pages and requests of an older one
   *  belong to a snapshot the webview no longer shows. */
  private generation = 0;
  /** Generations issued for the current repository, which actions from the
   *  webview must carry. */
  private generations = new Set<number>();
  /** Full ref names the graph walks; undefined for every branch. */
  private filter: string[] | undefined;
  private loadedRows = 0;
  private hasWip = false;
  /** Row kind of every sha shown for the current repository. */
  private kinds = new Map<string, GraphRow['kind']>();
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private pendingRefresh: RefreshKind = 'none';
  /** The webview's saved state after a reload, applied to the first reset. */
  private restored: GraphViewState | undefined;
  private findSeq = 0;
  private attaching: Promise<void> | undefined;
  private resolveTimer: ReturnType<typeof setTimeout> | undefined;
  private resolveAttempts = 0;

  constructor(private readonly deps: GraphHostDeps) {
    this.disposables.push(
      deps.onDidChangeActiveRepo(() => void this.followActiveRepo(false)),
      deps.onDidReload(() => void this.followActiveRepo(true)),
    );
  }

  /** Opens the graph. The repository is resolved first, so a workspace
   *  without one gets an explanation and no panel. */
  async show(): Promise<void> {
    const repo = await this.resolveRepo(true);
    if (!repo) return;
    if (this.panel) {
      this.panel.reveal();
      if (repo.repoId !== this.repo?.repoId) await this.startRepo(repo);
      return;
    }
    this.repo = repo;
    const distRoot = vscode.Uri.joinPath(this.deps.context.extensionUri, 'dist', 'webviews');
    const panel = vscode.window.createWebviewPanel(
      GRAPH_VIEW_TYPE,
      this.title(),
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        // Rebuilding a hidden graph would refetch every page and lose a deep
        // scroll position, so the webview is kept alive while hidden.
        retainContextWhenHidden: true,
        localResourceRoots: [distRoot],
      },
    );
    this.adopt(panel);
  }

  /** Wires a panel, new or restored after a reload with the webview's saved
   *  state. */
  adopt(panel: vscode.WebviewPanel, restored?: GraphViewState): void {
    if (this.panel && this.panel !== panel) this.panel.dispose();
    this.panel = panel;
    this.restored = restored;
    const distRoot = vscode.Uri.joinPath(this.deps.context.extensionUri, 'dist', 'webviews');
    panel.webview.options = { enableScripts: true, localResourceRoots: [distRoot] };
    panel.iconPath = vscode.Uri.joinPath(this.deps.context.extensionUri, 'media', 'gitglasses.svg');
    panel.title = this.title();
    panel.webview.html = renderWebviewHtml(panel.webview, distRoot, {
      script: 'graph.js',
      style: 'graph.css',
      title: 'Commit Graph',
    });

    this.panelDisposables.push(
      panel.webview.onDidReceiveMessage((message: WebviewToHostMessage) => this.onMessage(message)),
      this.deps.engine.onNotification('repo/didChange', (params) => {
        if (!Array.isArray(params?.changed) || params.repoId !== this.repo?.repoId) return;
        this.scheduleRefresh(refreshFor(params.changed));
      }),
      // A saved edit can make a clean tree dirty without git noticing yet.
      vscode.workspace.onDidSaveTextDocument((document) => {
        if (this.repo && this.deps.repos.locate(document.uri)?.repoId === this.repo.repoId) {
          this.scheduleRefresh('wip');
        }
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('gitglasses.graph.maxLanes')) void this.postSettings();
      }),
      this.deps.engine.onDidChangeCapabilities(() => {
        void this.postSettings();
        if (!this.repo) {
          this.resolveAttempts = 0;
          void this.attachRepo();
        }
      }),
      vscode.window.onDidChangeActiveColorTheme(() => {
        void this.post({ type: 'theme' });
      }),
      panel.onDidDispose(() => this.onPanelDisposed(panel)),
    );
  }

  private title(): string {
    return this.repo
      ? `Commit Graph — ${repoName(this.repo.workspacePath ?? this.repo.rootPath)}`
      : 'Commit Graph';
  }

  private canMutate(): boolean {
    return (
      vscode.workspace.isTrusted &&
      isMethodAvailable(this.deps.engine.capabilities(), 'mutate/merge')
    );
  }

  private maxLanes(): number {
    return maxLanesSetting(vscode.workspace.getConfiguration('gitglasses').get('graph.maxLanes'));
  }

  private async resolveRepo(report: boolean): Promise<ActiveRepo | undefined> {
    let repo: ActiveRepo | undefined;
    try {
      repo = await activeWorkspaceRepo(this.deps.repos);
    } catch (error) {
      this.deps.log(`commit graph: could not resolve the repository: ${errorMessage(error)}`);
      if (report) {
        void vscode.window.showErrorMessage(
          'GitGlasses: cannot show the commit graph — the engine is unavailable.',
        );
      }
      return undefined;
    }
    if (!repo && report) {
      void vscode.window.showWarningMessage(
        'GitGlasses: no git repository in this workspace, so there is no commit graph to show.',
      );
    }
    return repo;
  }

  /** Follows Select Repository, and re-resolves after an engine restart,
   *  which hands out new repository ids. */
  private async followActiveRepo(reloaded: boolean): Promise<void> {
    if (!this.panel) {
      if (reloaded) this.repo = undefined;
      return;
    }
    const repo = await this.resolveRepo(false);
    if (!repo) {
      this.repo = undefined;
      this.resolveAttempts = 0;
      await this.attachRepo();
      return;
    }
    if (reloaded || repo.repoId !== this.repo?.repoId) await this.startRepo(repo);
  }

  private async startRepo(repo: ActiveRepo): Promise<void> {
    // After an engine restart the same repository comes back under a new id
    // and keeps its branch filter; another repository starts unfiltered.
    const same =
      this.repo !== undefined && this.deps.repos.isRootOf(repo.repoId, this.repo.rootPath);
    this.repo = repo;
    this.generations.clear();
    this.kinds.clear();
    if (!same) this.filter = undefined;
    if (this.panel) this.panel.title = this.title();
    await this.reset();
  }

  /** Starts the graph over: a new generation, the first page and the branch
   *  list. */
  private async reset(): Promise<void> {
    const repo = this.repo;
    if (!this.panel || !repo) return;
    const generation = ++this.generation;
    this.generations.add(generation);
    this.loadedRows = 0;
    await this.post({
      type: 'reset',
      generation,
      repoName: repoName(repo.workspacePath ?? repo.rootPath),
      repoRoot: repo.workspacePath ?? repo.rootPath,
      canMutate: this.canMutate(),
      refManagement: REF_MANAGEMENT,
      maxLanes: this.maxLanes(),
      filter: this.filter,
    });
    await Promise.all([this.fetchFirstPage(generation), this.postBranches()]);
  }

  private onPanelDisposed(panel: vscode.WebviewPanel): void {
    if (this.panel !== panel) return;
    if (this.refreshTimer !== undefined) clearTimeout(this.refreshTimer);
    this.refreshTimer = undefined;
    clearTimeout(this.resolveTimer);
    this.pendingRefresh = 'none';
    for (const disposable of this.panelDisposables.splice(0)) disposable.dispose();
    this.panel = undefined;
    // The next show() resolves the repository again.
    this.repo = undefined;
    this.filter = undefined;
    this.kinds.clear();
    this.generations.clear();
  }

  dispose(): void {
    this.panel?.dispose();
    for (const disposable of this.disposables.splice(0)) disposable.dispose();
  }

  private async post(message: HostToWebviewMessage): Promise<void> {
    await this.panel?.webview.postMessage(message);
  }

  private async postSettings(): Promise<void> {
    await this.post({
      type: 'settings',
      maxLanes: this.maxLanes(),
      canMutate: this.canMutate(),
      refManagement: REF_MANAGEMENT,
    });
  }

  private async onMessage(message: WebviewToHostMessage): Promise<void> {
    const repo = this.repo;
    try {
      switch (message.type) {
        case 'ready':
          await this.onReady(message.state);
          break;
        case 'loadMore':
          await this.loadMore(message.generation, message.cursor);
          break;
        case 'refresh':
          await this.replaceRows();
          break;
        case 'selectRepository':
          await vscode.commands.executeCommand('gitglasses.selectRepository');
          break;
        case 'details':
          await this.postDetails(message.requestId, message.target);
          break;
        case 'find':
          await this.find(message.query);
          break;
        case 'setFilter':
          this.filter = message.refs && message.refs.length > 0 ? message.refs : undefined;
          await this.reset();
          break;
        case 'openFile':
          if (repo) {
            await openFileDiff(repo.repoId, repo.workspacePath ?? repo.rootPath, message.target);
          }
          break;
        case 'openChanges':
          if (repo) await openAllChanges(this.deps.engine, repo.repoId, message.target);
          break;
        case 'copy':
          await copyText(message.text, message.label);
          break;
        case 'showCommit':
          // The webview reveals parents itself.
          break;
        case 'action':
          if (!repo || !this.generations.has(message.generation)) return;
          await runRowAction(this.actionContext(repo), message.action, message.shas, this.kinds);
          break;
        case 'refAction':
          if (!repo || !this.generations.has(message.generation)) return;
          await runRefAction(this.actionContext(repo), message.action, message.ref, message.sha);
          break;
      }
    } catch (error) {
      this.deps.log(`commit graph: ${message.type} failed: ${errorMessage(error)}`);
      void vscode.window.showErrorMessage(`GitGlasses: ${errorMessage(error)}`);
    }
  }

  private actionContext(repo: ActiveRepo) {
    return { engine: this.deps.engine, repoId: repo.repoId, openRebase: this.deps.openRebase };
  }

  private async onReady(state: GraphViewState | undefined): Promise<void> {
    if (state) this.restored = state;
    this.resolveAttempts = 0;
    await this.attachRepo();
  }

  /** Finds the repository for a panel that has none yet. A panel restored
   *  with the window can be ready before the engine has started and the
   *  workspace has been scanned, so a miss is retried, and again once the
   *  engine completes its handshake, before the panel says there is none. */
  private async attachRepo(): Promise<void> {
    if (this.attaching) return this.attaching;
    this.attaching = (async () => {
      const repo = this.repo ?? (await this.resolveRepo(false));
      if (!this.panel) return;
      if (!repo) {
        if (this.resolveAttempts < RESOLVE_RETRIES) {
          const delay = RESOLVE_RETRY_MS * 2 ** this.resolveAttempts++;
          clearTimeout(this.resolveTimer);
          this.resolveTimer = setTimeout(() => void this.attachRepo(), delay);
        } else {
          await this.post({ type: 'error', message: 'No git repository in this workspace.' });
        }
        return;
      }
      clearTimeout(this.resolveTimer);
      await this.adoptRepo(repo);
    })().finally(() => {
      this.attaching = undefined;
    });
    return this.attaching;
  }

  private async adoptRepo(repo: ActiveRepo): Promise<void> {
    const saved = this.restored;
    this.restored = undefined;
    this.repo = repo;
    if (this.panel) this.panel.title = this.title();
    // A reloaded graph keeps its branch filter when it shows the same
    // repository again.
    if (saved?.filter && saved.repoRoot && this.deps.repos.isRootOf(repo.repoId, saved.repoRoot)) {
      this.filter = saved.filter;
    }
    await this.reset();
  }

  private request(limit: number, cursor?: string) {
    const repo = this.repo;
    if (!repo) throw new Error('no repository');
    return this.deps.engine.request('graph/rows', {
      repoId: repo.repoId,
      cursor,
      limit,
      include: { stashes: true, wip: true },
      ...(this.filter ? { refs: this.filter } : {}),
    });
  }

  private remember(rows: readonly GraphRow[]): void {
    for (const row of rows) this.kinds.set(row.sha, row.kind);
  }

  private async fetchFirstPage(generation: number): Promise<void> {
    try {
      const result = await this.request(graphPageSize());
      if (generation !== this.generation) return;
      this.remember(result.rows);
      this.loadedRows = result.rows.length;
      this.hasWip = result.rows[0]?.kind === 'wip';
      await this.post({
        type: 'rows',
        generation,
        rows: result.rows,
        nextCursor: result.nextCursor,
        replace: false,
      });
    } catch (error) {
      if (generation !== this.generation) return;
      this.deps.log(`commit graph: loading failed: ${errorMessage(error)}`);
      // The panel shows why it is empty; the next repository change refetches.
      await this.post({
        type: 'error',
        message: `Could not load the commit graph: ${errorMessage(error)}`,
      });
    }
  }

  private async loadMore(generation: number, cursor: string): Promise<void> {
    // A refresh or reset since the request was made: the webview drops the
    // old rows anyway, and a newer snapshot is on its way.
    if (generation !== this.generation) return;
    try {
      const result = await this.request(graphPageSize(), cursor);
      if (generation !== this.generation) return;
      this.remember(result.rows);
      this.loadedRows += result.rows.length;
      await this.post({
        type: 'rows',
        generation,
        rows: result.rows,
        nextCursor: result.nextCursor,
        replace: false,
      });
    } catch (error) {
      if (generation !== this.generation) return;
      if (isStaleCursorError(error)) {
        // The refs moved after the earlier pages were taken.
        await this.replaceRows();
        return;
      }
      this.deps.log(`commit graph: loading more rows failed: ${errorMessage(error)}`);
      void vscode.window.showWarningMessage(
        `GitGlasses: could not load more commits: ${errorMessage(error)}`,
      );
      // Ends paging for this snapshot; Refresh starts it again.
      await this.post({ type: 'rows', generation, rows: [], replace: false });
    }
  }

  /** Reloads every loaded row in one request, so the webview keeps its
   *  scroll position, selection and depth. */
  private async replaceRows(): Promise<void> {
    if (!this.panel || !this.repo) return;
    const generation = ++this.generation;
    this.generations.add(generation);
    try {
      const result = await this.request(replaceLimit(this.loadedRows, graphPageSize()));
      if (generation !== this.generation) return;
      this.remember(result.rows);
      this.loadedRows = result.rows.length;
      this.hasWip = result.rows[0]?.kind === 'wip';
      await this.post({
        type: 'rows',
        generation,
        rows: result.rows,
        nextCursor: result.nextCursor,
        replace: true,
      });
    } catch (error) {
      if (generation !== this.generation) return;
      this.deps.log(`commit graph: refresh failed: ${errorMessage(error)}`);
      await this.post({
        type: 'error',
        message: `Could not load the commit graph: ${errorMessage(error)}`,
      });
    }
  }

  /** After an index-only change: the rows only change when the WIP row came
   *  or went, which shifts lanes, so that alone triggers a refresh. */
  private async checkWip(): Promise<void> {
    if (!this.panel || !this.repo) return;
    try {
      const result = await this.request(1);
      const hasWip = result.rows[0]?.kind === 'wip';
      if (hasWip !== this.hasWip) await this.replaceRows();
      await this.post({ type: 'wipChanged' });
    } catch (error) {
      this.deps.log(
        `commit graph: checking for uncommitted changes failed: ${errorMessage(error)}`,
      );
    }
  }

  private scheduleRefresh(kind: RefreshKind): void {
    if (kind === 'none') return;
    if (kind === 'replace' || this.pendingRefresh === 'none') this.pendingRefresh = kind;
    if (this.refreshTimer !== undefined) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      const pending = this.pendingRefresh;
      this.pendingRefresh = 'none';
      if (pending === 'replace') {
        void this.replaceRows().then(() => this.postBranches());
        void this.post({ type: 'wipChanged' });
      } else if (pending === 'wip') {
        void this.checkWip();
      }
    }, REFRESH_DEBOUNCE_MS);
  }

  /** Sends the branch filter's options, dropping filtered branches that no
   *  longer exist. */
  private async postBranches(): Promise<void> {
    const repo = this.repo;
    if (!repo) return;
    try {
      const refs = await this.deps.engine.request('refs/list', { repoId: repo.repoId });
      if (repo !== this.repo) return;
      const options = branchOptions(refs);
      await this.post({ type: 'branches', branches: options });
      const live = liveFilter(this.filter, options);
      if (this.filter && (live?.length ?? 0) !== this.filter.length) {
        this.filter = live;
        await this.reset();
      }
    } catch (error) {
      this.deps.log(`commit graph: listing branches failed: ${errorMessage(error)}`);
    }
  }

  private async postDetails(requestId: number, target: DetailsTarget): Promise<void> {
    const repo = this.repo;
    if (!repo) return;
    let view: DetailsView;
    try {
      view = await this.loadDetails(repo.repoId, target);
    } catch (error) {
      const what =
        target.kind === 'commit'
          ? `commit ${shortSha(target.sha)}`
          : target.kind === 'compare'
            ? 'the comparison'
            : 'the uncommitted changes';
      view = errorView(what, error);
    }
    await this.post({ type: 'details', requestId, view });
  }

  private async loadDetails(repoId: string, target: DetailsTarget): Promise<DetailsView> {
    const { engine } = this.deps;
    switch (target.kind) {
      case 'wip':
        return loadWipView(engine, repoId);
      case 'compare':
        return loadCompareView(engine, repoId, target.base, target.head);
      case 'commit': {
        if (this.kinds.get(target.sha) !== 'stash')
          return loadCommitView(engine, repoId, target.sha);
        const { entries } = await engine.request('stash/list', { repoId });
        const index = entries.find((entry) => entry.sha === target.sha)?.index;
        return loadCommitView(engine, repoId, target.sha, index);
      }
    }
  }

  /** Searches HEAD's history for the find box: message, author and sha
   *  matches, joined. Loaded rows on other branches match in the webview. */
  private async find(query: string): Promise<void> {
    const repo = this.repo;
    const seq = ++this.findSeq;
    if (!repo) return;
    const queries = findQueries(query);
    let truncated = false;
    const shas = new Set<string>();
    await Promise.all(
      queries.map(async (search, i) => {
        const streamId = `graph-find-${seq}-${i}`;
        const sub = this.deps.engine.onNotification('search/matches', (params) => {
          if (params.streamId !== streamId) return;
          for (const match of params.matches) shas.add(match.sha);
        });
        try {
          const result = await this.deps.engine.request('search/commits', {
            repoId: repo.repoId,
            streamId,
            limit: FIND_LIMIT,
            query: search,
          });
          truncated ||= result.truncated;
        } catch (error) {
          this.deps.log(`commit graph: find failed: ${errorMessage(error)}`);
        } finally {
          sub.dispose();
        }
      }),
    );
    if (seq !== this.findSeq) return;
    await this.post({ type: 'findResults', query, shas: [...shas], truncated });
  }
}

/** Registers the show-graph command and the serializer that brings an open
 *  graph back after a reload; the host creates its panel lazily. */
export function registerGraphWebview(deps: GraphHostDeps): vscode.Disposable[] {
  const host = new GraphWebviewHost(deps);
  return [
    host,
    vscode.commands.registerCommand('gitglasses.showGraph', () => host.show()),
    vscode.window.registerWebviewPanelSerializer(GRAPH_VIEW_TYPE, {
      deserializeWebviewPanel: async (panel, state: unknown) => {
        host.adopt(panel, (state ?? undefined) as GraphViewState | undefined);
      },
    }),
  ];
}
