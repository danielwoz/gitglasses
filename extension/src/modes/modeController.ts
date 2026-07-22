import * as vscode from 'vscode';
import {
  FeatureStates,
  INITIAL_MODE_STATE,
  Mode,
  ModeState,
  isMode,
  statusBarText,
  switchMode,
} from './modeLogic';

/** Controller-level enable/disable hook exposed by an annotation feature. */
export interface FeatureToggle {
  isEnabled(): boolean;
  setEnabled(enabled: boolean): void;
}

/** File annotations additionally support forcing gutter blame per editor. */
export interface FileAnnotationHooks extends FeatureToggle {
  setDocumentMode(editor: vscode.TextEditor, mode: 'blame'): void;
}

const MODE_ITEMS: Array<{ mode: Mode; label: string; description: string }> = [
  { mode: 'normal', label: '$(circle-outline) Normal', description: 'Annotations follow their settings' },
  { mode: 'zen', label: '$(eye) Zen', description: 'Hide blame, annotations, and CodeLens' },
  { mode: 'review', label: '$(checklist) Review', description: 'Force gutter blame in editors' },
];

// Applies the gitglasses.mode setting: zen suppresses every annotation
// feature, review forces gutter blame on, and returning to normal restores
// whatever was enabled before. Persisted via the setting (workspace scope)
// so it applies live on config change, including from the settings UI.
export class ModeController implements vscode.Disposable {
  private state: ModeState = INITIAL_MODE_STATE;
  private readonly statusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    95,
  );
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly lineBlame: FeatureToggle,
    private readonly fileAnnotations: FileAnnotationHooks,
    private readonly codeLens: FeatureToggle,
  ) {
    this.statusBar.name = 'GitGlasses Mode';
    this.statusBar.command = 'gitglasses.switchMode';
    this.disposables.push(
      vscode.commands.registerCommand('gitglasses.switchMode', () => this.pickMode()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('gitglasses.mode')) this.apply(this.configuredMode());
      }),
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (this.state.mode === 'review' && editor && editor.document.uri.scheme === 'file') {
          this.fileAnnotations.setDocumentMode(editor, 'blame');
        }
      }),
    );
    this.apply(this.configuredMode());
  }

  get mode(): Mode {
    return this.state.mode;
  }

  private configuredMode(): Mode {
    const raw = vscode.workspace.getConfiguration('gitglasses').get<string>('mode', 'normal');
    return isMode(raw) ? raw : 'normal';
  }

  private apply(next: Mode): void {
    const current: FeatureStates = {
      lineBlame: this.lineBlame.isEnabled(),
      fileAnnotations: this.fileAnnotations.isEnabled(),
      codeLens: this.codeLens.isEnabled(),
    };
    const { state, effects } = switchMode(this.state, next, current);
    this.state = state;
    if (effects.apply) {
      this.lineBlame.setEnabled(effects.apply.lineBlame);
      this.fileAnnotations.setEnabled(effects.apply.fileAnnotations);
      this.codeLens.setEnabled(effects.apply.codeLens);
    }
    if (effects.forceGutterBlame) {
      const editor = vscode.window.activeTextEditor;
      if (editor && editor.document.uri.scheme === 'file') {
        this.fileAnnotations.setDocumentMode(editor, 'blame');
      }
    }
    const text = statusBarText(state.mode);
    if (text) {
      this.statusBar.text = text;
      this.statusBar.tooltip = `GitGlasses mode: ${state.mode} — click to switch`;
      this.statusBar.show();
    } else {
      this.statusBar.hide();
    }
  }

  private async pickMode(): Promise<void> {
    const active = this.state.mode;
    const picked = await vscode.window.showQuickPick(
      MODE_ITEMS.map((item) => ({
        ...item,
        description: item.mode === active ? `${item.description} (current)` : item.description,
      })),
      { placeHolder: 'Switch GitGlasses mode' },
    );
    if (!picked) return;
    const config = vscode.workspace.getConfiguration('gitglasses');
    try {
      await config.update('mode', picked.mode, vscode.ConfigurationTarget.Workspace);
    } catch {
      // No workspace open: fall back to the user scope.
      await config.update('mode', picked.mode, vscode.ConfigurationTarget.Global);
    }
    // The config listener applies the switch; applying again here is a no-op
    // but covers hosts that do not emit an event for same-value updates.
    this.apply(picked.mode);
  }

  dispose(): void {
    this.statusBar.dispose();
    for (const d of this.disposables) d.dispose();
  }
}
