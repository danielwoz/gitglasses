import * as vscode from 'vscode';
import {
  formatFileLensTitle,
  formatLfsLensTitle,
  formatSymbolLensTitle,
  summarizeRange,
} from '../annotations/annotationLogic';
import { DocumentBlameService } from '../annotations/documentBlame';

const SYMBOL_KINDS = new Set<vscode.SymbolKind>([
  vscode.SymbolKind.Function,
  vscode.SymbolKind.Method,
  vscode.SymbolKind.Class,
  vscode.SymbolKind.Constructor,
]);

/** Top-level functions/classes plus methods directly inside top-level types. */
function lensTargets(symbols: vscode.DocumentSymbol[]): vscode.DocumentSymbol[] {
  const targets: vscode.DocumentSymbol[] = [];
  for (const symbol of symbols) {
    if (SYMBOL_KINDS.has(symbol.kind)) targets.push(symbol);
    for (const child of symbol.children) {
      if (SYMBOL_KINDS.has(child.kind)) targets.push(child);
    }
  }
  return targets;
}

const LENS_COMMAND = 'gitglasses.toggleFileBlame';

function lens(range: vscode.Range, title: string): vscode.CodeLens {
  return new vscode.CodeLens(range, { title, command: LENS_COMMAND });
}

// Blame CodeLens above the file and its top-level symbols. Lenses are only
// offered once the file's blame is known, so a file outside any repository,
// an untracked file or a failed blame gets no lens at all rather than one
// that reads like an error.
export class BlameCodeLensProvider implements vscode.CodeLensProvider, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.emitter.event;
  private readonly configListener: vscode.Disposable;

  constructor(private readonly blame: DocumentBlameService) {
    this.configListener = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('gitglasses.codeLens.enabled')) this.emitter.fire();
    });
  }

  /** Controller-level suppression (mode switching); orthogonal to the setting. */
  private suppressed = false;

  /** Re-requests lenses everywhere (after blame invalidation). */
  fire(): void {
    this.emitter.fire();
  }

  isEnabled(): boolean {
    return !this.suppressed;
  }

  /** Deterministic enablement (mode switching); disabled lenses return []. */
  setEnabled(enabled: boolean): void {
    if (this.suppressed === !enabled) return;
    this.suppressed = !enabled;
    this.emitter.fire();
  }

  private enabled(): boolean {
    if (this.suppressed) return false;
    return vscode.workspace.getConfiguration('gitglasses').get<boolean>('codeLens.enabled', true);
  }

  async provideCodeLenses(
    document: vscode.TextDocument,
    token: vscode.CancellationToken,
  ): Promise<vscode.CodeLens[]> {
    if (!this.enabled() || document.uri.scheme !== 'file') return [];
    const result = await this.blame.blameDocument(document, token);
    if (result.kind !== 'blame' || token.isCancellationRequested) return [];
    const fileBlame = result.blame;
    const top = new vscode.Range(0, 0, 0, 0);

    if (fileBlame.lfs) {
      const title = formatLfsLensTitle(fileBlame);
      return title ? [lens(top, title)] : [];
    }

    const lenses: vscode.CodeLens[] = [];
    const fileTitle = formatFileLensTitle(summarizeRange(fileBlame, 1, fileBlame.totalLines));
    if (!fileTitle) return [];
    lenses.push(lens(top, fileTitle));
    try {
      const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
        'vscode.executeDocumentSymbolProvider',
        document.uri,
      );
      if (token.isCancellationRequested) return [];
      for (const symbol of lensTargets(symbols ?? [])) {
        const title = formatSymbolLensTitle(
          summarizeRange(fileBlame, symbol.range.start.line + 1, symbol.range.end.line + 1),
        );
        if (title) lenses.push(lens(symbol.range, title));
      }
    } catch {
      // No symbol provider for this language; the file lens still applies.
    }
    return lenses;
  }

  dispose(): void {
    this.configListener.dispose();
    this.emitter.dispose();
  }
}
