// Web (vscode.dev) activation entry. Owns the three things the native entry
// cannot share:
//   1. the engine is the wasm build driven through WasmTransport (no process),
//   2. the workspace is mirrored into the engine's MEMFS by MemfsBridge, and
//      file watcher events re-sync + synthesize the refreshes an engine
//      watcher would push (the wasm engine reports watch:false),
//   3. node-only features are excluded or degraded — see webFeatures.ts for
//      the authoritative in/out map.
// Everything else is registered by createCore, shared with src/extension.ts.
//
// Wasm mode is READ-ONLY v1: mutations are engine-rejected (-32003) and the
// existing capability gating greys their entry points.

import * as vscode from 'vscode';
import { EngineClient } from '@gitglasses/rpc';
import {
  createWasmTransportFactory,
  WasmEngineModule,
} from '../engine/wasmTransport';
import { createCore, createMethodNotSupportedNotifier } from '../core';
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

  const showMethodNotSupported = createMethodNotSupportedNotifier();

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
      onRestarted: () => core.handleEngineRestarted(),
    },
  );
  context.subscriptions.push({ dispose: () => engine.dispose() });

  const repos = new WebRepositoryService(engine, folder.uri.path, DEFAULT_MOUNT_PATH);
  const docSync = new WebDocumentSync(engine, repos);
  context.subscriptions.push(docSync);

  // Integrations run degraded on web: SecretStorage/fetch flows work, but
  // git-config remote detection is disabled (node:fs shim rejects), so
  // hosting is never auto-resolved. Launchpad and PR chips stay inert.
  //
  // The document selector and active editor are scheme-agnostic: a vscode.dev
  // workspace carries its own scheme (file: on local folders, vscode-test-web:
  // under the harness) and the MEMFS mirror serves all of them alike.
  const core = createCore(context, {
    engine,
    repos,
    docSync,
    log,
    documentSelector: '*',
    activeEditor: () => vscode.window.activeTextEditor,
  });
  context.subscriptions.push(...core.disposables);

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
    bridge.onDidSyncChanges(() => core.refreshAll()),
  );

  const notOnWeb = (what: string) => (): void => {
    void vscode.window.showInformationMessage(
      `GitGlasses: ${what} is not available in the web version yet.`,
    );
  };

  context.subscriptions.push(
    // Patch envelopes need node:crypto; contributed commands still resolve.
    vscode.commands.registerCommand('gitglasses.createPatch', notOnWeb('creating patches')),
    vscode.commands.registerCommand('gitglasses.applyPatch', notOnWeb('applying patches')),
    // Remote detection reads .git/config through node:fs, which the web shim
    // rejects, so these can never resolve a forge here. They are contributed
    // unconditionally (editor context menu, walkthrough), so they must resolve
    // to something rather than fail with "command not found".
    vscode.commands.registerCommand('gitglasses.openOnRemote', notOnWeb('opening files on the remote')),
    vscode.commands.registerCommand('gitglasses.copyRemoteUrl', notOnWeb('copying remote URLs')),
    vscode.commands.registerCommand(
      'gitglasses.openCommitOnRemote',
      notOnWeb('opening commits on the remote'),
    ),
    // Staging would mutate the MEMFS mirror only, never the real repository.
    vscode.commands.registerCommand('gitglasses.stageSelectedHunks', notOnWeb('staging hunks')),
    vscode.commands.registerCommand(
      'gitglasses.unstageSelectedHunks',
      notOnWeb('unstaging hunks'),
    ),
  );

  try {
    await engine.start();
    log('engine started: wasm (in-process)');
    await repos.discover();
    core.lineBlame.refresh();
    core.refreshViews();
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
