import * as assert from 'node:assert';
import * as vscode from 'vscode';
import { FIXTURE } from '../fixture';
import { activateExtension, poll, waitForBlameHover, workspaceRoot } from './helpers';

// Copies the URL rather than opening it, so the result lands on the clipboard
// and can be asserted instead of asking the test host to launch a browser.
async function copyUrlFor(selection: vscode.Selection): Promise<string> {
  const uri = vscode.Uri.joinPath(workspaceRoot(), FIXTURE.blameFile);
  // Blame proves the engine has discovered the repo before we ask for a URL.
  await waitForBlameHover(uri);
  const editor = await vscode.window.showTextDocument(uri);
  editor.selection = selection;

  await vscode.env.clipboard.writeText('');
  return poll(async () => {
    await vscode.commands.executeCommand('gitglasses.copyRemoteUrl');
    const text = await vscode.env.clipboard.readText();
    return text.startsWith('https://') ? text : undefined;
  }, 'copyRemoteUrl never put a url on the clipboard');
}

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
    // Editor lines 1..2 (0-based) selected to mid-line, i.e. file lines 2..3.
    const url = await copyUrlFor(new vscode.Selection(1, 0, 2, 5));

    assert.ok(
      url.startsWith(`https://github.com/${FIXTURE.remoteOwner}/${FIXTURE.remoteRepo}/blob/`),
      `unexpected url base: ${url}`,
    );
    assert.ok(url.includes(`/${FIXTURE.blameFile}`), `url omits the file path: ${url}`);
    assert.ok(url.endsWith('#L2-L3'), `url omits the selected line range: ${url}`);
  });

  // A whole-line selection ends on the next line at column 0 with nothing
  // selected there. Counting it linked a line the user never highlighted.
  it('excludes the trailing line of a whole-line selection', async () => {
    await activateExtension();
    const url = await copyUrlFor(new vscode.Selection(1, 0, 2, 0));
    assert.ok(url.endsWith('#L2'), `whole-line selection should link one line: ${url}`);
  });
});
