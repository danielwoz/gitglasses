// Platform-independent half of activation. extension.ts (node host) and
// web/extensionWeb.ts (wasm host) each build their own transport, repository
// service and document sync, then hand them here. Everything that touches only
// the engine, the repositories and the views is registered in this module, so a
// command added once is registered on both hosts.

import * as vscode from 'vscode';
import { EngineClient } from '@gitglasses/rpc';
import { shortSha } from '@gitglasses/protocol/sha';
import { BlameModel, MAX_CACHE_BYTES, MAX_CACHE_ENTRIES } from './model/blameModel';
import { LocatedFile, RepositoryService, repoName } from './model/repositoryService';
import { ActiveRepoManager } from './model/activeRepo';
import { RefsModel } from './model/refsModel';
import { ConflictWatcher } from './model/conflictWatcher';
import { LineBlameController } from './annotations/lineBlame';
import { FileAnnotationsController } from './annotations/fileAnnotations';
import { BlameHoverProvider, BlameHoverRenderer } from './annotations/hoverProvider';
import { BufferSync, DocumentBlameService } from './annotations/documentBlame';
import { diffWithHeadTarget, registerBlameCommands } from './annotations/blameCommands';
import { BlameCodeLensProvider } from './codelens/blameCodeLens';
import {
  RevisionContentProvider,
  encodeRevisionUri,
  setRevisionRootLookup,
} from './scm/revisionContentProvider';
import { hasBuiltinGit, registerQuickDiff } from './scm/quickDiffSources';
import { registerScmGraphButton } from './scm/scmGraphButton';
import {
  ViewBase,
  ViewNode,
  ViewWithStates,
  setActiveRepoResolver,
  setViewLogger,
} from './views/viewBase';
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
import { registerRefCommands } from './views/refCommands';
import { registerRebaseTodoEditor } from './webviews/rebaseTodoEditor';
import { registerTimelineWebview } from './webviews/timelineHost';
import { registerGitPalette } from './commands/gitPalette';
import { registerKeyboardShortcuts } from './commands/keyboardShortcuts';
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
import { registerCommitDetails } from './commitDetails/commitDetails';
import { ProvenanceService } from './provenance/provenanceService';
import { registerProvenanceCommands } from './provenance/provenanceCommands';
import { WalkthroughOpener } from './home/walkthrough';
import { registerGitGraphMigration } from './onboarding/gitGraphMigration';

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

const MANAGE_TRUST = 'Manage Workspace Trust';

const RESTRICTED_NOTICE =
  'GitGlasses runs no git commands in Restricted Mode, so file history, patches and ' +
  'commands that change the repository are off until you trust this folder.';

/** Explains a Restricted Mode refusal (-32004) once per window, with a way to
 *  trust the folder. Reads that need git, such as file history, are refused
 *  on every refresh, and repeating the explanation would only add noise; the
 *  commands that change the repository are disabled in the UI instead. */
export function createRestrictedNotifier(): () => void {
  let shown = false;
  return (): void => {
    if (shown) return;
    shown = true;
    void vscode.window.showWarningMessage(RESTRICTED_NOTICE, MANAGE_TRUST).then((choice) => {
      if (choice === MANAGE_TRUST) {
        void vscode.commands.executeCommand('workbench.trust.manage');
      }
    });
  };
}

/** The document sync each host builds: blame pushes unsaved buffers through
 *  it, and core resyncs it after an engine respawn. */
