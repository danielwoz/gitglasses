import * as assert from 'node:assert';
import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { FIXTURE } from '../fixture';
import { activateExtension, poll, waitForLocate, workspaceRoot } from './helpers';

function git(...args: string[]): string {
  const result = childProcess.spawnSync('git', args, {
    cwd: workspaceRoot().fsPath,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(' ')} failed (${result.status}): ${result.stderr}${result.stdout}`,
    );
  }
  return result.stdout.trim();
}

function revisionDocument(relativePath: string): vscode.TextDocument | undefined {
  return vscode.workspace.textDocuments.find(
    (document) => document.uri.scheme === 'gitglasses' && document.uri.path === `/${relativePath}`,
  );
}

// Runs last: it commits in the fixture repository.
describe('working alongside VS Code’s Git', () => {
  it('leaves Source Control to the built-in Git extension', async () => {
    const extension = await activateExtension();
    const builtin = vscode.extensions.getExtension<{
      getAPI(version: 1): { repositories: unknown[] };
    }>('vscode.git');
    assert.ok(builtin, 'VS Code’s Git extension is not installed in the test instance');
    const exports = builtin.isActive ? builtin.exports : await builtin.activate();
    const api = exports.getAPI(1);
    await poll(
      async () => (api.repositories.length > 0 ? true : undefined),
      'the built-in Git extension never opened the fixture repository',
    );

    // GitGlasses adds no source control of its own beside Git's, which
    // would take over the Source Control Graph and the status bar's branch
    // and sync items. vscode.scm.inputBox is the input box of the last
    // source control created through this API instance, and code loaded
    // from inside an extension's folder shares that extension's instance.
    const fromExtension = path.relative(extension.extensionPath, __filename);
    assert.ok(
      !fromExtension.startsWith('..') && !path.isAbsolute(fromExtension),
      `the suite must load from inside the extension to share its API: ${__filename}`,
    );
    assert.strictEqual(
      vscode.scm.inputBox,
      undefined,
      'GitGlasses registered a source control while VS Code’s Git extension runs',
    );
  });

  it('opens its walkthrough in the Welcome editor', async () => {
    await activateExtension();
    await vscode.commands.executeCommand('gitglasses.openWalkthrough');
    // Recent releases title the tab "Welcome" whichever walkthrough it
    // shows; earlier ones name the walkthrough.
    const label = await poll(async () => {
      const active = vscode.window.tabGroups.activeTabGroup.activeTab?.label;
      return active === 'Welcome' || active?.startsWith('Walkthrough:') ? active : undefined;
    }, 'the Welcome editor never opened');
    assert.ok(
      label === 'Welcome' || label === 'Walkthrough: Get Started with GitGlasses',
      `unexpected walkthrough tab: ${label}`,
    );
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  });

  it('reads Git Graph settings set in the workspace without Git Graph installed', async () => {
    await activateExtension();
    const settingsPath = path.join(workspaceRoot().fsPath, '.vscode', 'settings.json');
    const original = fs.readFileSync(settingsPath, 'utf8');
    try {
      fs.writeFileSync(
        settingsPath,
        JSON.stringify(
          {
            ...JSON.parse(original),
            'git-graph.repository.commits.initialLoad': 600,
            'git-graph.graph.style': 'angular',
          },
          null,
          2,
        ),
      );
      const plan = await poll(async () => {
        const current = await vscode.commands.executeCommand<{
          apply: Array<{ from: string; to: string; level: string; value: unknown }>;
          unmapped: Array<{ from: string }>;
        }>('_gitglasses.gitGraphMigrationPlan');
        return current && current.apply.length > 0 ? current : undefined;
      }, 'the Git Graph settings written to the workspace were never read');
      assert.deepStrictEqual(plan.apply, [
        {
          from: 'git-graph.repository.commits.initialLoad',
          to: 'gitglasses.graph.pageSize',
          level: 'workspace',
          value: 600,
        },
      ]);
      assert.deepStrictEqual(
        plan.unmapped.map((entry) => entry.from),
        ['git-graph.graph.style'],
      );
    } finally {
      fs.writeFileSync(settingsPath, original);
    }
  });

  it('reads the HEAD side of Open Changes with HEAD again after a commit and a reset', async () => {
    await activateExtension();
    const fileUri = vscode.Uri.joinPath(workspaceRoot(), FIXTURE.dirtyFile);
    const filePath = fileUri.fsPath;
    const original = fs.readFileSync(filePath, 'utf8');
    const committed = git('show', `HEAD:${FIXTURE.dirtyFile}`) + '\n';
    const edited = `${committed}edited for the HEAD document test\n`;
    fs.writeFileSync(filePath, edited);
    try {
      await waitForLocate(fileUri);
      await vscode.window.showTextDocument(fileUri);
      await vscode.commands.executeCommand('gitglasses.diffWithHead');
      await poll(
        async () =>
          revisionDocument(FIXTURE.dirtyFile)?.getText() === committed ? true : undefined,
        'the HEAD side of the diff never showed the committed contents',
      );

      git('add', FIXTURE.dirtyFile);
      git('commit', '-q', '-m', 'commit the edit');
      await poll(
        async () => (revisionDocument(FIXTURE.dirtyFile)?.getText() === edited ? true : undefined),
        'the HEAD side of the diff still showed the previous commit after a new one',
      );

      git('reset', '-q', '--soft', 'HEAD~1');
      await poll(
        async () =>
          revisionDocument(FIXTURE.dirtyFile)?.getText() === committed ? true : undefined,
        'the HEAD side of the diff did not follow a reset',
      );
    } finally {
      git('reset', '-q');
      fs.writeFileSync(filePath, original);
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    }
  });
});
