// The rebase editor as a custom editor for the todo list `git rebase -i`
// hands its sequence editor, for rebases started outside GitGlasses (in a
// terminal, with VS Code as git's editor). It is offered through "Reopen
// Editor With…", and opens on its own when gitglasses.rebaseEditor.enabled
// is set, through a workbench.editorAssociations entry for the todo file:
// `code --wait` returns as soon as any editor of the file closes, so the
// todo has to open in this editor directly rather than be reopened in it.
// Save and Continue writes the reordered list back and closes the editor,
// which hands it to git; Cancel Rebase hands git an empty list.

import * as vscode from 'vscode';
import { renderWebviewHtml } from './webviewHtml';
import {
  editorAssociationsFor,
  parseTodo,
  rebaseEditorEnabled,
  serializeTodo,
} from './rebaseTodoLogic';
import type { HostToWebviewMessage, WebviewToHostMessage } from '../../webviews-src/rebase/ipc';
import type { LogFn } from '../views/errorReport';
import { errorMessage } from '../commands/ui';

export const REBASE_TODO_VIEW_TYPE = 'gitglasses.rebaseTodo';

class RebaseTodoEditorProvider implements vscode.CustomTextEditorProvider {
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly log: LogFn,
  ) {}

  resolveCustomTextEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel): void {
    const distRoot = vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webviews');
    panel.webview.options = { enableScripts: true, localResourceRoots: [distRoot] };
    panel.webview.html = renderWebviewHtml(panel.webview, distRoot, {
      script: 'rebase.js',
      style: 'rebase.css',
      title: 'Interactive Rebase',
    });
    let parsed = parseTodo(document.getText());
    const post = (message: HostToWebviewMessage): void => {
      void panel.webview.postMessage(message);
    };
    const unsupportedMessage = (): string =>
      `This list has steps the rebase editor cannot show:\n${parsed.unsupported.join('\n')}\n\n` +
      'Reopen it as text (Reopen Editor With… › Text Editor) to edit it.';

    // Writing the list and closing the editor hands it back to git.
    const handBack = async (text: string): Promise<void> => {
      const edit = new vscode.WorkspaceEdit();
      edit.replace(
        document.uri,
        document.validateRange(new vscode.Range(0, 0, Number.MAX_SAFE_INTEGER, 0)),
        text,
      );
      if (!(await vscode.workspace.applyEdit(edit)) || !(await document.save())) {
        throw new Error(`cannot write ${document.uri.fsPath}`);
      }
      panel.dispose();
    };

    const subscription = panel.webview.onDidReceiveMessage(
      async (message: WebviewToHostMessage) => {
        try {
          switch (message.type) {
            case 'ready':
              parsed = parseTodo(document.getText());
              post({
                type: 'init',
                mode: 'todo',
                upstream: parsed.range ?? 'git rebase -i',
                branch: '',
                entries: parsed.commits.map((commit) => ({
                  sha: commit.sha,
                  summary: commit.summary,
                  action: commit.action,
                })),
                mergeCount: 0,
                autoStash: false,
                keepPlan: false,
              });
              if (parsed.unsupported.length > 0) {
                post({ type: 'error', message: unsupportedMessage() });
              }
              break;
            case 'start':
              // Steps the editor does not show would be lost on writing.
              if (parsed.unsupported.length > 0) {
                post({ type: 'error', message: unsupportedMessage() });
                return;
              }
              await handBack(serializeTodo(message.plan, parsed));
              break;
            case 'cancel':
              await handBack('');
              break;
          }
        } catch (error) {
          this.log(`rebase todo editor: ${errorMessage(error)}`);
          post({ type: 'error', message: errorMessage(error) });
        }
      },
    );
    panel.onDidDispose(() => subscription.dispose());
  }
}

function enabled(): boolean {
  return rebaseEditorEnabled(
    vscode.workspace.getConfiguration('gitglasses').inspect<boolean>('rebaseEditor.enabled'),
  );
}

// Keeps the user's editor association for git's todo in line with the
// setting: added when it is turned on, and only our own entry removed when
// it is turned off.
async function syncEditorAssociation(): Promise<void> {
  const workbench = vscode.workspace.getConfiguration('workbench');
  const current = workbench.inspect<Record<string, string>>('editorAssociations')?.globalValue;
  const next = editorAssociationsFor(current, enabled(), REBASE_TODO_VIEW_TYPE);
  if (!next) return;
  await workbench.update(
    'editorAssociations',
    Object.keys(next).length > 0 ? next : undefined,
    vscode.ConfigurationTarget.Global,
  );
}

export function registerRebaseTodoEditor(
  context: vscode.ExtensionContext,
  log: LogFn,
): vscode.Disposable[] {
  const sync = (): void => {
    void syncEditorAssociation().catch((error) =>
      log(`cannot update the editor association for git-rebase-todo: ${errorMessage(error)}`),
    );
  };
  // Writes only when the association disagrees with the setting.
  sync();
  return [
    vscode.window.registerCustomEditorProvider(
      REBASE_TODO_VIEW_TYPE,
      new RebaseTodoEditorProvider(context, log),
      { webviewOptions: { retainContextWhenHidden: true } },
    ),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('gitglasses.rebaseEditor.enabled')) sync();
    }),
  ];
}
