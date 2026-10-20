// The rebase editor as a custom editor for the todo list `git rebase -i`
// hands its sequence editor, for rebases started outside GitGlasses (in a
// terminal, with VS Code as git's editor). It opens on its own when
// gitglasses.rebaseEditor.enabled is set, through a
// workbench.editorAssociations entry for the todo file: `code --wait`
// returns as soon as any editor of the file closes, so the todo has to open
// in this editor directly rather than be reopened in it. Save and Continue
// writes the reordered list back and closes the editor, which hands it to
// git; Cancel Rebase hands git an empty list, and for a rebase already
// under way (`git rebase --edit-todo`) Close leaves the list as it is. A
// list that changed on disk since the editor opened it has been taken by git
// already and is never written over.

import * as vscode from 'vscode';
import { renderWebviewHtml } from './webviewHtml';
import {
  editorAssociationsFor,
  isRebaseUnderWay,
  parseTodo,
  rebaseEditorEnabled,
  serializeTodo,
  todoUnchanged,
  unsupportedStepsMessage,
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
    const opened = document.getText();
    const underWay = this.readText(vscode.Uri.joinPath(document.uri, '..', 'done')).then(
      isRebaseUnderWay,
    );
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
    const unsupportedMessage = async (): Promise<string> =>
      unsupportedStepsMessage(parsed.unsupported, await underWay);

    // Writing the list (when there is one to write) and closing the editor
    // hands it back to git.
    const handBack = async (text: string | undefined): Promise<void> => {
      if (text === undefined) {
        panel.dispose();
        return;
      }
      if (!todoUnchanged(opened, await this.readText(document.uri))) {
        throw new Error(
          'The list changed on disk since this editor opened it: git has already gone on with the rebase, so nothing was written.',
        );
      }
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
                underWay: await underWay,
              });
              if (parsed.unsupported.length > 0) {
                post({ type: 'error', message: await unsupportedMessage() });
              }
              break;
            case 'start':
              // Steps the editor does not show would be lost on writing.
              if (parsed.unsupported.length > 0) {
                post({ type: 'error', message: await unsupportedMessage() });
                return;
              }
              await handBack(serializeTodo(message.plan, parsed));
              break;
            case 'cancel':
              // An empty list stops a rebase that has not started, but would
              // drop the rest of one already under way.
              await handBack((await underWay) ? undefined : '');
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

  // A file's text, or undefined when it cannot be read (a missing file is
  // expected: git removes its rebase state as the rebase ends).
  private async readText(uri: vscode.Uri): Promise<string | undefined> {
    try {
      return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
    } catch (error) {
      if (!(error instanceof vscode.FileSystemError && error.code === 'FileNotFound')) {
        this.log(`rebase todo editor: cannot read ${uri.fsPath}: ${errorMessage(error)}`);
      }
      return undefined;
    }
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
