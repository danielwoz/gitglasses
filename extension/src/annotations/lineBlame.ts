import * as vscode from 'vscode';
import { UNCOMMITTED_SHA } from '@gitglasses/protocol';
import { lineBlameText } from './blameFormat';
import {
  BUILTIN_GIT_ENABLED,
  BUILTIN_GIT_EXTENSION,
  BUILTIN_STATUS_BAR_BLAME,
  builtinStatusBarBlameOn,
  LineBlameSurfaces,
  lineBlameSurfaces,
  statusBarVisible,
} from './blameSettings';
import { DocumentBlameService } from './documentBlame';
import { BlameHoverRenderer } from './hoverProvider';
import {
  DIFF_WITH_HEAD_COMMAND,
  DiffWithHeadArgs,
  SHOW_COMMIT_DETAILS_COMMAND,
} from './blameHoverLogic';

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
  /** The inline text is painted (gitglasses.currentLine.enabled). */
  inlineVisible: boolean;
  statusBar: string;
  statusBarVisible: boolean;
}

const PAUSED_INLINE = 'GitGlasses: blame paused, unsaved changes too large to blame';
const PAUSED_TOOLTIP =
  'The unsaved changes in this file are over the 8 MB GitGlasses can blame, so line blame ' +
  'is paused. Save the file to see blame again.';

// Current-line blame, after the end of the line and in the status bar. One
// in-flight cancellation token per editor: a new cursor position or edit
// cancels the stale request. The inline text follows
// `gitglasses.currentLine.enabled` and the status bar item
// `gitglasses.statusBar.blame`, each on its own; a mode that suppresses
// current-line blame hides both.
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
        this.configured = blame.settings.currentLineEnabled;
        this.surfacesChanged();
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (
          e.affectsConfiguration(BUILTIN_STATUS_BAR_BLAME) ||
          e.affectsConfiguration(BUILTIN_GIT_ENABLED)
        ) {
          this.surfacesChanged();
        }
      }),
      // VS Code's own Git extension enabled or disabled.
      vscode.extensions.onDidChange(() => this.surfacesChanged()),
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
    this.surfacesChanged();
    await config.update('currentLine.enabled', this.configured, target);
  }

  isEnabled(): boolean {
    return !this.suppressed;
  }

  /** Deterministic enablement (mode switching); disabling hides the status bar too. */
  setEnabled(enabled: boolean): void {
    if (this.suppressed === !enabled) return;
    this.suppressed = !enabled;
    this.surfacesChanged();
  }

  refresh(): void {
    if (vscode.window.activeTextEditor) this.schedule(vscode.window.activeTextEditor);
  }

  private surfaces(): LineBlameSurfaces {
    const builtinOn = builtinStatusBarBlameOn({
      extensionPresent: vscode.extensions.getExtension(BUILTIN_GIT_EXTENSION) !== undefined,
      gitEnabled: vscode.workspace.getConfiguration().get(BUILTIN_GIT_ENABLED),
      statusBarItem: vscode.workspace.getConfiguration().get(BUILTIN_STATUS_BAR_BLAME),
    });
    return lineBlameSurfaces(
      this.configured,
      statusBarVisible(this.blame.settings.statusBar, builtinOn),
      this.suppressed,
    );
  }

  /** Hides what is no longer wanted at once, and repaints the rest. */
  private surfacesChanged(): void {
    const surfaces = this.surfaces();
    if (!surfaces.inline && !surfaces.statusBar) {
      this.clear();
      return;
    }
    if (!surfaces.inline) this.clearInline();
    if (!surfaces.statusBar) this.statusBar.hide();
    this.refresh();
  }

  private schedule(editor: vscode.TextEditor): void {
    const surfaces = this.surfaces();
    if ((!surfaces.inline && !surfaces.statusBar) || !this.blame.supports(editor.document)) {
      return;
    }
    clearTimeout(this.timer);
    const delay = this.blame.settings.currentLineDelay;
    const sinceEdit = Date.now() - this.lastEditAt;
    const wait = sinceEdit < EDIT_DEBOUNCE_MS ? EDIT_DEBOUNCE_MS - sinceEdit : delay;
    this.timer = setTimeout(() => void this.annotate(editor), Math.max(wait, delay));
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
    const surfaces = this.surfaces();
    if (
      token.isCancellationRequested ||
      (!surfaces.inline && !surfaces.statusBar) ||
      vscode.window.activeTextEditor !== editor ||
      editor.selection.active.line !== line ||
      document.version !== version
    ) {
      return;
    }

    const range = document.lineAt(line).range;
    if (result.kind === 'tooLarge') {
      this.paint(editor, range, PAUSED_INLINE, surfaces);
      this.statusBar.text = '$(warning) Blame paused';
      this.statusBar.tooltip = PAUSED_TOOLTIP;
      this.statusBar.command = undefined;
      this.setState(document, line, PAUSED_INLINE, this.statusBar.text, surfaces);
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

    this.paint(editor, range, text.inline, surfaces);
    this.statusBar.text = text.statusBar;
    if (text.sha && text.sha !== UNCOMMITTED_SHA && result.target.rootPath !== '') {
      this.statusBar.command = {
        title: 'Show Commit Details',
        command: SHOW_COMMIT_DETAILS_COMMAND,
        arguments: [{ repoPath: result.target.rootPath, sha: text.sha }],
      };
    } else if (!text.sha && result.target.rev === undefined) {
      const args: DiffWithHeadArgs = { uri: document.uri.toString() };
      this.statusBar.command = {
        title: 'Open Changes',
        command: DIFF_WITH_HEAD_COMMAND,
        arguments: [args],
      };
    } else {
      this.statusBar.command = undefined;
    }
    this.statusBar.tooltip = undefined;
    this.setState(document, line, text.inline, text.statusBar, surfaces);
    if (!surfaces.statusBar) return;
    // The tooltip shows what the hover shows; it fills in once the commit's
    // full message is known. It costs a commit/details request, so it is
    // only rendered while the item shows.
    const blame = result.blame;
    const target = result.target;
    void this.renderer.render(blame, target, line + 1, token).then((tooltip) => {
      if (!token.isCancellationRequested && tooltip) this.statusBar.tooltip = tooltip;
    });
  }

  private paint(
    editor: vscode.TextEditor,
    range: vscode.Range,
    contentText: string,
    surfaces: LineBlameSurfaces,
  ): void {
    if (!surfaces.inline) {
      editor.setDecorations(this.decoration, []);
      return;
    }
    editor.setDecorations(this.decoration, [{ range, renderOptions: { after: { contentText } } }]);
  }

  private setState(
    document: vscode.TextDocument,
    line: number,
    inline: string,
    statusBar: string,
    surfaces: LineBlameSurfaces,
  ): void {
    this.state = {
      uri: document.uri.toString(),
      line,
      inline,
      inlineVisible: surfaces.inline,
      statusBar,
      statusBarVisible: surfaces.statusBar,
    };
    if (surfaces.statusBar) this.statusBar.show();
    else this.statusBar.hide();
  }

  /** Clears the active editor, which is not necessarily the editor the caller
   *  is annotating: a stale pass reaching here has already lost its editor to
   *  an active-editor change. */
  private clearInline(): void {
    vscode.window.activeTextEditor?.setDecorations(this.decoration, []);
  }

  private clear(): void {
    this.clearInline();
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
