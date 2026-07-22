// Web (vscode.dev) activation entry. Mirrors the native activation in
// src/extension.ts, with three structural differences:
//   1. the engine is the wasm build driven through WasmTransport (no process),
//   2. the workspace is mirrored into the engine's MEMFS by MemfsBridge, and
//      file watcher events re-sync + synthesize the refreshes an engine
//      watcher would push (the wasm engine reports watch:false),
//   3. node-only features are excluded or degraded — see webFeatures.ts for
//      the authoritative in/out map.
//
// Wasm mode is READ-ONLY v1: mutations are engine-rejected (-32003) and the
// existing capability gating greys their entry points.

import * as vscode from 'vscode';
import { EngineClient } from '../engine/engineClient';
import {
  createWasmTransportFactory,
  WasmEngineModule,
} from '../engine/wasmTransport';
import { BlameModel } from '../model/blameModel';
import { LineBlameController } from '../annotations/lineBlame';
import { FileAnnotationsController } from '../annotations/fileAnnotations';
import { BlameHoverProvider } from '../annotations/hoverProvider';
import { BlameCodeLensProvider } from '../codelens/blameCodeLens';
import {
  RevisionContentProvider,
  encodeRevisionUri,
} from '../scm/revisionContentProvider';
import { GitGlassesQuickDiffProvider } from '../scm/quickDiffProvider';
import { ViewBase, ViewNode } from '../views/viewBase';
import { CommitsViewProvider } from '../views/commitsView';
import {
  BranchesViewProvider,
  RemotesViewProvider,
  StashesViewProvider,
  TagsViewProvider,
} from '../views/refsViews';
import { FileHistoryViewProvider } from '../views/fileHistoryView';
import { ContributorsViewProvider } from '../views/contributorsView';
import { SearchViewProvider } from '../views/searchView';
import { openCommitDiff } from '../views/nodes';
import { commitDescription } from '../views/viewLogic';
import { ShaTerminalLinkProvider } from '../terminal/linkProvider';
import { RepoGroupsManager } from '../groups/repoGroups';
import { registerGraphWebview } from '../webviews/graphHost';
import { registerRebaseWebview } from '../webviews/rebaseHost';
import { registerTimelineWebview } from '../webviews/timelineHost';
import { registerGitPalette } from '../commands/gitPalette';
import {
  WorktreesViewProvider,
  registerWorktreeCommands,
} from '../views/worktreesView';
import { AuthManager } from '../integrations/auth';
import { IntegrationService } from '../integrations/integrationService';
import { LaunchpadService } from '../integrations/launchpadService';
import { PrChipProvider } from '../integrations/prChips';
import { registerStartWork } from '../integrations/startWork';
import { registerLaunchpad } from '../views/launchpadView';
import { registerAiFeatures } from '../ai/features';
import { HomeViewProvider, registerHomeCommands } from '../home/homeView';
import { ModeController } from '../modes/modeController';
import { registerSuggestChange } from '../reviews/suggestCommands';
import {
  MemfsBridge,
  MemfsWriter,
  RepoTooLargeError,
  SourceEntryKind,
  SourceFs,
  DEFAULT_MAX_REPO_BYTES,
  DEFAULT_MOUNT_PATH,
  workspaceRelativePath,
} from './memfsBridge';
import { WebRepositoryService } from './webRepositoryService';
import { WebDocumentSync } from './documentSyncWeb';
import { createWasmModuleLoader } from './wasmModuleLoader';

const NO_GIT_NOTICE_KEY = 'gitglasses.web.noGitNoticeShown';
const SYNC_DEBOUNCE_MS = 300;

function kindOf(type: vscode.FileType): SourceEntryKind {
  if (type & vscode.FileType.SymbolicLink) return 'symlink';
  if (type & vscode.FileType.Directory) return 'directory';
  if (type & vscode.FileType.File) return 'file';
  return 'unknown';
}

/** Adapts vscode.workspace.fs (rooted at the workspace folder) to the
 *  bridge's injected read interface. */
