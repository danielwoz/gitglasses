import * as vscode from 'vscode';
import { BlameModel, FileBlame } from '../model/blameModel';
import { RepositoryService } from '../model/repositoryService';
import {
  formatFileLensTitle,
  formatSymbolLensTitle,
  summarizeRange,
} from '../annotations/annotationLogic';

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

class BlameLens extends vscode.CodeLens {
  constructor(
    range: vscode.Range,
    public readonly document: vscode.TextDocument,
    public readonly kind: 'file' | 'symbol',
  ) {
    super(range);
  }
}

// Two-phase blame CodeLens: provideCodeLenses returns placement ranges fast
// (file header + top-level symbols); resolveCodeLens fills titles from the
// shared whole-file blame cache.
export class BlameCodeLensProvider implements vscode.CodeLensProvider, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.emitter.event;
  private readonly configListener: vscode.Disposable;

  constructor(
    private readonly blame: BlameModel,
    private readonly repos: RepositoryService,
  ) {
    this.configListener = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('gitglasses.codeLens.enabled')) this.emitter.fire();
    });
  }

  /** Re-requests lenses everywhere (after blame invalidation). */
  fire(): void {
    this.emitter.fire();
  }

  private enabled(): boolean {
    return vscode.workspace.getConfiguration('gitglasses').get<boolean>('codeLens.enabled', true);
  }

  async provideCodeLenses(
    document: vscode.TextDocument,
    token: vscode.CancellationToken,
  ): Promise<vscode.CodeLens[]> {
    if (!this.enabled() || document.uri.scheme !== 'file') return [];

    const lenses: vscode.CodeLens[] = [
      new BlameLens(new vscode.Range(0, 0, 0, 0), document, 'file'),
    ];
    try {
      const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
        'vscode.executeDocumentSymbolProvider',
        document.uri,
      );
      if (token.isCancellationRequested) return [];
      for (const symbol of lensTargets(symbols ?? [])) {
        lenses.push(new BlameLens(symbol.range, document, 'symbol'));
      }
    } catch {
      // No symbol provider for this language; the file lens still applies.
    }
    return lenses;
  }

  async resolveCodeLens(
    lens: vscode.CodeLens,
    token: vscode.CancellationToken,
  ): Promise<vscode.CodeLens> {
    if (!(lens instanceof BlameLens)) return lens;

    let title = 'Blame unavailable';
    try {
      const fileBlame = await this.blameFor(lens.document, token);
      if (fileBlame) {
        if (lens.kind === 'file') {
          const summary = summarizeRange(fileBlame, 1, fileBlame.totalLines);
          title = formatFileLensTitle(summary);
        } else {
          const summary = summarizeRange(
            fileBlame,
            lens.range.start.line + 1,
            lens.range.end.line + 1,
          );
          title = formatSymbolLensTitle(summary);
        }
      }
    } catch {
      // Keep the fallback title.
    }
    lens.command = { title, command: 'gitglasses.toggleFileBlame' };
    return lens;
  }

  private async blameFor(
    document: vscode.TextDocument,
    token: vscode.CancellationToken,
  ): Promise<FileBlame | undefined> {
    const located = await this.repos.locateOrDiscover(document.uri);
    if (!located || token.isCancellationRequested) return undefined;
    return this.blame.getBlame(
      {
        repoId: located.repoId,
        path: located.relativePath,
        version: document.isDirty ? document.version : -1,
      },
      token,
    );
  }

  dispose(): void {
    this.configListener.dispose();
    this.emitter.dispose();
  }
}
