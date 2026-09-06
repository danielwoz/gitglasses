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

  // The staged diff addresses the index while the selection addresses the
  // working tree. With unstaged edits present the two disagree, and matching on
  // the caret silently unstaged a hunk the user never pointed at. The command
  // now offers an explicit picker instead; leaving it undismissed must change
  // nothing rather than guess.
  it('does not silently unstage when the worktree has drifted from the index', async () => {
    await activateExtension();
    const uri = vscode.Uri.joinPath(workspaceRoot(), FIXTURE.dirtyFile);
    await waitForBlameHover(vscode.Uri.joinPath(workspaceRoot(), FIXTURE.blameFile));

    // Stage the fixture's uncommitted line.
    const editor = await vscode.window.showTextDocument(uri);
    const target = Math.max(0, editor.document.lineCount - 2);
    editor.selection = new vscode.Selection(target, 0, target, 0);
    await poll(async () => {
      await vscode.commands.executeCommand('gitglasses.stageSelectedHunks');
      return stagedPaths().includes(FIXTURE.dirtyFile) ? true : undefined;
    }, 'setup: could not stage the dirty file');

    // Now make the working tree differ from the index again.
    const edit = new vscode.WorkspaceEdit();
    edit.insert(uri, new vscode.Position(0, 0), 'drift line A\ndrift line B\n');
    assert.ok(await vscode.workspace.applyEdit(edit), 'setup: edit failed');
    assert.ok(await vscode.workspace.save(uri), 'setup: save failed');

    const before = git('diff', '--cached');
    // Not awaited: the command blocks on a quick-pick. Dismissing it makes the
    // pick resolve undefined and the command return without touching the
    // index. Before the fix there was no pick and a hunk was unstaged outright.
    const pending = vscode.commands.executeCommand('gitglasses.unstageSelectedHunks');
    await new Promise((resolve) => setTimeout(resolve, 750));
    await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
    await pending;
    assert.strictEqual(git('diff', '--cached'), before, 'index changed without a choice');

    // Reset the fixture for any later test.
    git('reset', '--', FIXTURE.dirtyFile);
    git('checkout', '--', FIXTURE.dirtyFile);
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