function workspaceSourceFs(root: vscode.Uri): SourceFs {
  const uriOf = (rel: string): vscode.Uri =>
    rel ? vscode.Uri.joinPath(root, ...rel.split('/')) : root;
  return {
    async list(rel) {
      const entries = await vscode.workspace.fs.readDirectory(uriOf(rel));
      return entries.map(([name, type]) => ({ name, kind: kindOf(type) }));
    },
    read(rel) {
      return Promise.resolve(vscode.workspace.fs.readFile(uriOf(rel)));
    },
    async stat(rel) {
      const stat = await vscode.workspace.fs.stat(uriOf(rel));
      return { kind: kindOf(stat.type), size: stat.size };
    },
  };
}

/** Adapts an Emscripten module's FS to the bridge's write interface. */
function memfsWriter(module: WasmEngineModule): MemfsWriter {
  const fs = module.FS;
  return {
    mkdirTree(path) {
      if (typeof fs.mkdirTree === 'function') {
        fs.mkdirTree(path);
        return;
      }
      let current = '';
      for (const segment of path.split('/').filter(Boolean)) {
        current += `/${segment}`;
        try {
          fs.mkdir(current);
        } catch {
          // Already exists.
        }
      }
    },
    writeFile(path, data) {
      fs.writeFile(path, data);
    },
    remove(path) {
      try {
        fs.unlink(path);
      } catch {
        try {
          fs.rmdir(path);
        } catch {
          // Already gone (or a non-empty directory; a later full mirror on
          // engine restart reconciles).
        }
      }
    },
  };
}

/** Test hook returned from activate(): the web smoke suite polls it to
 *  assert the initialize handshake and capability shape. */
export interface WebExtensionApi {
  capabilities(): { gitCli: boolean; watch: boolean } | undefined;
  mode: 'wasm' | 'dormant';
}

