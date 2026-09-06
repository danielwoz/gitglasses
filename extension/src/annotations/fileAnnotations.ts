import * as vscode from 'vscode';
import { BlameModel, FileBlame } from '../model/blameModel';
import { RepositoryService } from '../model/repositoryService';
import {
  computeChangedRanges,
  computeHeatmapRanges,
  continuationLabel,
  formatGutterLabel,
  HEATMAP_COLORS,
} from './annotationLogic';

const RENDER_DEBOUNCE_MS = 300;
const NBSP = '\u00a0';

export type AnnotationMode = 'off' | 'blame' | 'heatmap' | 'changes';

/** Decoration contentText collapses regular spaces; keep alignment with nbsp. */
function toDecorationText(label: string): string {
  return label.replace(/ /g, NBSP);
}

// Whole-file gutter annotations: per-editor 'blame' or 'heatmap' mode, one
// active at a time. Renders from the shared whole-file blame cache and
// re-renders on edits (debounced), editor switches, and invalidation.
export class FileAnnotationsController implements vscode.Disposable {
  private readonly gutterHead = vscode.window.createTextEditorDecorationType({
    before: {
      margin: '0 1em 0 0',
      color: new vscode.ThemeColor('editorCodeLens.foreground'),
    },
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedOpen,
  });
  private readonly gutterTail = vscode.window.createTextEditorDecorationType({
    before: {
      margin: '0 1em 0 0',
      color: new vscode.ThemeColor('editorCodeLens.foreground'),
      textDecoration: 'none; opacity: 0.35',
    },
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedOpen,
  });
  private readonly heatTypes = HEATMAP_COLORS.map((color) =>
    vscode.window.createTextEditorDecorationType({
      borderWidth: '0 0 0 3px',
      borderStyle: 'solid',
      borderColor: color,
      isWholeLine: true,
      rangeBehavior: vscode.DecorationRangeBehavior.ClosedOpen,
    }),
  );

  private readonly changedType = vscode.window.createTextEditorDecorationType({
    borderWidth: '0 0 0 3px',
    borderStyle: 'solid',
    borderColor: new vscode.ThemeColor('editorGutter.modifiedBackground'),
    overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.modifiedForeground'),
    overviewRulerLane: vscode.OverviewRulerLane.Left,
    isWholeLine: true,
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedOpen,
  });

  /** Active mode keyed by document uri (survives tab switches). */
  private modes = new Map<string, AnnotationMode>();
  /** Controller-level switch (mode switching); per-document modes are kept. */
  private enabled = true;
  private debounceTimers = new Map<string, NodeJS.Timeout>();
  private renderCounter = 0;
  private latestRender = new Map<string, number>();
  private disposables: vscode.Disposable[] = [];
  private disposed = false;

