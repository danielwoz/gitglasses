import * as vscode from 'vscode';
import { UNCOMMITTED_SHA } from '@gitglasses/protocol';
import { BlameModel, FileBlame } from '../model/blameModel';
import { RepositoryService } from '../model/repositoryService';
import { relativeTime } from '../system/dates';

const CURSOR_DEBOUNCE_MS = 75;

// Inline current-line blame + status bar item. One in-flight cancellation
// token per editor: a new cursor position or edit cancels the stale request.
export class LineBlameController implements vscode.Disposable {
  private readonly decoration = vscode.window.createTextEditorDecorationType({
    after: {
      margin: '0 0 0 3em',
      color: new vscode.ThemeColor('editorCodeLens.foreground'),
    },
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedOpen,
  });
  private readonly statusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100,
  );
  private timer: NodeJS.Timeout | undefined;
  private cts: vscode.CancellationTokenSource | undefined;
  private disposables: vscode.Disposable[] = [];
  private enabled = true;

  constructor(
    private readonly blame: BlameModel,
    private readonly repos: RepositoryService,
  ) {
    this.disposables.push(
      vscode.window.onDidChangeTextEditorSelection((e) => this.schedule(e.textEditor)),
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        this.clear();
        if (editor) this.schedule(editor);
      }),
      vscode.workspace.onDidChangeTextDocument((e) => {
        const editor = vscode.window.activeTextEditor;
        if (editor?.document === e.document) this.schedule(editor);
      }),
    );
  }

  toggle(): void {
    this.setEnabled(!this.enabled);
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /** Deterministic enablement (mode switching); disabling hides the status bar too. */
  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    if (!this.enabled) this.clear();
    else if (vscode.window.activeTextEditor) this.schedule(vscode.window.activeTextEditor);
  }

  refresh(): void {
    if (vscode.window.activeTextEditor) this.schedule(vscode.window.activeTextEditor);
  }

  private schedule(editor: vscode.TextEditor): void {
    if (!this.enabled || editor.document.uri.scheme !== 'file') return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.annotate(editor), CURSOR_DEBOUNCE_MS);
  }

  private async annotate(editor: vscode.TextEditor): Promise<void> {
    this.cts?.cancel();
    this.cts = new vscode.CancellationTokenSource();
    const token = this.cts.token;

    const document = editor.document;
    const line = editor.selection.active.line; // 0-based
    const version = document.version;

    const located = await this.repos.locateOrDiscover(document.uri);
    if (!located || token.isCancellationRequested) return;

    let fileBlame: FileBlame;
    try {
      fileBlame = await this.blame.getBlame(
        {
          repoId: located.repoId,
          path: located.relativePath,
          // Dirty buffers blame via the overlay; version keys the cache. The
          // overlay push is debounced, so a very fresh edit may briefly show
          // the previous result — the next annotate pass corrects it.
          version: document.isDirty ? version : -1,
        },
        token,
      );
    } catch {
      this.clear();
      return;
    }

    // Drop stale results: editor, line, and version must still match.
    if (
      token.isCancellationRequested ||
      vscode.window.activeTextEditor !== editor ||
      editor.selection.active.line !== line ||
      document.version !== version
    ) {
      return;
    }

    const hunk = this.blame.hunkForLine(fileBlame, line + 1);
    if (!hunk) {
      this.clear();
      return;
    }

    let text: string;
    let statusText: string;
    if (hunk.sha === UNCOMMITTED_SHA) {
      text = 'You • uncommitted changes';
      statusText = '$(edit) Uncommitted';
    } else {
      const commit = fileBlame.commits[hunk.sha];
      const author = commit?.author.name ?? 'Unknown';
      const when = commit ? relativeTime(commit.author.time) : '';
      const summary = commit?.summary ?? '';
      text = `${author}, ${when} • ${summary}`;
      statusText = `$(git-commit) ${author}, ${when}`;
    }

    const range = document.lineAt(line).range;
    editor.setDecorations(this.decoration, [
      { range, renderOptions: { after: { contentText: text } } },
    ]);
    this.statusBar.text = statusText;
    this.statusBar.tooltip = hunk.sha === UNCOMMITTED_SHA ? undefined : hunk.sha;
    this.statusBar.show();
  }

  private clear(): void {
    vscode.window.activeTextEditor?.setDecorations(this.decoration, []);
    this.statusBar.hide();
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.cts?.cancel();
    this.decoration.dispose();
    this.statusBar.dispose();
    for (const d of this.disposables) d.dispose();
  }
}