export async function activate(
  context: vscode.ExtensionContext,
): Promise<WebExtensionApi> {
  const output = vscode.window.createOutputChannel('GitGlasses');
  context.subscriptions.push(output);
  const log = (line: string): void => {
    output.appendLine(line);
    // The worker console is the only visible sink in headless web tests and
    // remote-debug sessions; the duplication is deliberate.
    console.log(`[gitglasses] ${line}`);
  };

  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    log('web: no workspace folder open; GitGlasses stays dormant');
    return { capabilities: () => undefined, mode: 'dormant' };
  }
  if ((vscode.workspace.workspaceFolders?.length ?? 0) > 1) {
    log('web: multi-root workspace — only the first folder is mirrored (v1)');
  }

  const maxRepoBytes =
    vscode.workspace
      .getConfiguration('gitglasses')
      .get<number>('web.maxRepoBytes') ?? DEFAULT_MAX_REPO_BYTES;
  const bridge = new MemfsBridge(workspaceSourceFs(folder.uri), {
    maxTotalBytes: maxRepoBytes,
    mountPath: DEFAULT_MOUNT_PATH,
  });

  if (!(await bridge.hasGitDir())) {
    log(`web: no .git directory in ${folder.uri.toString()}; staying dormant`);
    if (!context.globalState.get<boolean>(NO_GIT_NOTICE_KEY)) {
      void context.globalState.update(NO_GIT_NOTICE_KEY, true);
      void vscode.window.showInformationMessage(
        'GitGlasses on the web needs a repository with a .git folder ' +
          '(e.g. a local folder opened in the browser). Rich support for ' +
          'virtual GitHub repos is not yet implemented.',
      );
    }
    return { capabilities: () => undefined, mode: 'dormant' };
  }

  // Same-message throttle for -32003, mirroring the native activation.
  let lastUnsupported = { message: '', at: 0 };
  const showMethodNotSupported = (message: string): void => {
    const now = Date.now();
    if (message === lastUnsupported.message && now - lastUnsupported.at < 3000) return;
    lastUnsupported = { message, at: now };
    void vscode.window.showWarningMessage(`GitGlasses: ${message}`);
  };

  // The module currently serving requests; the transport setup callback
  // refreshes it on every (re)spawn, and the watcher flushes into it.
  let currentModule: WasmEngineModule | undefined;
  const loadModule = createWasmModuleLoader(context.extensionUri, log);
  const engine = new EngineClient(
    createWasmTransportFactory({
      loadModule,
      setup: async (module) => {
        const stats = await bridge.mirrorInto(memfsWriter(module));
        currentModule = module;
        log(
          `web: mirrored ${stats.files} files (${(stats.bytes / (1024 * 1024)).toFixed(1)} MB) into MEMFS`,
        );
      },
      onLog: log,
    }),
    {
      onLog: log,
      onCrash: (error) => log(`engine crashed: ${error.message}`),
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

  const repos = new WebRepositoryService(engine, folder.uri.path, DEFAULT_MOUNT_PATH);
  const blame = new BlameModel(engine);
  const docSync = new WebDocumentSync(engine, repos);
  const lineBlame = new LineBlameController(blame, repos);
  const fileAnnotations = new FileAnnotationsController(blame, repos);
  const codeLens = new BlameCodeLensProvider(blame, repos);
  const revisionContent = new RevisionContentProvider(engine);
  context.subscriptions.push(docSync, lineBlame, fileAnnotations, codeLens);

  const scm = vscode.scm.createSourceControl('gitglasses', 'GitGlasses');
  scm.quickDiffProvider = new GitGlassesQuickDiffProvider(repos);
  context.subscriptions.push(scm);

  // Integrations run degraded on web: SecretStorage/fetch flows work, but
  // git-config remote detection is disabled (node:fs shim rejects), so
  // hosting is never auto-resolved. Launchpad and PR chips stay inert.
  const auth = new AuthManager(context.secrets);
  const integrations = new IntegrationService(auth);
  const launchpad = new LaunchpadService(integrations, context.globalState);
  const prChips = new PrChipProvider(integrations);
  context.subscriptions.push(auth, integrations);

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

  // Capability gating: the wasm engine reports gitCli:false, so mutation
  // commands grey out through the same when-clause context as native builds.
  const updateCapabilityContext = (): void => {
    void vscode.commands.executeCommand(
      'setContext',
      'gitglasses.engineFullCapabilities',
      engine.capabilities()?.gitCli !== false,
    );
  };
  updateCapabilityContext();
  context.subscriptions.push(
    engine.onDidChangeCapabilities(() => updateCapabilityContext()),
  );

  // Workspace → MEMFS re-sync. The wasm engine cannot watch anything
  // (watch:false), so watcher events copy changed files into the mirror and
  // then the bridge's sync event synthesizes the same client-side refresh a
  // repo/didChange push triggers on native. .git internals changed outside
  // this window (external pushes) are not covered in v1.
  const watcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(folder, '**/*'),
  );
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  const scheduleFlush = (): void => {
    clearTimeout(flushTimer);
    flushTimer = setTimeout(() => {
      const module = currentModule;
      if (!module) return;
      void bridge.flushInto(memfsWriter(module)).catch((error) => {
        log(`web: MEMFS re-sync failed: ${String(error)}`);
      });
    }, SYNC_DEBOUNCE_MS);
  };
  const onFsEvent = (uri: vscode.Uri): void => {
    const rel = workspaceRelativePath(folder.uri.path, uri.path);
    if (rel === undefined || rel === '') return;
    bridge.queueChange(rel);
    scheduleFlush();
  };
  context.subscriptions.push(
    watcher,
    watcher.onDidChange(onFsEvent),
    watcher.onDidCreate(onFsEvent),
    watcher.onDidDelete(onFsEvent),
    { dispose: () => clearTimeout(flushTimer) },
    bridge.onDidSyncChanges(() => {
      blame.invalidate();
      lineBlame.refresh();
      fileAnnotations.refresh();
      codeLens.fire();
      refreshViews();
    }),
  );

  // Saving invalidates version -1 (on-disk) blame caches, same as native.
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((doc) => {
      const located = repos.locate(doc.uri);
      if (located) blame.invalidate(located.repoId);
      lineBlame.refresh();
      fileAnnotations.refresh();
      codeLens.fire();
    }),
  );

  context.subscriptions.push(
    vscode.window.registerTerminalLinkProvider(
      new ShaTerminalLinkProvider(engine, repos),
    ),
  );

  const activeEditorUri = (): vscode.Uri | undefined =>
    vscode.window.activeTextEditor?.document.uri;

  const notOnWeb = (what: string) => (): void => {
    void vscode.window.showInformationMessage(
      `GitGlasses: ${what} is not available in the web version yet.`,
    );
  };

  context.subscriptions.push(
    vscode.languages.registerHoverProvider(
      '*',
      new BlameHoverProvider(blame, repos, (text, repoRoot) =>
        integrations.autolinkText(text, repoRoot),
      ),
    ),
    vscode.languages.registerCodeLensProvider('*', codeLens),
    vscode.workspace.registerTextDocumentContentProvider('gitglasses', revisionContent),
    vscode.commands.registerCommand('gitglasses.diffWithHead', async () => {
      const uri = activeEditorUri();
      if (!uri) return;
      const located = await repos.locateOrDiscover(uri);
      if (!located) return;
      const original = encodeRevisionUri(located.repoId, located.relativePath, 'HEAD');
      await vscode.commands.executeCommand(
        'vscode.diff',
        original,
        uri,
        `${located.relativePath} (HEAD ↔ Working Tree)`,
      );
    }),
    vscode.commands.registerCommand('gitglasses.openFileAtRevision', async () => {
      const uri = activeEditorUri();
      if (!uri) return;
      const located = await repos.locateOrDiscover(uri);
      if (!located) return;
      const rev = await vscode.window.showInputBox({
        prompt: 'Revision (sha, branch, tag, HEAD~n…)',
        value: 'HEAD',
      });
      if (!rev) return;
      const revUri = encodeRevisionUri(located.repoId, located.relativePath, rev);
      await vscode.window.showTextDocument(revUri, { preview: true });
    }),
    vscode.commands.registerCommand('gitglasses.toggleLineBlame', () => lineBlame.toggle()),
    vscode.commands.registerCommand('gitglasses.toggleFileBlame', () =>
      fileAnnotations.toggle('blame'),
    ),
    vscode.commands.registerCommand('gitglasses.toggleHeatmap', () =>
      fileAnnotations.toggle('heatmap'),
    ),
    vscode.commands.registerCommand('gitglasses.clearAnnotations', () =>
      fileAnnotations.clear(),
    ),
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
    vscode.commands.registerCommand('gitglasses.searchCommits', () =>
      searchView.searchCommits(),
    ),
    vscode.commands.registerCommand('gitglasses.showLineHistory', async () => {
      const editor = vscode.window.activeTextEditor;
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
    vscode.commands.registerCommand('gitglasses.connectIntegration', () =>
      integrations.connectIntegration(),
    ),
    vscode.commands.registerCommand('gitglasses.disconnectIntegration', () =>
      integrations.disconnectIntegration(),
    ),
    // Patch envelopes need node:crypto; contributed commands still resolve.
    vscode.commands.registerCommand('gitglasses.createPatch', notOnWeb('creating patches')),
    vscode.commands.registerCommand('gitglasses.applyPatch', notOnWeb('applying patches')),
    ...registerHomeCommands(engine, repos, homeView, context.globalState),
    new ModeController(lineBlame, fileAnnotations, codeLens),
    registerStartWork(integrations, engine, repos),
    ...registerLaunchpad(launchpad, integrations),
    ...registerAiFeatures(context, engine, repos, searchView),
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
    log('engine started: wasm (in-process)');
    await repos.discover();
    lineBlame.refresh();
    refreshViews();
  } catch (error) {
    if (error instanceof RepoTooLargeError) {
      log(`engine failed to start: ${error.message}`);
      void vscode.window.showErrorMessage(`GitGlasses: ${error.message}`);
    } else {
      log(`engine failed to start: ${String(error)}`);
      void vscode.window.showErrorMessage('GitGlasses: engine failed to start; see output.');
    }
  }

  return {
    capabilities: () => engine.capabilities(),
    mode: 'wasm',
  };
}

export function deactivate(): void {}
