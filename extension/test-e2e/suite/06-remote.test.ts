import * as assert from 'node:assert';
import * as vscode from 'vscode';
import { FIXTURE } from '../fixture';
import { activateExtension, poll, waitForBlameHover, workspaceRoot } from './helpers';

// Exercises open-on-remote against the fixture's real origin. copyRemoteUrl is
// used rather than openOnRemote so the result lands on the clipboard and can be
// asserted, instead of asking the test host to launch a browser.
describe('open on remote', () => {
  it('registers the remote commands', async () => {
    await activateExtension();
    const all = await vscode.commands.getCommands(true);
    for (const command of [
      'gitglasses.openOnRemote',
      'gitglasses.copyRemoteUrl',
      'gitglasses.openCommitOnRemote',
    ]) {
      assert.ok(all.includes(command), `${command} was not registered`);
    }
  });

  it('copies a forge url for the active file and selection', async () => {
    await activateExtension();
    const uri = vscode.Uri.joinPath(workspaceRoot(), FIXTURE.blameFile);
    // Blame proves the engine has discovered the repo before we ask for a URL.
    await waitForBlameHover(uri);

    const editor = await vscode.window.showTextDocument(uri);
    editor.selection = new vscode.Selection(1, 0, 2, 0);

    await vscode.env.clipboard.writeText('');
    const url = await poll(async () => {
      await vscode.commands.executeCommand('gitglasses.copyRemoteUrl');
      const text = await vscode.env.clipboard.readText();
      return text.startsWith('https://') ? text : undefined;
    }, 'copyRemoteUrl never put a url on the clipboard');

    assert.ok(
      url.startsWith(`https://github.com/${FIXTURE.remoteOwner}/${FIXTURE.remoteRepo}/blob/`),
      `unexpected url base: ${url}`,
    );
    assert.ok(url.includes(`/${FIXTURE.blameFile}`), `url omits the file path: ${url}`);
    // Selection covers editor lines 1..2 (0-based), i.e. file lines 2..3.
    assert.ok(url.endsWith('#L2-L3'), `url omits the selected line range: ${url}`);
  });
});
