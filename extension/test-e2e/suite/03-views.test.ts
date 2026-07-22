import * as assert from 'node:assert';
import * as vscode from 'vscode';
import { activateExtension, poll } from './helpers';

describe('views', () => {
  it('contributes the commits view (focus command exists)', async () => {
    await activateExtension();
    // VS Code contributes a <viewId>.focus command for every registered view,
    // so its presence proves the tree view is contributed and resolvable.
    await poll(async () => {
      const all = await vscode.commands.getCommands(true);
      return all.includes('gitglasses.views.commits.focus') ? true : undefined;
    }, 'gitglasses.views.commits.focus command never appeared');
  });

  it('executes refreshViews without throwing', async () => {
    await activateExtension();
    await assert.doesNotReject(
      Promise.resolve(vscode.commands.executeCommand('gitglasses.refreshViews')),
      'gitglasses.refreshViews rejected',
    );
  });
});
