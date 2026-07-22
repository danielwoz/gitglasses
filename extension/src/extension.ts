import * as vscode from 'vscode';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { EngineClient } from './engine/engineClient';
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

function findEngineBinary(context: vscode.ExtensionContext): string | undefined {
  const configured = vscode.workspace
    .getConfiguration('gitglasses')
    .get<string>('engine.path');
  if (configured) return configured;

  const bundled = context.asAbsolutePath(
    path.join('bin', process.platform === 'win32' ? 'gitglasses-engine.exe' : 'gitglasses-engine'),
  );
  if (fs.existsSync(bundled)) return bundled;

  // Development fallback: repo-local build outputs.
  for (const preset of ['release', 'debug']) {
    const dev = context.asAbsolutePath(
      path.join('..', 'build', preset, 'engine', 'gitglasses-engine'),
    );
    if (fs.existsSync(dev)) return dev;
  }
  return undefined;
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel('GitGlasses');
  context.subscriptions.push(output);

  const enginePath = findEngineBinary(context);
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
  const engine = new EngineClient({
    enginePath,
    logLevel,
    onLog: (line) => output.appendLine(line),
    onCrash: (error) => output.appendLine(`engine crashed: ${error.message}`),
    onRestarted: () => {
      void repos.rediscoverAll().then(() => {
        blame.invalidate();
        docSync.resync();
        lineBlame.refresh();
        fileAnnotations.refresh();
        codeLens.fire();
      });
    },
  });
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
      new BlameHoverProvider(blame, repos),
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
    }),
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
