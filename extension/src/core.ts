// Platform-independent half of activation. extension.ts (node host) and
// web/extensionWeb.ts (wasm host) each build their own transport, repository
// service and document sync, then hand them here. Everything that touches only
// the engine, the repositories and the views is registered in this module, so a
// command added once is registered on both hosts.

import * as vscode from 'vscode';
import { EngineClient } from '@gitglasses/rpc';
import { shortSha } from '@gitglasses/protocol/sha';
import { BlameModel } from './model/blameModel';
import { RepositoryService, repoName } from './model/repositoryService';
import { ActiveRepoManager } from './model/activeRepo';
import { RefsModel } from './model/refsModel';
import { ConflictWatcher } from './model/conflictWatcher';
import { LineBlameController } from './annotations/lineBlame';
import { FileAnnotationsController } from './annotations/fileAnnotations';
import { BlameHoverProvider } from './annotations/hoverProvider';
import { BlameCodeLensProvider } from './codelens/blameCodeLens';
import {
  RevisionContentProvider,
  encodeRevisionUri,
} from './scm/revisionContentProvider';
import { GitGlassesQuickDiffProvider } from './scm/quickDiffProvider';
import { ViewBase, ViewNode, setActiveRepoResolver } from './views/viewBase';
import { CommitsViewProvider } from './views/commitsView';
import {
  BranchesViewProvider,
  RemotesViewProvider,
  StashesViewProvider,
  TagsViewProvider,
} from './views/refsViews';
import { FileHistoryViewProvider } from './views/fileHistoryView';
import { ContributorsViewProvider } from './views/contributorsView';
import { SearchViewProvider } from './views/searchView';
import { openCommitDiff } from './views/nodes';
import { commitDescription } from './views/viewLogic';
import { ShaTerminalLinkProvider } from './terminal/linkProvider';
import { RepoGroupsManager } from './groups/repoGroups';
import { registerGraphWebview } from './webviews/graphHost';
import { registerRebaseWebview } from './webviews/rebaseHost';
import { registerTimelineWebview } from './webviews/timelineHost';
import { registerGitPalette } from './commands/gitPalette';
import { WorktreesViewProvider, registerWorktreeCommands } from './views/worktreesView';
import { AuthManager } from './integrations/auth';
import { IntegrationService } from './integrations/integrationService';
import { LaunchpadService } from './integrations/launchpadService';
import { PrChipProvider } from './integrations/prChips';
import { registerStartWork } from './integrations/startWork';
import { registerLaunchpad } from './views/launchpadView';
import { registerAiFeatures } from './ai/features';
import { HomeViewProvider, registerHomeCommands } from './home/homeView';
import { ModeController } from './modes/modeController';
import { registerSuggestChange } from './reviews/suggestCommands';

/** Views whose contents follow HEAD and the ref graph. */
export const HISTORY_VIEWS = [
  'gitglasses.views.commits',
  'gitglasses.views.branches',
  'gitglasses.views.remotes',
  'gitglasses.views.tags',
  'gitglasses.views.fileHistory',
  'gitglasses.views.contributors',
];

const UNSUPPORTED_THROTTLE_MS = 3000;

/** Surfaces a -32003 rejection at most once per message per throttle window,
 *  so a call site that also reports the rejection produces one notification. */
export function createMethodNotSupportedNotifier(): (message: string) => void {
  let last = { message: '', at: 0 };
  return (message: string): void => {
    const now = Date.now();
    if (message === last.message && now - last.at < UNSUPPORTED_THROTTLE_MS) return;
    last = { message, at: now };
    void vscode.window.showWarningMessage(`GitGlasses: ${message}`);
  };
}

/** The document sync each host builds; core only drives its resync. */
export interface DocumentSyncLike {
  resync(): void;
}

export interface CoreDeps {
  engine: EngineClient;
  repos: RepositoryService;
  docSync: DocumentSyncLike;
  /** Writes a line to the host's log sink. */
  log(line: string): void;
  /** Selector the hover and CodeLens providers register against. The node host
   *  serves file-scheme documents; the web host serves the workspace's own
   *  scheme, which may be virtual. */
  documentSelector: vscode.DocumentSelector;
  /** The editor the file commands act on, or undefined when the host does not
   *  serve the active document's scheme. */
  activeEditor(): vscode.TextEditor | undefined;
}

