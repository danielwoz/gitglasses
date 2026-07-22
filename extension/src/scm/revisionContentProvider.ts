import * as vscode from 'vscode';
import { EngineClient } from '../engine/engineClient';

// gitglasses:/<repo-relative-path>?repoId=<id>&rev=<rev>
// Read-only virtual documents showing a file at a specific revision — used by
// quick diff, "open at revision", and diff-with-HEAD commands.

export function encodeRevisionUri(repoId: string, relativePath: string, rev: string): vscode.Uri {
  return vscode.Uri.from({
    scheme: 'gitglasses',
    path: '/' + relativePath,
    query: new URLSearchParams({ repoId, rev }).toString(),
  });
}

export function decodeRevisionUri(
  uri: vscode.Uri,
): { repoId: string; relativePath: string; rev: string } | undefined {
  if (uri.scheme !== 'gitglasses') return undefined;
  const query = new URLSearchParams(uri.query);
  const repoId = query.get('repoId');
  const rev = query.get('rev');
  if (!repoId || !rev) return undefined;
  return { repoId, relativePath: uri.path.replace(/^\//, ''), rev };
}

export class RevisionContentProvider implements vscode.TextDocumentContentProvider {
  private emitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.emitter.event;

  constructor(private readonly engine: EngineClient) {}

  async provideTextDocumentContent(
    uri: vscode.Uri,
    token: vscode.CancellationToken,
  ): Promise<string | undefined> {
    const decoded = decodeRevisionUri(uri);
    if (!decoded) return undefined;
    try {
      const result = await this.engine.request(
        'rev/fileAtRev',
        { repoId: decoded.repoId, path: decoded.relativePath, rev: decoded.rev },
        token,
      );
      return result.contents;
    } catch {
      return undefined; // file absent at that revision: empty virtual doc
    }
  }

  /** Invalidate all revision docs for a repo (rev like HEAD moves). */
  refresh(uri: vscode.Uri): void {
    this.emitter.fire(uri);
  }
}
