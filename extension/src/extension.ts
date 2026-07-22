import * as vscode from 'vscode';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { EngineClient } from './engine/engineClient';
import { DocumentSync } from './engine/documentSync';
import { BlameModel } from './model/blameModel';
import { RepositoryService } from './model/repositoryService';
import { LineBlameController } from './annotations/lineBlame';
import { BlameHoverProvider } from './annotations/hoverProvider';

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
      });
    },
  });
  context.subscriptions.push({ dispose: () => engine.dispose() });

  const repos = new RepositoryService(engine);
  const blame = new BlameModel(engine);
  const docSync = new DocumentSync(engine, repos);
  const lineBlame = new LineBlameController(blame, repos);
  context.subscriptions.push(docSync, lineBlame);

  // Blame caches keyed on version -1 (disk state) go stale on save/commit;
  // saving is the cheap conservative invalidation point until the engine
  // pushes repo/didChange events.
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((doc) => {
      const located = repos.locate(doc.uri);
      if (located) blame.invalidate(located.repoId);
      lineBlame.refresh();
    }),
  );

  context.subscriptions.push(
    vscode.languages.registerHoverProvider(
      { scheme: 'file' },
      new BlameHoverProvider(blame, repos),
    ),
    vscode.commands.registerCommand('gitglasses.toggleLineBlame', () => lineBlame.toggle()),
    vscode.commands.registerCommand('gitglasses.restartEngine', async () => {
      await engine.restart();
      await repos.rediscoverAll();
      blame.invalidate();
      docSync.resync();
      lineBlame.refresh();
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
