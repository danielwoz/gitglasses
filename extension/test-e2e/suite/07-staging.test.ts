import * as assert from 'node:assert';
import * as childProcess from 'node:child_process';
import * as vscode from 'vscode';
import { FIXTURE } from '../fixture';
import { activateExtension, poll, waitForBlameHover, workspaceRoot } from './helpers';

function git(...args: string[]): string {
  return childProcess
    .execFileSync('git', args, { cwd: workspaceRoot().fsPath, encoding: 'utf8' })
    .trim();
}

/** Paths git reports as having staged changes. */
function stagedPaths(): string[] {
  const out = git('diff', '--cached', '--name-only');
  return out === '' ? [] : out.split('\n');
}

// The fixture leaves tracked.txt with one uncommitted trailing line. These
// tests drive the real engine's stage/hunks through the command and assert
// against git itself, so a passing run proves the request actually works.
describe('hunk staging', () => {
  it('registers the staging commands', async () => {
    await activateExtension();
    const all = await vscode.commands.getCommands(true);
    assert.ok(all.includes('gitglasses.stageSelectedHunks'), 'stageSelectedHunks missing');
    assert.ok(all.includes('gitglasses.unstageSelectedHunks'), 'unstageSelectedHunks missing');
  });

  it('stages the hunk under the selection, then unstages it', async () => {
    await activateExtension();
    const uri = vscode.Uri.joinPath(workspaceRoot(), FIXTURE.dirtyFile);
    await waitForBlameHover(vscode.Uri.joinPath(workspaceRoot(), FIXTURE.blameFile));

    assert.deepStrictEqual(stagedPaths(), [], 'fixture should start with nothing staged');

    const editor = await vscode.window.showTextDocument(uri);
    // The uncommitted edit is the second line of the working copy.
    const lastLine = Math.max(0, editor.document.lineCount - 2);
    editor.selection = new vscode.Selection(lastLine, 0, lastLine, 0);

    await poll(async () => {
      await vscode.commands.executeCommand('gitglasses.stageSelectedHunks');
      return stagedPaths().includes(FIXTURE.dirtyFile) ? true : undefined;
    }, 'stageSelectedHunks never staged the dirty file');

    await poll(async () => {
      await vscode.commands.executeCommand('gitglasses.unstageSelectedHunks');
      return stagedPaths().includes(FIXTURE.dirtyFile) ? undefined : true;
    }, 'unstageSelectedHunks never unstaged the dirty file');

    assert.deepStrictEqual(stagedPaths(), [], 'index should be clean again');
  });
});

describe('annotations', () => {
  it('registers and executes the changes annotation', async () => {
    await activateExtension();
    const all = await vscode.commands.getCommands(true);
    assert.ok(all.includes('gitglasses.toggleChanges'), 'toggleChanges was not registered');

    const uri = vscode.Uri.joinPath(workspaceRoot(), FIXTURE.dirtyFile);
    await vscode.window.showTextDocument(uri);
    await assert.doesNotReject(
      Promise.resolve(vscode.commands.executeCommand('gitglasses.toggleChanges')),
      'toggleChanges rejected',
    );
    await assert.doesNotReject(
      Promise.resolve(vscode.commands.executeCommand('gitglasses.clearAnnotations')),
      'clearAnnotations rejected after toggleChanges',
    );
  });
});

describe('onboarding and integrations', () => {
  it('registers the walkthrough and integration commands', async () => {
    await activateExtension();
    const all = await vscode.commands.getCommands(true);
    for (const command of [
      'gitglasses.openWalkthrough',
      'gitglasses.addIntegration',
      'gitglasses.removeIntegration',
    ]) {
      assert.ok(all.includes(command), `${command} was not registered`);
    }
  });

  it('opens the contributed walkthrough', async () => {
    await activateExtension();
    await assert.doesNotReject(
      Promise.resolve(vscode.commands.executeCommand('gitglasses.openWalkthrough')),
      'openWalkthrough rejected; check the walkthrough id matches publisher.name#id',
    );
  });
});
