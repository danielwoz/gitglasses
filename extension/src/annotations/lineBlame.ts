import * as vscode from 'vscode';
import { UNCOMMITTED_SHA } from '@gitglasses/protocol';
import { lineBlameText } from './blameFormat';
import { BUILTIN_STATUS_BAR_BLAME, statusBarVisible } from './blameSettings';
import { DocumentBlameService } from './documentBlame';
import { BlameHoverRenderer } from './hoverProvider';
import { SHOW_COMMIT_DETAILS_COMMAND, DIFF_WITH_HEAD_COMMAND } from './blameHoverLogic';

const CURSOR_DEBOUNCE_MS = 75;
/** After an edit, so typing does not blame every keystroke's buffer. */
const EDIT_DEBOUNCE_MS = 300;

/** Internal command returning what the current-line blame shows, for tests
 *  and bug reports. */
export const LINE_BLAME_STATE_COMMAND = '_gitglasses.lineBlameState';

export interface LineBlameState {
  uri: string;
  /** 0-based line annotated. */
  line: number;
  inline: string;
  statusBar: string;
  statusBarVisible: boolean;
}

const PAUSED_INLINE = 'GitGlasses: blame paused, unsaved changes too large to blame';
const PAUSED_TOOLTIP =
  'The unsaved changes in this file are over the 8 MB GitGlasses can blame, so line blame ' +
  'is paused. Save the file to see blame again.';

// Inline current-line blame + status bar item. One in-flight cancellation
// token per editor: a new cursor position or edit cancels the stale request.
// Shown while `gitglasses.currentLine.enabled` is on and no mode suppresses
// it; the status bar item also follows `gitglasses.statusBar.blame`.
export class LineBlameController implements vscode.Disposable {
  private readonly decoration = vscode.window.createTextEditorDecorationType({
    after: {
      margin: '0 0 0 3em',
      color: new vscode.ThemeColor('editorCodeLens.foreground'),
    },
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedOpen,
  });
  private readonly statusBar = vscode.window.createStatusBarItem(
    'gitglasses.blame',
    vscode.StatusBarAlignment.Right,
    100,
  );
  private timer: ReturnType<typeof setTimeout> | undefined;
  private cts: vscode.CancellationTokenSource | undefined;
  private disposables: vscode.Disposable[] = [];
  /** The gitglasses.currentLine.enabled setting. */
  private configured: boolean;
  /** Controller-level suppression (mode switching); orthogonal to the setting. */
  private suppressed = false;
  private lastEditAt = 0;
  private state: LineBlameState | undefined;