export interface DocumentSyncLike extends BufferSync {
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
  /** The workspace's repositories and the one the views act on. */
  readonly activeRepo: ActiveRepoManager;
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

/** `selector` widened to the revision documents (gitglasses: scheme) that
 *  both hosts serve, which blame describes at their revision. */
function revisionDocumentsToo(selector: vscode.DocumentSelector): vscode.DocumentSelector {
  if (selector === '*') return selector;
  return [...(Array.isArray(selector) ? selector : [selector]), { scheme: 'gitglasses' }];
}

export function createCore(context: vscode.ExtensionContext, deps: CoreDeps): Core {
  const { engine, repos, docSync } = deps;

  const blame = new BlameModel(engine, MAX_CACHE_BYTES, MAX_CACHE_ENTRIES, deps.log);
  const auth = new AuthManager(context.secrets);
  const integrations = new IntegrationService(auth);
  const documentBlame = new DocumentBlameService(blame, repos, docSync);
  // What commits declare about who wrote them, shown wherever commits are.
  const provenance = new ProvenanceService(engine, deps.log);
  const blameHover = new BlameHoverRenderer(engine, {
    autolink: (text, repoRoot) => integrations.autolinkText(text, repoRoot),
    hosting: (repoRoot) => integrations.getHostingFor(repoRoot),
    provenance: (repoId, sha) => provenance.get(repoId, sha),
  });
  const lineBlame = new LineBlameController(documentBlame, blameHover);
  const fileAnnotations = new FileAnnotationsController(documentBlame, context.workspaceState);
  const codeLens = new BlameCodeLensProvider(documentBlame);
  // Revision documents record their repository's root, so one read after an
  // engine restart (which hands out new repo ids) still finds it.
  setRevisionRootLookup((repoId) => repos.rootOf(repoId));
  const revisionContent = new RevisionContentProvider(
    engine,
    (root) => repos.repositories().find((repo) => repos.isRootOf(repo.repoId, root))?.repoId,
  );
  setViewLogger(deps.log);

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
    'gitglasses.views.commits': new CommitsViewProvider(engine, repos, provenance),
    'gitglasses.views.branches': branchesView,
    'gitglasses.views.remotes': new RemotesViewProvider(engine, repos, refsModel),
    'gitglasses.views.stashes': new StashesViewProvider(engine, repos),
    'gitglasses.views.tags': new TagsViewProvider(engine, repos, refsModel),
    'gitglasses.views.fileHistory': new FileHistoryViewProvider(engine, repos, provenance),
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
  // Everything that renders from the blame cache; each re-reads what it needs.
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
    // Open "HEAD" documents (Open Changes with HEAD, quick diff) now name
    // other content.
    revisionContent.refreshMoved(repoId);
    conflicts.schedule();
  };
  const refreshAll = (): void => {
    refreshAnnotations();
    refreshViews();
    revisionContent.refreshMoved();
    conflicts.schedule();
  };
  // Fires once repositories are registered again after an engine respawn.
  const reloaded = new vscode.EventEmitter<void>();
  const reload = async (): Promise<void> => {
    await repos.rediscoverAll();
    // Repo ids are fresh after a respawn, so the workspace repos are looked
    // up again on the next resolve.
    activeRepo.reset();
    docSync.resync();
    refreshAll();
    revisionContent.refreshAll();
    reloaded.fire();
  };
  const handleEngineRestarted = (): void => {
    void reload().catch((error) => deps.log(`reload after engine restart failed: ${error}`));
  };

