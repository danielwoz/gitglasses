// Native (node) activation entry. Owns the process transport and engine-path
// resolution, the node document sync, the watch fallback, and the features that
// need node APIs or a real filesystem: hunk staging, open-on-remote and
// patches. Everything else is registered by createCore, which the web entry
// shares — see src/core.ts.

import * as vscode from 'vscode';
import * as path from 'node:path';
import { EngineClient } from '@gitglasses/rpc';
import { createProcessTransportFactory, findEngineBinary } from '@gitglasses/rpc/node';
import { createCore, createMethodNotSupportedNotifier, HISTORY_VIEWS } from './core';
import { errorMessage } from './commands/ui';
import { HeadChangeTracker } from './engine/capabilityGate';
import { DocumentSync } from './engine/documentSync';
import { RepositoryService } from './model/repositoryService';
import { ViewNode, activeWorkspaceRepo, requireRepo } from './views/viewBase';
import { buildRemoteUrl, type RemoteTarget } from './integrations/remoteUrls';
import {
  describeHunk,
  describeHunkCount,
  hunksIntersectingSelection,
  selectionLineRange,
  toHunkRange,
} from './scm/hunkStaging';
import { registerPatchCommands } from './patches/patchCommands';

function resolveEngineBinary(context: vscode.ExtensionContext): string | undefined {
  const configured = vscode.workspace
    .getConfiguration('gitglasses')
    .get<string>('engine.path');
  const exe = process.platform === 'win32' ? 'gitglasses-engine.exe' : 'gitglasses-engine';
  const bundled = context.asAbsolutePath(path.join('bin', exe));
  // Development fallbacks after the bundled binary: repo-local build outputs.
  // Windows needs the .exe suffix here too.
  const dev = ['release', 'debug'].map((preset) =>
    context.asAbsolutePath(path.join('..', 'build', preset, 'engine', exe)),
  );
  return findEngineBinary({
    configuredPath: configured || undefined,
    candidates: [bundled, ...dev],
  });
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel('GitGlasses');
  context.subscriptions.push(output);
  const log = (line: string): void => output.appendLine(line);

  const enginePath = resolveEngineBinary(context);
  if (!enginePath) {
    log('gitglasses-engine binary not found; GitGlasses is disabled');
    void vscode.window.showWarningMessage(
      'GitGlasses: engine binary not found. Set "gitglasses.engine.path" or reinstall.',
    );
    return;
  }

  const logLevel = vscode.workspace
    .getConfiguration('gitglasses')
    .get<string>('engine.logLevel', 'warn');

  const showMethodNotSupported = createMethodNotSupportedNotifier();

  const engine = new EngineClient(
    createProcessTransportFactory({ enginePath, logLevel, onLog: log }),
    {
      onLog: log,
      onCrash: (error) => log(`engine crashed: ${error.message}`),
      onMethodNotSupported: (_method, message) => showMethodNotSupported(message),
      onRestarted: () => core.handleEngineRestarted(),
    },
  );
  context.subscriptions.push({ dispose: () => engine.dispose() });

  const repos = new RepositoryService(engine);
  const docSync = new DocumentSync(engine, repos);
  context.subscriptions.push(docSync);

  // The editor GitGlasses acts on: file-scheme documents only, since the node
  // engine reads the working tree off disk.
  const activeEditor = (): vscode.TextEditor | undefined => {
    const editor = vscode.window.activeTextEditor;
    return editor && editor.document.uri.scheme === 'file' ? editor : undefined;
  };

  const core = createCore(context, {
    engine,
    repos,
    docSync,
    log,
    documentSelector: { scheme: 'file' },
    activeEditor,
  });
  context.subscriptions.push(...core.disposables);
  const { blame, fileAnnotations, integrations } = core;

  // Whether the file differs between the working tree and the index. Staged
  // hunk line numbers are only comparable to editor line numbers while this is
  // false.
  const hasUnstagedChanges = async (located: {
    repoId: string;
    relativePath: string;
  }): Promise<boolean> => {
    try {
      const { hunks } = await engine.request('diff/fileHunks', {
        repoId: located.repoId,
        path: located.relativePath,
        staged: false,
      });
      return hunks.length > 0;
    } catch {
      // Unknown: answer yes, which routes the caller to the explicit picker.
      return true;
    }
  };

  // Stage or unstage just the hunks the editor selection covers. Staging reads
  // the unstaged diff and unstaging reads the staged one, so each direction
  // offers the hunks that can actually move that way.
  const stageSelectedHunks = async (action: 'stage' | 'unstage'): Promise<void> => {
    const editor = activeEditor();
    if (!editor) {
      void vscode.window.showInformationMessage('GitGlasses: open a file first.');
      return;
    }
    const located = await repos.locateOrDiscover(editor.document.uri);
    if (!located) {
      void vscode.window.showInformationMessage(
        'GitGlasses: this file is not inside a repository.',
      );
      return;
    }
    // Hunk positions are computed against the file on disk, so the buffer has
    // to be saved before the selection can be matched against them.
    if (editor.document.isDirty) {
      const choice = await vscode.window.showWarningMessage(
        'GitGlasses: this file has unsaved changes. Hunks are read from the file on disk.',
        'Save and Continue',
        'Cancel',
      );
      if (choice !== 'Save and Continue') return;
      if (!(await editor.document.save())) return;
    }
    try {
      const { hunks } = await engine.request('diff/fileHunks', {
        repoId: located.repoId,
        path: located.relativePath,
        staged: action === 'unstage',
      });
      if (hunks.length === 0) {
        void vscode.window.showInformationMessage(
          `GitGlasses: nothing to ${action} in this file.`,
        );
        return;
      }

      // Staged hunk positions address the index, the selection addresses the
      // working tree. They agree only while the file has no unstaged changes;
      // otherwise the hunks are picked explicitly.
      let picked: typeof hunks;
      if (action === 'unstage' && (await hasUnstagedChanges(located))) {
        const items = hunks.map((hunk) => ({ ...describeHunk(hunk), hunk }));
        const chosen = await vscode.window.showQuickPick(items, {
          placeHolder: 'Which staged hunk should be unstaged?',
          canPickMany: true,
        });
        if (!chosen || chosen.length === 0) return;
        picked = chosen.map((item) => item.hunk);
      } else {
        const range = selectionLineRange(
          editor.selection.start.line,
          editor.selection.end.line,
          editor.selection.end.character,
        );
        picked = hunksIntersectingSelection(hunks, range.startLine, range.endLine);
      }

      if (picked.length === 0) {
        void vscode.window.showInformationMessage(
          `GitGlasses: no ${action === 'stage' ? 'unstaged' : 'staged'} changes in the selection.`,
        );
        return;
      }
      await engine.request('stage/hunks', {
        repoId: located.repoId,
        path: located.relativePath,
        action,
        hunks: picked.map(toHunkRange),
      });
      void vscode.window.showInformationMessage(
        `GitGlasses: ${describeHunkCount(picked.length, action)}`,
      );
      blame.invalidate();
      fileAnnotations.refresh();
      core.refreshViews();
    } catch (error) {
      void vscode.window.showWarningMessage(
        `GitGlasses: could not ${action} hunks — ${errorMessage(error)}`,
      );
    }
  };

  // "Open on remote": resolve the active file's repo, ask the integration layer
  // which forge hosts it, then hand the target to the pure URL builder.
  const revealOnRemote = async (
    target: RemoteTarget,
    action: 'open' | 'copy',
    repoRoot?: string,
  ): Promise<void> => {
    let root = repoRoot;
    if (root === undefined) {
      const editor = vscode.window.activeTextEditor;
      const located = editor && (await repos.locateOrDiscover(editor.document.uri));
      if (!located) {
        void vscode.window.showInformationMessage(
          'GitGlasses: open a file inside a repository first.',
        );
        return;
      }
      root = located.rootPath;
    }
    const hosting = await integrations.getHostingFor(root);
    if (!hosting) {
      void vscode.window.showInformationMessage(
        'GitGlasses: no recognised remote for this repository.',
      );
      return;
    }
    const url = buildRemoteUrl(hosting.providerId, hosting.repo, target);
    if (!url) {
      void vscode.window.showInformationMessage(
        `GitGlasses: opening on ${hosting.host} is not supported yet.`,
      );
      return;
    }
    if (action === 'copy') {
      await vscode.env.clipboard.writeText(url);
      void vscode.window.showInformationMessage('GitGlasses: remote URL copied.');
      return;
    }
    await vscode.env.openExternal(vscode.Uri.parse(url));
  };

  // Links the active file at the checked-out branch, carrying the selection as
  // a line range. A detached or unborn HEAD has no branch the forge can serve,
  // so the commit sha is used instead.
  const openOnRemote = async (action: 'open' | 'copy'): Promise<void> => {
    const editor = activeEditor();
    if (!editor) {
      void vscode.window.showInformationMessage('GitGlasses: open a file first.');
      return;
    }
    const located = await repos.locateOrDiscover(editor.document.uri);
    if (!located) {
      void vscode.window.showInformationMessage(
        'GitGlasses: this file is not inside a repository.',
      );
      return;
    }
    let ref = 'HEAD';
    try {
      const { head } = await engine.request('repo/state', { repoId: located.repoId });
      if (head.unborn) ref = 'HEAD';
      else if (head.detached || head.branch === '') ref = head.oid;
      else ref = head.branch;
    } catch {
      // Fall back to HEAD, which the supported forges resolve.
    }
    const range = selectionLineRange(
      editor.selection.start.line,
      editor.selection.end.line,
      editor.selection.end.character,
    );
    await revealOnRemote(
      {
        kind: 'file',
        path: located.relativePath,
        ref,
        startLine: range.startLine,
        endLine: range.endLine,
      },
      action,
      located.rootPath,
    );
  };

  // Watch fallback: engines without filesystem watching never push
  // repo/didChange, so poll the active repo's HEAD while the window is
  // focused and synthesize the same invalidation on a change.
  const POLL_INTERVAL_MS = 5000;
  const headTracker = new HeadChangeTracker();
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  const pollActiveRepoHead = async (): Promise<void> => {
    if (!vscode.window.state.focused) return;
    const editor = activeEditor();
    const located = editor && repos.locate(editor.document.uri);
    const repoId = located?.repoId ?? (await activeWorkspaceRepo(repos))?.repoId;
    if (!repoId) return;
    const { head } = await engine.request('repo/state', { repoId });
    if (headTracker.update(repoId, head.oid)) core.onHeadChanged(repoId);
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
    engine.onDidChangeCapabilities(() => updateWatchFallback()),
    { dispose: () => { if (pollTimer !== undefined) clearInterval(pollTimer); } },
  );

  // Engine-pushed repo state changes. A HEAD move invalidates both the
  // histories the views show and the blame attribution, so it runs the shared
  // HEAD refresh; a ref or index change needs only one of the two.
  context.subscriptions.push(
    engine.onNotification('repo/didChange', (params) => {
      if (!Array.isArray(params?.changed)) return;
      if (params.changed.includes('HEAD')) {
        core.onHeadChanged(params.repoId);
      } else {
        if (params.changed.includes('refs')) core.refreshViews(HISTORY_VIEWS);
        if (params.changed.includes('index')) core.refreshAnnotations(params.repoId);
      }
      if (params.changed.includes('stash')) core.refreshViews(['gitglasses.views.stashes']);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('gitglasses.stageSelectedHunks', () =>
      stageSelectedHunks('stage'),
    ),
    vscode.commands.registerCommand('gitglasses.unstageSelectedHunks', () =>
      stageSelectedHunks('unstage'),
    ),
    vscode.commands.registerCommand('gitglasses.openOnRemote', () => openOnRemote('open')),
    vscode.commands.registerCommand('gitglasses.copyRemoteUrl', () => openOnRemote('copy')),
    vscode.commands.registerCommand('gitglasses.openCommitOnRemote', async (node?: ViewNode) => {
      if (typeof node?.sha !== 'string') return;
      // The node carries no repo of its own, so the URL is built from the
      // active repository — the same one the views the node came from render.
      const repo = await requireRepo(repos);
      if (!repo) return;
      await revealOnRemote({ kind: 'commit', sha: node.sha }, 'open', repo.rootPath);
    }),
    ...registerPatchCommands(engine, repos, integrations),
  );

  try {
    await engine.start();
    log(`engine started: ${enginePath}`);
    core.lineBlame.refresh();
    // Annotation modes restored from the previous session paint once the
    // engine can answer blame.
    core.fileAnnotations.refresh();
  } catch (error) {
    log(`engine failed to start: ${String(error)}`);
    void vscode.window.showErrorMessage('GitGlasses: engine failed to start; see output.');
  }
}

export function deactivate(): void {}
