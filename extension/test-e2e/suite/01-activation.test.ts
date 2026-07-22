import * as assert from 'node:assert';
import * as vscode from 'vscode';
import { activateExtension, poll } from './helpers';

describe('activation', () => {
  it('activates gitglasses.gitglasses', async () => {
    const extension = await activateExtension();
    assert.ok(extension.isActive, 'extension did not reach the active state');
  });

  it('registers the gitglasses commands', async () => {
    await activateExtension();
    const required = [
      'gitglasses.showGraph',
      'gitglasses.gitCommands',
      'gitglasses.toggleFileBlame',
    ];
    // The output channel itself is not observable through the API, so command
    // registration stands in as the activation success signal.
    const commands = await poll(async () => {
      const all = await vscode.commands.getCommands(true);
      return required.every((command) => all.includes(command)) ? all : undefined;
    }, `missing commands; expected all of: ${required.join(', ')}`);
    for (const command of required) {
      assert.ok(commands.includes(command), `command not registered: ${command}`);
    }
  });
});