  const repoGroups = new RepoGroupsManager(context, engine, repos);
  const walkthrough = new WalkthroughOpener(deps.log);

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
    documentBlame,
    lineBlame,
    fileAnnotations,
    codeLens,
    documentBlame.onDidChangeSettings(() => refreshBlameConsumers()),
    revisionContent,
    auth,
    integrations,
    activeRepo,
    conflicts,
    engine.onDidChangeCapabilities(() => updateCapabilityContext()),
    provenance,
    provenance.onDidChangeEnabled(() =>
      refreshViews(['gitglasses.views.commits', 'gitglasses.views.fileHistory']),
    ),
    ...registerProvenanceCommands(engine, repos, deps.log),
  ];

  // Quick diff comes from VS Code's Git extension where it runs; GitGlasses
  // registers its own only where that extension is absent (see
  // QuickDiffSources for why it never adds a second source control).
  const builtinGit = hasBuiltinGit();
  disposables.push(
    ...registerQuickDiff(
      repos,
      () => activeRepo.all(),
      activeRepo.onDidChange,
      (listener) => engine.onDidChangeCapabilities(listener),
      deps.log,
    ),
  );

  const stateHost = () => ({ hasBuiltinGit: builtinGit, trusted: vscode.workspace.isTrusted });
  const treeViews: vscode.TreeView<ViewNode>[] = [];
  for (const [viewId, provider] of Object.entries(views)) {
    const withStates = new ViewWithStates(viewId, provider, stateHost);
    const treeView = vscode.window.createTreeView(viewId, { treeDataProvider: withStates });
    treeViews.push(treeView);
    disposables.push(provider, withStates, treeView);
  }

  // Which repository the views describe, shown next to each view's title. A
  // single-repo workspace needs no such label. The context keys let the
  // command palette offer repository commands only where there is one.
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
    void vscode.commands.executeCommand('setContext', 'gitglasses.hasRepository', all.length > 0);
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

  // The file an editor command acts on, telling the user when it is not in
  // a repository.
  const locateFile = async (
    uri: vscode.Uri,
  ): Promise<(LocatedFile & { uri: vscode.Uri }) | undefined> => {
    const located = await repos.locateOrDiscover(uri);
    if (!located) {
      void vscode.window.showInformationMessage(
        'GitGlasses: this file is not inside a repository.',
      );
      return undefined;
    }
    return { ...located, uri };
  };
  // The active editor's file, telling the user when there is none.
  const locateActiveFile = async (): Promise<
    (LocatedFile & { uri: vscode.Uri; editor: vscode.TextEditor }) | undefined
  > => {
    const editor = deps.activeEditor();
    if (!editor) {
      void vscode.window.showInformationMessage('GitGlasses: open a file first.');
      return undefined;
    }
    const located = await locateFile(editor.document.uri);
    return located && { ...located, editor };
  };

  // Revision documents follow the refs and the index, which change without
  // HEAD moving: a commit on the current branch moves a ref, staging
  // rewrites the index.
  disposables.push(
    engine.onNotification('repo/didChange', (params) => {
      if (!Array.isArray(params?.changed)) return;
      const { changed } = params;
      if (changed.includes('HEAD') || changed.includes('refs') || changed.includes('index')) {
        revisionContent.refreshMoved(params.repoId);
      }
    }),
  );

  disposables.push(
    vscode.window.registerTerminalLinkProvider(new ShaTerminalLinkProvider(engine, repos)),
    // Blame cached at version -1 describes the file on disk, which a save
    // changes; saving .mailmap and the like changes every file's.
    vscode.workspace.onDidSaveTextDocument((doc) => {
      const located = repos.locate(doc.uri);
      if (located) blame.invalidateSaved(located.repoId, located.relativePath);
      refreshBlameConsumers();
    }),
    vscode.languages.registerHoverProvider(
      revisionDocumentsToo(deps.documentSelector),
      new BlameHoverProvider(documentBlame, blameHover),
    ),
    ...registerBlameCommands(),
    vscode.languages.registerCodeLensProvider(deps.documentSelector, codeLens),
    vscode.workspace.registerTextDocumentContentProvider('gitglasses', revisionContent),
    ...registerCommitDetails(context, engine, repos, deps.log, provenance),
    vscode.commands.registerCommand('gitglasses.diffWithHead', async (arg?: unknown) => {
      const target = diffWithHeadTarget(arg);
      const located = target ? await locateFile(target) : await locateActiveFile();
      if (!located) return;
      const original = encodeRevisionUri(located.repoId, located.relativePath, 'HEAD');
      await vscode.commands.executeCommand(
        'vscode.diff',
        original,
        located.uri,
        `${located.relativePath} (HEAD ↔ Working Tree)`,
      );
    }),
    vscode.commands.registerCommand('gitglasses.openFileAtRevision', async () => {
      const located = await locateActiveFile();
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
    registerScmGraphButton({
      locateOrDiscover: (uri) => repos.locateOrDiscover(uri),
      activeRepoId: async () => (await activeRepo.resolve())?.repoId,
      setActive: (rootPath) => activeRepo.setActive(rootPath),
      log: deps.log,
    }),
    ...registerKeyboardShortcuts(),
    walkthrough,
    vscode.commands.registerCommand('gitglasses.openWalkthrough', () => walkthrough.open()),
    ...registerGitGraphMigration(context),
    vscode.commands.registerCommand('gitglasses.loadMore', (loadMore: unknown) => {
      if (typeof loadMore === 'function') (loadMore as () => void)();
    }),
    vscode.commands.registerCommand('gitglasses.copySha', async (node?: ViewNode) => {
      if (typeof node?.sha !== 'string') return;
      await vscode.env.clipboard.writeText(node.sha);
      vscode.window.setStatusBarMessage(`Copied ${shortSha(node.sha)}`, 3000);
    }),
    vscode.commands.registerCommand('gitglasses.openCommitDiff', (node?: ViewNode) =>
      openCommitDiff(node, repos),
    ),
    vscode.commands.registerCommand('gitglasses.searchCommits', () => searchView.searchCommits()),
    vscode.commands.registerCommand('gitglasses.showLineHistory', async () => {
      const located = await locateActiveFile();
      if (!located) return;
      const selection = located.editor.selection;
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
    ...registerAiFeatures(context, engine, repos, searchView, deps.log),
    registerSuggestChange(engine, repos, integrations),
  );

  const rebase = registerRebaseWebview(context, engine, repos, deps.log);
  disposables.push(
    ...rebase.disposables,
    reloaded,
    ...registerRebaseTodoEditor(context, deps.log),
    ...registerRefCommands({
      engine,
      repos,
      integrations,
      log: deps.log,
      refresh: () => refreshViews(),
      openRebase: (upstream) => rebase.host.open(upstream),
    }),
    ...registerGraphWebview({
      context,
      engine,
      repos,
      onDidChangeActiveRepo: activeRepo.onDidChange,
      onDidReload: reloaded.event,
      openRebase: (upstream) => rebase.host.open(upstream),
      log: deps.log,
      provenance,
    }),
    ...registerTimelineWebview(context, engine, repos),
    registerGitPalette(engine, repos, (upstream, repo) => rebase.host.open(upstream, repo), {
      listRepos: () => activeRepo.all(),
      activeEditorUri: () => deps.activeEditor()?.document.uri,
    }),
    ...registerWorktreeCommands(engine, repos, worktreesView),
  );

  return {
    views,
    blame,
    activeRepo,
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
