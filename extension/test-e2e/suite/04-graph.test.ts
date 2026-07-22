import * as assert from 'node:assert';
import * as vscode from 'vscode';
import { activateExtension } from './helpers';

describe('graph webview', () => {
  // The webview DOM is not reachable from the extension test host, so the
  // deepest observable signal is that the command that creates the panel and
  // starts streaming graph rows resolves instead of rejecting.
  it('executes showGraph without rejecting', async () => {
    await activateExtension();
    await assert.doesNotReject(
      Promise.resolve(vscode.commands.executeCommand('gitglasses.showGraph')),
      'gitglasses.showGraph rejected',
    );
  });
});
