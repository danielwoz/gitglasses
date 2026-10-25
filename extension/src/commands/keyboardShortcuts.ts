// The opt-in keyboard shortcuts run these stand-ins for the real commands.
// VS Code shows a command's keybinding next to it in tooltips, the command
// palette and walkthrough tips whether or not the binding's when clause
// holds, so binding the real commands would advertise shortcuts that do
// nothing until gitglasses.keyboardShortcuts.enabled is turned on.

import * as vscode from 'vscode';

/** Shortcut command → the command it runs. */
export const SHORTCUT_COMMANDS: Readonly<Record<string, string>> = {
  'gitglasses.shortcut.showGraph': 'gitglasses.showGraph',
  'gitglasses.shortcut.toggleLineBlame': 'gitglasses.toggleLineBlame',
  'gitglasses.shortcut.toggleFileBlame': 'gitglasses.toggleFileBlame',
  'gitglasses.shortcut.showFileHistory': 'gitglasses.showFileHistory',
  'gitglasses.shortcut.searchCommits': 'gitglasses.searchCommits',
  'gitglasses.shortcut.gitCommands': 'gitglasses.gitCommands',
};

export function registerKeyboardShortcuts(): vscode.Disposable[] {
  return Object.entries(SHORTCUT_COMMANDS).map(([shortcut, target]) =>
    vscode.commands.registerCommand(shortcut, (...args: unknown[]) =>
      vscode.commands.executeCommand(target, ...args),
    ),
  );
}
