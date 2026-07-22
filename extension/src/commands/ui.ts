// Thin vscode UI helpers shared by the git palette, graph actions, worktrees,
// and the rebase host: back-button-capable pickers, destructive-operation
// modals, and conflict guidance.

import * as vscode from 'vscode';
import { Confirmation } from './confirmations';

export interface PickOptions {
  title?: string;
  placeholder?: string;
  /** Show a Back button; resolving with 'back' lets flows rewind a step. */
  back?: boolean;
}

export function showPick<T extends vscode.QuickPickItem>(
  items: readonly T[],
  options: PickOptions = {},
): Promise<T | 'back' | undefined> {
  return new Promise((resolve) => {
    const picker = vscode.window.createQuickPick<T>();
    picker.items = [...items];
    picker.title = options.title;
    picker.placeholder = options.placeholder;
    if (options.back) picker.buttons = [vscode.QuickInputButtons.Back];
    let settled = false;
    const settle = (value: T | 'back' | undefined): void => {
      if (settled) return;
      settled = true;
      resolve(value);
      picker.dispose();
    };
    picker.onDidTriggerButton((button) => {
      if (button === vscode.QuickInputButtons.Back) settle('back');
    });
    picker.onDidAccept(() => settle(picker.selectedItems[0]));
    picker.onDidHide(() => settle(undefined));
    picker.show();
  });
}

export interface InputOptions {
  title?: string;
  prompt?: string;
  value?: string;
  placeholder?: string;
  back?: boolean;
  validate?: (value: string) => string | undefined;
}

export function showInput(options: InputOptions = {}): Promise<string | 'back' | undefined> {
  return new Promise((resolve) => {
    const input = vscode.window.createInputBox();
    input.title = options.title;
    input.prompt = options.prompt;
    input.value = options.value ?? '';
    input.placeholder = options.placeholder;
    if (options.back) input.buttons = [vscode.QuickInputButtons.Back];
    let settled = false;
    const settle = (value: string | 'back' | undefined): void => {
      if (settled) return;
      settled = true;
      resolve(value);
      input.dispose();
    };
    input.onDidChangeValue((value) => {
      input.validationMessage = options.validate?.(value);
    });
    input.onDidTriggerButton((button) => {
      if (button === vscode.QuickInputButtons.Back) settle('back');
    });
    input.onDidAccept(() => {
      if (options.validate?.(input.value)) return;
      settle(input.value);
    });
    input.onDidHide(() => settle(undefined));
    input.show();
  });
}

/** Modal confirmation for a destructive git operation; the detail shows the
 *  exact git command that will run. */
export async function confirmDestructive(confirmation: Confirmation): Promise<boolean> {
  const choice = await vscode.window.showWarningMessage(
    confirmation.message,
    { modal: true, detail: confirmation.detail },
    'Proceed',
  );
  return choice === 'Proceed';
}

/** Warning shown when a mutation reports {conflicts: true}. */
export function showConflictGuidance(operation: string): void {
  void vscode.window.showWarningMessage(
    `${operation} stopped on conflicts. Resolve the conflicted files, stage them in Source Control, then continue or abort the operation.`,
  );
}

export function setStatus(message: string): void {
  vscode.window.setStatusBarMessage(`GitGlasses: ${message}`, 5000);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
