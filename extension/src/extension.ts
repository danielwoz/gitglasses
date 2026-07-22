import * as vscode from 'vscode';
import * as path from 'node:path';
import { EngineClient } from './engine/engineClient';
import { createProcessTransportFactory, findEngineBinary } from './engine/processTransport';
import { HeadChangeTracker } from './engine/capabilityGate';
import { DocumentSync } from './engine/documentSync';
import { BlameModel } from './model/blameModel';
import { RepositoryService } from './model/repositoryService';
import { LineBlameController } from './annotations/lineBlame';
import { FileAnnotationsController } from './annotations/fileAnnotations';
import { BlameHoverProvider } from './annotations/hoverProvider';
import { BlameCodeLensProvider } from './codelens/blameCodeLens';
import {
  RevisionContentProvider,
  encodeRevisionUri,
} from './scm/revisionContentProvider';
import { GitGlassesQuickDiffProvider } from './scm/quickDiffProvider';
import { ViewBase, ViewNode, firstWorkspaceRepo } from './views/viewBase';
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
import { registerPatchCommands } from './patches/patchCommands';
import { registerSuggestChange } from './reviews/suggestCommands';

function resolveEngineBinary(context: vscode.ExtensionContext): string | undefined {
  const configured = vscode.workspace
    .getConfiguration('gitglasses')
    .get<string>('engine.path');
  const bundled = context.asAbsolutePath(
    path.join('bin', process.platform === 'win32' ? 'gitglasses-engine.exe' : 'gitglasses-engine'),
  );
  // Development fallbacks after the bundled binary: repo-local build outputs.
  const dev = ['release', 'debug'].map((preset) =>
    context.asAbsolutePath(path.join('..', 'build', preset, 'engine', 'gitglasses-engine')),
  );
  return findEngineBinary({
    configuredPath: configured || undefined,
    candidates: [bundled, ...dev],
  });
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel('GitGlasses');
  context.subscriptions.push(output);

  const enginePath = resolveEngineBinary(context);
  if (!enginePath) {
    output.appendLine('gitglasses-engine binary not found; GitGlasses is disabled');
    void vscode.window.showWarningMessage(
      'GitGlasses: engine binary not found. Set "gitglasses.engine.path" or reinstall.',
    );
    return;
  }

  const logLevel = vscode.workspace
    .getConfiguration('gitglasses')
    .get<string>('engine.logLevel', 'warn');

  // Same-message throttle: -32003 surfaces once even when a call site also
  // reports the rejection through its own error path.
  let lastUnsupported = { message: '', at: 0 };
  const showMethodNotSupported = (message: string): void => {
    const now = Date.now();
    if (message === lastUnsupported.message && now - lastUnsupported.at < 3000) return;
    lastUnsupported = { message, at: now };
    void vscode.window.showWarningMessage(`GitGlasses: ${message}`);
  };

  const engine = new EngineClient(
    createProcessTransportFactory({
      enginePath,
      logLevel,
      onLog: (line) => output.appendLine(line),
    }),
    {
      onLog: (line) => output.appendLine(line),
      onCrash: (error) => output.appendLine(`engine crashed: ${error.message}`),
      onMethodNotSupported: (_method, message) => showMethodNotSupported(message),
      onRestarted: () => {
        void repos.rediscoverAll().then(() => {
          blame.invalidate();
          docSync.resync();
          lineBlame.refresh();
          fileAnnotations.refresh();
          codeLens.fire();
          for (const view of Object.values(views)) view.refresh();
        });
      },
    },
  );
  context.subscriptions.push({ dispose: () => engine.dispose() });

  const repos = new RepositoryService(engine);
  const blame = new BlameModel(engine);
  const docSync = new DocumentSync(engine, repos);
  const lineBlame = new LineBlameController(blame, repos);
  const fileAnnotations = new FileAnnotationsController(blame, repos);
  const codeLens = new BlameCodeLensProvider(blame, repos);
  const revisionContent = new RevisionContentProvider(engine);
  context.subscriptions.push(docSync, lineBlame, fileAnnotations, codeLens);

  const scm = vscode.scm.createSourceControl('gitglasses', 'GitGlasses');
  scm.quickDiffProvider = new GitGlassesQuickDiffProvider(repos);
  context.subscriptions.push(scm);

  // Integrations: auth, hosting/issue providers, launchpad, PR enrichment.
  const auth = new AuthManager(context.secrets);
  const integrations = new IntegrationService(auth);
  const launchpad = new LaunchpadService(integrations, context.globalState);
  const prChips = new PrChipProvider(integrations);
  context.subscriptions.push(auth, integrations);

  // Sidebar views (activity bar container "gitglasses").
  const searchView = new SearchViewProvider(engine, repos);
  const worktreesView = new WorktreesViewProvider(engine, repos);
  const branchesView = new BranchesViewProvider(engine, repos);
  branchesView.setPrChipProvider(prChips);
  const homeView = new HomeViewProvider(engine, repos, launchpad, context.globalState);
  const views: Record<string, ViewBase> = {
    'gitglasses.views.home': homeView,
    'gitglasses.views.worktrees': worktreesView,
    'gitglasses.views.commits': new CommitsViewProvider(engine, repos),
    'gitglasses.views.branches': branchesView,
    'gitglasses.views.remotes': new RemotesViewProvider(engine, repos),
    'gitglasses.views.stashes': new StashesViewProvider(engine, repos),
    'gitglasses.views.tags': new TagsViewProvider(engine, repos),
    'gitglasses.views.fileHistory': new FileHistoryViewProvider(engine, repos),
    'gitglasses.views.searchCompare': searchView,
    'gitglasses.views.contributors': new ContributorsViewProvider(engine, repos),
  };
  for (const [viewId, provider] of Object.entries(views)) {
    context.subscriptions.push(
      provider,
      vscode.window.registerTreeDataProvider(viewId, provider),
    );
  }
  const refreshViews = (ids?: string[]): void => {
    for (const [viewId, provider] of Object.entries(views)) {
      if (!ids || ids.includes(viewId)) provider.refresh();
    }
  };

  const repoGroups = new RepoGroupsManager(context, engine, repos);

  // The refresh work a HEAD move triggers, shared by the engine's
  // repo/didChange push and the watch-fallback poller below.
  const onHeadChanged = (repoId: string): void => {
    refreshViews([
      'gitglasses.views.commits',
      'gitglasses.views.branches',
      'gitglasses.views.remotes',
      'gitglasses.views.tags',
      'gitglasses.views.fileHistory',
      'gitglasses.views.contributors',
    ]);
    blame.invalidate(repoId);
    lineBlame.refresh();
    fileAnnotations.refresh();
    codeLens.fire();
  };

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

  // Watch fallback: engines without filesystem watching never push
  // repo/didChange, so poll the active repo's HEAD while the window is
  // focused and synthesize the same invalidation on a change.
  const POLL_INTERVAL_MS = 5000;
  const headTracker = new HeadChangeTracker();
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  const pollActiveRepoHead = async (): Promise<void> => {
    if (!vscode.window.state.focused) return;
    const editor = vscode.window.activeTextEditor;
    const located =
      editor && editor.document.uri.scheme === 'file'
        ? repos.locate(editor.document.uri)
        : undefined;
    const repoId = located?.repoId ?? (await firstWorkspaceRepo(repos))?.repoId;
    if (!repoId) return;
    const { head } = await engine.request('repo/state', { repoId });
    if (headTracker.update(repoId, head.oid)) onHeadChanged(repoId);
  };
  const updateWatchFallback = (): void => {
    const needsPolling = engine.capabilities()?.watch === false;
    if (needsPolling && pollTimer === undefined) {
      pollTimer = setInterval(() => void pollActiveRepoHead().catch(() => undefined), POLL_INTERVAL_MS);
    } else if (!needsPolling && pollTimer !== undefined) {
      clearInterval(pollTimer);
      pollTimer = undefined;
      headTracker.reset();
    }
  };
  context.subscriptions.push(
    engine.onDidChangeCapabilities(() => {
      updateCapabilityContext();
      updateWatchFallback();
    }),
    { dispose: () => { if (pollTimer !== undefined) clearInterval(pollTimer); } },
  );

  context.subscriptions.push(
    vscode.window.registerTerminalLinkProvider(new ShaTerminalLinkProvider(engine, repos)),
  );

  // Ref/HEAD/stash changes invalidate the histories the views show.
  context.subscriptions.push(
    engine.onNotification('repo/didChange', (params) => {
      if (!Array.isArray(params?.changed)) return;
      if (params.changed.includes('HEAD') || params.changed.includes('refs')) {
        refreshViews([
          'gitglasses.views.commits',
          'gitglasses.views.branches',
          'gitglasses.views.remotes',
          'gitglasses.views.tags',
          'gitglasses.views.fileHistory',
          'gitglasses.views.contributors',
        ]);
      }
      if (params.changed.includes('stash')) refreshViews(['gitglasses.views.stashes']);
    }),
  );

  // Blame caches keyed on version -1 (disk state) go stale on save/commit;
  // saving is a cheap conservative invalidation point that complements the
  // engine's repo/didChange pushes (harmless if both fire).
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((doc) => {
      const located = repos.locate(doc.uri);
      if (located) blame.invalidate(located.repoId);
      lineBlame.refresh();
      fileAnnotations.refresh();
      codeLens.fire();
    }),
  );

  // Engine-pushed repo state changes: HEAD moves and index changes rewrite
  // blame attribution, so drop that repo's cache and re-render everything.
  // The engine may not emit this notification yet; nothing here depends on it.
  context.subscriptions.push(
    engine.onNotification('repo/didChange', (params) => {
      if (!Array.isArray(params?.changed)) return;
      if (!params.changed.includes('HEAD') && !params.changed.includes('index')) return;
      blame.invalidate(params.repoId);
      lineBlame.refresh();
      fileAnnotations.refresh();
      codeLens.fire();
    }),
  );

  context.subscriptions.push(
    vscode.languages.registerHoverProvider(
      { scheme: 'file' },
      new BlameHoverProvider(blame, repos, (text, repoRoot) =>
        integrations.autolinkText(text, repoRoot),
      ),
    ),
    vscode.languages.registerCodeLensProvider({ scheme: 'file' }, codeLens),
    vscode.workspace.registerTextDocumentContentProvider('gitglasses', revisionContent),
    vscode.commands.registerCommand('gitglasses.diffWithHead', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.uri.scheme !== 'file') return;
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
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.uri.scheme !== 'file') return;
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
    vscode.commands.registerCommand('gitglasses.toggleHeatmap', () =>
      fileAnnotations.toggle('heatmap'),
    ),
    vscode.commands.registerCommand('gitglasses.clearAnnotations', () => fileAnnotations.clear()),
    vscode.commands.registerCommand('gitglasses.restartEngine', async () => {
      await engine.restart();
      await repos.rediscoverAll();
      blame.invalidate();
      docSync.resync();
      lineBlame.refresh();
      fileAnnotations.refresh();
      codeLens.fire();
      refreshViews();
    }),
    vscode.commands.registerCommand('gitglasses.refreshViews', () => refreshViews()),
    vscode.commands.registerCommand('gitglasses.loadMore', (loadMore: unknown) => {
      if (typeof loadMore === 'function') (loadMore as () => void)();
    }),
    vscode.commands.registerCommand('gitglasses.copySha', async (node?: ViewNode) => {
      if (typeof node?.sha !== 'string') return;
      await vscode.env.clipboard.writeText(node.sha);
      vscode.window.setStatusBarMessage(`Copied ${node.sha.slice(0, 8)}`, 3000);
    }),
    vscode.commands.registerCommand('gitglasses.openCommitDiff', (node?: ViewNode) =>
      openCommitDiff(node),
    ),
    vscode.commands.registerCommand('gitglasses.searchCommits', () => searchView.searchCommits()),
    vscode.commands.registerCommand('gitglasses.showLineHistory', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.uri.scheme !== 'file') return;
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
    ...registerPatchCommands(engine, repos, integrations),
    registerSuggestChange(engine, repos, integrations),
  );

  const rebase = registerRebaseWebview(context, engine, repos);
  context.subscriptions.push(
    ...rebase.disposables,
    ...registerGraphWebview(context, engine, repos, (upstream) => rebase.host.open(upstream)),
    ...registerTimelineWebview(context, engine, repos),
    registerGitPalette(engine, repos, (upstream) => rebase.host.open(upstream)),
    ...registerWorktreeCommands(engine, repos, worktreesView),
  );

  try {
    await engine.start();
    output.appendLine(`engine started: ${enginePath}`);
    lineBlame.refresh();
  } catch (error) {
    output.appendLine(`engine failed to start: ${String(error)}`);
    void vscode.window.showErrorMessage('GitGlasses: engine failed to start; see output.');
  }
}

export function deactivate(): void {}
