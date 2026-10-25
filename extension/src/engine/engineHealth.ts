// What the user sees when the engine process dies: a one-time note when it
// is restarted automatically, and an error with Restart Engine and Show Log
// once it kept crashing and the client stopped restarting it. The views then
// show their engine-unavailable welcome, which offers Restart Engine too.

import * as vscode from 'vscode';

export interface EngineHealthDeps {
  showLog(): void;
  /** Re-renders the views, so they show the engine as unavailable. */
  refreshViews(): void;
}

export const RESTART_ENGINE_COMMAND = 'gitglasses.restartEngine';

export interface EngineHealth {
  onCrash(error: Error): void;
  onGiveUp(error: Error): void;
}

export function createEngineHealth(deps: EngineHealthDeps): EngineHealth {
  let crashReported = false;
  const showLog = 'Show Log';
  const restart = 'Restart Engine';
  return {
    onCrash(): void {
      // The first crash of a session is worth a word; the respawn follows on
      // its own, and the give-up message covers a crash loop.
      if (crashReported) return;
      crashReported = true;
      void vscode.window
        .showWarningMessage(
          'GitGlasses: the engine stopped unexpectedly and is being restarted.',
          showLog,
        )
        .then((choice) => {
          if (choice === showLog) deps.showLog();
        });
    },
    onGiveUp(): void {
      deps.refreshViews();
      void vscode.window
        .showErrorMessage(
          'GitGlasses: the engine keeps crashing, so it was stopped. Restart it, or see the log ' +
            'for what failed.',
          restart,
          showLog,
        )
        .then((choice) => {
          if (choice === restart) void vscode.commands.executeCommand(RESTART_ENGINE_COMMAND);
          else if (choice === showLog) deps.showLog();
        });
    },
  };
}
