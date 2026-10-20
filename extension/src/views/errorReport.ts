// Failure reporting for git operations started from the UI: a notification
// with the line that matters, git's whole explanation one click away, and the
// full text in the GitGlasses output channel.

import * as vscode from 'vscode';
import { errorMessage } from '../commands/ui';
import { hasMoreDetail, summarizeGitError } from './refActionsLogic';

export type LogFn = (line: string) => void;

const SHOW_DETAILS = 'Show Details';

/** Shows "<label> failed: <summary>" and logs the full message. */
export function reportGitError(label: string, error: unknown, log: LogFn): void {
  const full = errorMessage(error);
  log(`${label} failed: ${full}`);
  const summary = summarizeGitError(full);
  const actions = hasMoreDetail(full) ? [SHOW_DETAILS] : [];
  void vscode.window
    .showErrorMessage(`GitGlasses: ${label} failed: ${summary}`, ...actions)
    .then((choice) => {
      if (choice !== SHOW_DETAILS) return;
      void vscode.window.showErrorMessage(`${label} failed`, { modal: true, detail: full });
    });
}