  constructor(
    private readonly blame: BlameModel,
    private readonly repos: RepositoryService,
  ) {
    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (editor) void this.render(editor);
      }),
      vscode.window.onDidChangeVisibleTextEditors((editors) => {
        for (const editor of editors) void this.render(editor);
      }),
      vscode.workspace.onDidChangeTextDocument((e) => {
        const key = e.document.uri.toString();
        if (this.getMode(key) === 'off') return;
        clearTimeout(this.debounceTimers.get(key));
        this.debounceTimers.set(
          key,
          setTimeout(() => {
            this.debounceTimers.delete(key);
            this.refreshDocument(e.document);
          }, RENDER_DEBOUNCE_MS),
        );
      }),
    );
  }

  private getMode(uriKey: string): AnnotationMode {
    return this.modes.get(uriKey) ?? 'off';
  }

  /** Toggles the mode for the active editor; switching clears the other mode. */
  toggle(mode: 'blame' | 'heatmap' | 'changes'): void {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.scheme !== 'file') return;
    const key = editor.document.uri.toString();
    const next: AnnotationMode = this.getMode(key) === mode ? 'off' : mode;
    if (next === 'off') this.modes.delete(key);
    else this.modes.set(key, next);
    void this.render(editor);
  }

  /** Clears annotations in the active editor. */
  clear(): void {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    this.modes.delete(editor.document.uri.toString());
    this.clearDecorations(editor);
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /** Deterministic enablement (mode switching); disabling clears every editor. */
  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    if (this.enabled) this.refresh();
    else for (const editor of vscode.window.visibleTextEditors) this.clearDecorations(editor);
  }

  /** Sets the annotation mode for an editor's document and renders (mode switching). */
  setDocumentMode(editor: vscode.TextEditor, mode: AnnotationMode): void {
    if (editor.document.uri.scheme !== 'file') return;
    const key = editor.document.uri.toString();
    if (mode === 'off') this.modes.delete(key);
    else this.modes.set(key, mode);
    void this.render(editor);
  }

  /** Re-renders every visible editor (after blame invalidation). */
  refresh(): void {
    for (const editor of vscode.window.visibleTextEditors) void this.render(editor);
  }

  private refreshDocument(document: vscode.TextDocument): void {
    for (const editor of vscode.window.visibleTextEditors) {
      if (editor.document === document) void this.render(editor);
    }
  }

  private async render(editor: vscode.TextEditor): Promise<void> {
    if (this.disposed) return;
    const document = editor.document;
    if (document.uri.scheme !== 'file') return;
    const key = document.uri.toString();
    const mode = this.getMode(key);
    if (!this.enabled || mode === 'off') {
      this.clearDecorations(editor);
      return;
    }

    const renderId = ++this.renderCounter;
    this.latestRender.set(key, renderId);
    const version = document.version;

    const located = await this.repos.locateOrDiscover(document.uri);
    if (!located) {
      this.clearDecorations(editor);
      return;
    }

    let fileBlame: FileBlame;
    try {
      fileBlame = await this.blame.getBlame({
        repoId: located.repoId,
        path: located.relativePath,
        version: document.isDirty ? version : -1,
      });
    } catch {
      return;
    }

    // Drop stale renders: a newer pass for this document supersedes us, and an
    // edited buffer will re-render via the debounced change handler.
    if (this.latestRender.get(key) !== renderId || document.version !== version) return;
    if (!vscode.window.visibleTextEditors.includes(editor)) return;
    // Disposal can land while the blame request is in flight; the decoration
    // types are gone by then.
    if (this.disposed) return;

    if (mode === 'blame') this.applyGutterBlame(editor, fileBlame);
    else if (mode === 'changes') this.applyChanges(editor, fileBlame);
    else this.applyHeatmap(editor, fileBlame);
  }

  private applyChanges(editor: vscode.TextEditor, fileBlame: FileBlame): void {
    editor.setDecorations(this.gutterHead, []);
    editor.setDecorations(this.gutterTail, []);
    for (const type of this.heatTypes) editor.setDecorations(type, []);

    const lineCount = editor.document.lineCount;
    const ranges: vscode.Range[] = [];
    for (const { startLine, lineCount: runLines } of computeChangedRanges(fileBlame)) {
      const first = startLine - 1;
      if (first >= lineCount) continue;
      const last = Math.min(first + runLines - 1, lineCount - 1);
      ranges.push(new vscode.Range(first, 0, last, 0));
    }
    editor.setDecorations(this.changedType, ranges);
  }

  private applyGutterBlame(editor: vscode.TextEditor, fileBlame: FileBlame): void {
    for (const type of this.heatTypes) editor.setDecorations(type, []);
    editor.setDecorations(this.changedType, []);

    const lineCount = editor.document.lineCount;
    const heads: vscode.DecorationOptions[] = [];
    const tails: vscode.DecorationOptions[] = [];
    const tailText = toDecorationText(continuationLabel());

    for (const hunk of fileBlame.hunks) {
      const firstLine = hunk.resultLine - 1;
      if (firstLine >= lineCount) continue;
      heads.push({
        range: new vscode.Range(firstLine, 0, firstLine, 0),
        renderOptions: {
          before: { contentText: toDecorationText(formatGutterLabel(hunk, fileBlame.commits)) },
        },
      });
      const lastLine = Math.min(firstLine + hunk.lineCount - 1, lineCount - 1);
      for (let line = firstLine + 1; line <= lastLine; line++) {
        tails.push({
          range: new vscode.Range(line, 0, line, 0),
          renderOptions: { before: { contentText: tailText } },
        });
      }
    }
    editor.setDecorations(this.gutterHead, heads);
    editor.setDecorations(this.gutterTail, tails);
  }

  private applyHeatmap(editor: vscode.TextEditor, fileBlame: FileBlame): void {
    editor.setDecorations(this.gutterHead, []);
    editor.setDecorations(this.gutterTail, []);
    editor.setDecorations(this.changedType, []);

    const lineCount = editor.document.lineCount;
    const byBucket: vscode.Range[][] = this.heatTypes.map(() => []);
    for (const { startLine, lineCount: hunkLines, bucket } of computeHeatmapRanges(fileBlame)) {
      const first = startLine - 1;
      if (first >= lineCount) continue;
      const last = Math.min(first + hunkLines - 1, lineCount - 1);
      byBucket[bucket]?.push(new vscode.Range(first, 0, last, 0));
    }
    this.heatTypes.forEach((type, i) => editor.setDecorations(type, byBucket[i] ?? []));
  }

  private clearDecorations(editor: vscode.TextEditor): void {
    editor.setDecorations(this.gutterHead, []);
    editor.setDecorations(this.gutterTail, []);
    editor.setDecorations(this.changedType, []);
    for (const type of this.heatTypes) editor.setDecorations(type, []);
  }

  dispose(): void {
    this.disposed = true;
    for (const timer of this.debounceTimers.values()) clearTimeout(timer);
    this.gutterHead.dispose();
    this.gutterTail.dispose();
    this.changedType.dispose();
    for (const type of this.heatTypes) type.dispose();
    for (const d of this.disposables) d.dispose();
    this.latestRender.clear();
  }
}