export interface Core {
  readonly views: Readonly<Record<string, ViewBase>>;
  readonly blame: BlameModel;
  readonly lineBlame: LineBlameController;
  readonly fileAnnotations: FileAnnotationsController;
  readonly integrations: IntegrationService;
  /** Everything core registered; the host pushes these onto its subscriptions. */
  readonly disposables: vscode.Disposable[];
  /** Re-renders the listed views, or every view when ids are omitted. */
  refreshViews(ids?: string[]): void;
  /** Drops a repo's blame cache (or every cache) and re-renders the annotations. */
  refreshAnnotations(repoId?: string): void;
  /** The refresh a HEAD move triggers: the history views plus the annotations. */
  onHeadChanged(repoId: string): void;
  /** Refreshes the annotations and every view. */
  refreshAll(): void;
  /** Re-registers the repos and refreshes everything after an engine respawn. */
  reload(): Promise<void>;
  /** The engine client's onRestarted hook: reloads, logging a failed reload. */
  handleEngineRestarted(): void;
}

export function createCore(context: vscode.ExtensionContext, deps: CoreDeps): Core {
  const { engine, repos, docSync } = deps;

  const blame = new BlameModel(engine);
  const lineBlame = new LineBlameController(blame, repos);
  const fileAnnotations = new FileAnnotationsController(blame, repos, context.workspaceState);
  const codeLens = new BlameCodeLensProvider(blame, repos);
  const revisionContent = new RevisionContentProvider(engine);

  const scm = vscode.scm.createSourceControl('gitglasses', 'GitGlasses');
  scm.quickDiffProvider = new GitGlassesQuickDiffProvider(repos);

  // Integrations: auth, hosting/issue providers, launchpad, PR enrichment.
  const auth = new AuthManager(context.secrets);
  const integrations = new IntegrationService(auth);
  const launchpad = new LaunchpadService(integrations, context.globalState);
  const prChips = new PrChipProvider(integrations);

  // Which repository the views and repo-scoped commands act on, persisted per
  // workspace; every call site resolves through this once it is installed.
  const activeRepo = new ActiveRepoManager(repos, context.workspaceState);
  setActiveRepoResolver(() => activeRepo.resolve());

  // Branches, remotes and tags render slices of one refs/list.
  const refsModel = new RefsModel(engine);

  // Conflicts left by an operation started anywhere, shown in the status bar.
  const conflicts = new ConflictWatcher(engine, repos);

  // Sidebar views (activity bar container "gitglasses").
  const searchView = new SearchViewProvider(engine, repos);
  const worktreesView = new WorktreesViewProvider(engine, repos);
  const branchesView = new BranchesViewProvider(engine, repos, refsModel);
  branchesView.setPrChipProvider(prChips);
  const homeView = new HomeViewProvider(engine, repos, launchpad, context.globalState);
  const views: Record<string, ViewBase> = {
    'gitglasses.views.home': homeView,
    'gitglasses.views.worktrees': worktreesView,
    'gitglasses.views.commits': new CommitsViewProvider(engine, repos),
    'gitglasses.views.branches': branchesView,
    'gitglasses.views.remotes': new RemotesViewProvider(engine, repos, refsModel),
    'gitglasses.views.stashes': new StashesViewProvider(engine, repos),
    'gitglasses.views.tags': new TagsViewProvider(engine, repos, refsModel),
    'gitglasses.views.fileHistory': new FileHistoryViewProvider(engine, repos),
    'gitglasses.views.searchCompare': searchView,
    'gitglasses.views.contributors': new ContributorsViewProvider(engine, repos),
  };

  const refreshViews = (ids?: string[]): void => {
    // Refreshed views re-read refs, so the shared fetch must not answer from
    // the pre-refresh cache.
    refsModel.invalidate();
    for (const [viewId, provider] of Object.entries(views)) {
      if (!ids || ids.includes(viewId)) provider.refresh();
    }
  };
  // The consumers of the blame cache; each re-reads what it needs.
  const refreshBlameConsumers = (): void => {
    lineBlame.refresh();
    fileAnnotations.refresh();
    codeLens.fire();
  };
  const refreshAnnotations = (repoId?: string): void => {
    blame.invalidate(repoId);
    refreshBlameConsumers();
  };
  const onHeadChanged = (repoId: string): void => {
    refreshViews(HISTORY_VIEWS);
    refreshAnnotations(repoId);
    conflicts.schedule();
  };
  const refreshAll = (): void => {
    refreshAnnotations();
    refreshViews();
    conflicts.schedule();
  };
  const reload = async (): Promise<void> => {
    await repos.rediscoverAll();
    // Repo ids are fresh after a respawn, so the workspace repos are looked
    // up again on the next resolve.
    activeRepo.reset();
    docSync.resync();
    refreshAll();
  };
  const handleEngineRestarted = (): void => {
    void reload().catch((error) => deps.log(`reload after engine restart failed: ${error}`));
  };

  const repoGroups = new RepoGroupsManager(context, engine, repos);

  // Capability gating: expose gitCli as a when-clause context so mutation
  // commands grey out on engine builds without the git CLI. Unknown (before
  // initialize) means "allow"; the engine's -32003 answer is the backstop.
  const updateCapabilityContext = (): void => {
    void vscode.commands.executeCommand(
      'setContext',
      'gitglasses.engineFullCapabilities',
      engine.capabilities()?.gitCli !== false,
    );
  };
  updateCapabilityContext();

  const disposables: vscode.Disposable[] = [
    lineBlame,
    fileAnnotations,
    codeLens,
    scm,
    auth,
    integrations,
    activeRepo,
    conflicts,
    engine.onDidChangeCapabilities(() => updateCapabilityContext()),
  ];

  const treeViews: vscode.TreeView<ViewNode>[] = [];
  for (const [viewId, provider] of Object.entries(views)) {
    const treeView = vscode.window.createTreeView(viewId, { treeDataProvider: provider });
    treeViews.push(treeView);
    disposables.push(provider, treeView);
  }

  // Which repository the views describe, shown next to each view's title. A
  // single-repo workspace needs no such label.
  const updateRepoLabels = async (): Promise<void> => {
    const all = await activeRepo.all().catch(() => []);
    const active = all.length > 1 ? await activeRepo.resolve() : undefined;
    const label = active ? repoName(active.rootPath) : undefined;
    for (const treeView of treeViews) treeView.description = label;
    void vscode.commands.executeCommand(
      'setContext',
      'gitglasses.multiRepoWorkspace',
      all.length > 1,
    );
  };
  void updateRepoLabels();
  disposables.push(
    activeRepo.onDidChange(() => {
      void updateRepoLabels();
      refreshAll();
    }),
    // The handshake is the first moment repositories can be discovered.
    engine.onDidChangeCapabilities(() => void updateRepoLabels()),
  );

  disposables.push(
    vscode.window.registerTerminalLinkProvider(new ShaTerminalLinkProvider(engine, repos)),
    // Blame caches keyed on version -1 (disk state) go stale on save/commit;
    // saving is a cheap conservative invalidation point that complements the
    // engine's repo/didChange pushes (harmless if both fire).
    vscode.workspace.onDidSaveTextDocument((doc) => {
      const located = repos.locate(doc.uri);
      if (located) blame.invalidate(located.repoId);
      refreshBlameConsumers();
    }),
    vscode.languages.registerHoverProvider(
      deps.documentSelector,
      new BlameHoverProvider(blame, repos, (text, repoRoot) =>
        integrations.autolinkText(text, repoRoot),
      ),
    ),
    vscode.languages.registerCodeLensProvider(deps.documentSelector, codeLens),
    vscode.workspace.registerTextDocumentContentProvider('gitglasses', revisionContent),
    vscode.commands.registerCommand('gitglasses.diffWithHead', async () => {
      const editor = deps.activeEditor();
      if (!editor) return;
      const located = await repos.locateOrDiscover(editor.document.uri);
      if (!located) return;
      const original = encodeRevisionUri(located.repoId, located.relativePath, 'HEAD');
      await vscode.commands.executeCommand(
        'vscode.diff',
        original,
        editor.document.uri,
        `${located.relativePath} (HEAD ↔ Working Tree)`,
      );
    }),
    vscode.commands.registerCommand('gitglasses.openFileAtRevision', async () => {
      const editor = deps.activeEditor();
      if (!editor) return;
      const located = await repos.locateOrDiscover(editor.document.uri);
      if (!located) return;
      const rev = await vscode.window.showInputBox({
        prompt: 'Revision (sha, branch, tag, HEAD~n…)',
        value: 'HEAD',
      });
      if (!rev) return;
      const uri = encodeRevisionUri(located.repoId, located.relativePath, rev);
      await vscode.window.showTextDocument(uri, { preview: true });
    }),
    vscode.commands.registerCommand('gitglasses.toggleLineBlame', () => lineBlame.toggle()),
    vscode.commands.registerCommand('gitglasses.toggleFileBlame', () =>
      fileAnnotations.toggle('blame'),
    ),
    vscode.commands.registerCommand('gitglasses.toggleChanges', () =>
      fileAnnotations.toggle('changes'),
    ),
    vscode.commands.registerCommand('gitglasses.toggleHeatmap', () =>
      fileAnnotations.toggle('heatmap'),
    ),
    vscode.commands.registerCommand('gitglasses.clearAnnotations', () => fileAnnotations.clear()),
    vscode.commands.registerCommand('gitglasses.restartEngine', async () => {
      await engine.restart();
      await reload();
    }),
    vscode.commands.registerCommand('gitglasses.refreshViews', () => refreshViews()),
    vscode.commands.registerCommand('gitglasses.selectRepository', () => activeRepo.pick()),
    vscode.commands.registerCommand('gitglasses.openWalkthrough', () =>
      vscode.commands.executeCommand(
        'workbench.action.openWalkthrough',
        'gitglasses.gitglasses#gitglasses.getStarted',
        false,
      ),
    ),
    vscode.commands.registerCommand('gitglasses.loadMore', (loadMore: unknown) => {
      if (typeof loadMore === 'function') (loadMore as () => void)();
    }),
    vscode.commands.registerCommand('gitglasses.copySha', async (node?: ViewNode) => {
      if (typeof node?.sha !== 'string') return;
      await vscode.env.clipboard.writeText(node.sha);
      vscode.window.setStatusBarMessage(`Copied ${shortSha(node.sha)}`, 3000);
    }),
    vscode.commands.registerCommand('gitglasses.openCommitDiff', (node?: ViewNode) =>
      openCommitDiff(node),
    ),
    vscode.commands.registerCommand('gitglasses.searchCommits', () => searchView.searchCommits()),
    vscode.commands.registerCommand('gitglasses.showLineHistory', async () => {
      const editor = deps.activeEditor();
      if (!editor) return;
      const located = await repos.locateOrDiscover(editor.document.uri);
      if (!located) {
        void vscode.window.showWarningMessage('GitGlasses: file is not in a git repository.');
        return;
      }
      const selection = editor.selection;
      let entries;
      try {
        ({ entries } = await engine.request('history/line', {
          repoId: located.repoId,
          path: located.relativePath,
          startLine: selection.start.line + 1,
          endLine: selection.end.line + 1,
        }));
      } catch {
        void vscode.window.showWarningMessage('GitGlasses: line history failed; see output.');
        return;
      }
      if (entries.length === 0) {
        void vscode.window.showInformationMessage('GitGlasses: no history for the selected lines.');
        return;
      }
      const picked = await vscode.window.showQuickPick(
        entries.map((entry) => ({
          label: entry.summary,
          description: commitDescription(entry),
          detail: `${entry.path}  +${entry.additions} −${entry.deletions}`,
          entry,
        })),
        { placeHolder: `History of lines ${selection.start.line + 1}-${selection.end.line + 1}` },
      );
      if (!picked) return;
      const uri = encodeRevisionUri(located.repoId, picked.entry.path, picked.entry.sha);
      await vscode.window.showTextDocument(uri, { preview: true });
    }),
    vscode.commands.registerCommand('gitglasses.groups.create', () => repoGroups.create()),
    vscode.commands.registerCommand('gitglasses.groups.open', () => repoGroups.open()),
    vscode.commands.registerCommand('gitglasses.groups.delete', () => repoGroups.delete()),
    vscode.commands.registerCommand('gitglasses.groups.export', () => repoGroups.export()),
    vscode.commands.registerCommand('gitglasses.groups.import', () => repoGroups.import()),
    vscode.commands.registerCommand('gitglasses.addIntegration', () =>
      integrations.addIntegration(),
    ),
    vscode.commands.registerCommand('gitglasses.removeIntegration', () =>
      integrations.removeIntegration(),
    ),
    vscode.commands.registerCommand('gitglasses.connectIntegration', () =>
      integrations.connectIntegration(),
    ),
    vscode.commands.registerCommand('gitglasses.disconnectIntegration', () =>
      integrations.disconnectIntegration(),
    ),
    ...registerHomeCommands(engine, repos, homeView, context.globalState),
    new ModeController(lineBlame, fileAnnotations, codeLens),
    registerStartWork(integrations, engine, repos),
    ...registerLaunchpad(launchpad, integrations),
    ...registerAiFeatures(context, engine, repos, searchView),
    registerSuggestChange(engine, repos, integrations),
  );

  const rebase = registerRebaseWebview(context, engine, repos);
  disposables.push(
    ...rebase.disposables,
    ...registerGraphWebview(context, engine, repos, (upstream) => rebase.host.open(upstream)),
    ...registerTimelineWebview(context, engine, repos),
    registerGitPalette(engine, repos, (upstream) => rebase.host.open(upstream)),
    ...registerWorktreeCommands(engine, repos, worktreesView),
  );

  return {
    views,
    blame,
    lineBlame,
    fileAnnotations,
    integrations,
    disposables,
    refreshViews,
    refreshAnnotations,
    onHeadChanged,
    refreshAll,
    reload,
    handleEngineRestarted,
  };
}