  constructor(
    private readonly blame: DocumentBlameService,
    private readonly renderer: BlameHoverRenderer,
  ) {
    this.statusBar.name = 'GitGlasses Blame';
    this.configured = blame.settings.currentLineEnabled;
    this.disposables.push(
      vscode.window.onDidChangeTextEditorSelection((e) => this.schedule(e.textEditor)),
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        this.clear();
        if (editor) this.schedule(editor);
      }),
      vscode.workspace.onDidChangeTextDocument((e) => {
        const editor = vscode.window.activeTextEditor;
        if (editor?.document !== e.document) return;
        this.lastEditAt = Date.now();
        this.schedule(editor);
      }),
      blame.onDidChangeSettings(() => {
        const configured = blame.settings.currentLineEnabled;
        if (configured !== this.configured) {
          this.configured = configured;
          if (!this.active()) this.clear();
        }
        this.refresh();
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration(BUILTIN_STATUS_BAR_BLAME)) this.refresh();
      }),
      vscode.commands.registerCommand(LINE_BLAME_STATE_COMMAND, () => this.state),
    );
  }

  /** Flips gitglasses.currentLine.enabled, in the scope that sets it. */
  async toggle(): Promise<void> {
    const config = vscode.workspace.getConfiguration('gitglasses');
    const inspected = config.inspect<boolean>('currentLine.enabled');
    const target =
      inspected?.workspaceValue !== undefined
        ? vscode.ConfigurationTarget.Workspace
        : vscode.ConfigurationTarget.Global;
    this.configured = !this.configured;
    if (!this.active()) this.clear();
    else this.refresh();
    await config.update('currentLine.enabled', this.configured, target);
  }

  isEnabled(): boolean {
    return !this.suppressed;
  }

  /** Deterministic enablement (mode switching); disabling hides the status bar too. */
  setEnabled(enabled: boolean): void {
    if (this.suppressed === !enabled) return;
    this.suppressed = !enabled;
    if (!this.active()) this.clear();
    else this.refresh();
  }

  refresh(): void {
    if (vscode.window.activeTextEditor) this.schedule(vscode.window.activeTextEditor);
  }

  private active(): boolean {
    return this.configured && !this.suppressed;
  }

  private statusBarShown(): boolean {
    return statusBarVisible(
      this.blame.settings.statusBar,
      vscode.workspace.getConfiguration().get(BUILTIN_STATUS_BAR_BLAME),
    );
  }

  private schedule(editor: vscode.TextEditor): void {
    if (!this.active() || !this.blame.supports(editor.document)) return;
    clearTimeout(this.timer);
    const sinceEdit = Date.now() - this.lastEditAt;
    const wait = sinceEdit < EDIT_DEBOUNCE_MS ? EDIT_DEBOUNCE_MS - sinceEdit : CURSOR_DEBOUNCE_MS;
    this.timer = setTimeout(() => void this.annotate(editor), Math.max(wait, CURSOR_DEBOUNCE_MS));
  }

  private async annotate(editor: vscode.TextEditor): Promise<void> {
    this.cts?.cancel();
    this.cts?.dispose();
    this.cts = new vscode.CancellationTokenSource();
    const token = this.cts.token;

    const document = editor.document;
    const line = editor.selection.active.line; // 0-based
    const version = document.version;

    const result = await this.blame.blameDocument(document, token);

    // Drop stale results: editor, line, and version must still match.
    if (
      token.isCancellationRequested ||
      !this.active() ||
      vscode.window.activeTextEditor !== editor ||
      editor.selection.active.line !== line ||
      document.version !== version
    ) {
      return;
    }

    const range = document.lineAt(line).range;
    const showStatus = this.statusBarShown();
    if (result.kind === 'tooLarge') {
      this.paint(editor, range, PAUSED_INLINE);
      this.statusBar.text = '$(warning) Blame paused';
      this.statusBar.tooltip = PAUSED_TOOLTIP;
      this.statusBar.command = undefined;
      this.setState(document, line, PAUSED_INLINE, this.statusBar.text, showStatus);
      return;
    }
    const text =
      result.kind === 'blame'
        ? lineBlameText(result.blame, line + 1, this.blame.settings.text)
        : undefined;
    if (result.kind !== 'blame' || !text) {
      this.clear();
      return;
    }

    this.paint(editor, range, text.inline);
    this.statusBar.text = text.statusBar;
    if (text.sha && text.sha !== UNCOMMITTED_SHA && result.target.rootPath !== '') {
      this.statusBar.command = {
        title: 'Show Commit Details',
        command: SHOW_COMMIT_DETAILS_COMMAND,
        arguments: [{ repoPath: result.target.rootPath, sha: text.sha }],
      };
    } else if (!text.sha && result.target.rev === undefined) {
      this.statusBar.command = { title: 'Open Changes', command: DIFF_WITH_HEAD_COMMAND };
    } else {
      this.statusBar.command = undefined;
    }
    this.statusBar.tooltip = undefined;
    this.setState(document, line, text.inline, text.statusBar, showStatus);
    // The tooltip shows what the hover shows; it fills in once the commit's
    // full message is known.
    const blame = result.blame;
    const target = result.target;
    void this.renderer.render(blame, target, line + 1, token).then((tooltip) => {
      if (!token.isCancellationRequested && tooltip) this.statusBar.tooltip = tooltip;
    });
  }

  private paint(editor: vscode.TextEditor, range: vscode.Range, contentText: string): void {
    editor.setDecorations(this.decoration, [{ range, renderOptions: { after: { contentText } } }]);
  }

  private setState(
    document: vscode.TextDocument,
    line: number,
    inline: string,
    statusBar: string,
    showStatus: boolean,
  ): void {
    this.state = {
      uri: document.uri.toString(),
      line,
      inline,
      statusBar,
      statusBarVisible: showStatus,
    };
    if (showStatus) this.statusBar.show();
    else this.statusBar.hide();
  }

  /** Clears the active editor, which is not necessarily the editor the caller
   *  is annotating: a stale pass reaching here has already lost its editor to
   *  an active-editor change. */
  private clear(): void {
    vscode.window.activeTextEditor?.setDecorations(this.decoration, []);
    this.statusBar.hide();
    this.state = undefined;
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.cts?.dispose();
    this.decoration.dispose();
    this.statusBar.dispose();
    for (const d of this.disposables) d.dispose();
  }
}
