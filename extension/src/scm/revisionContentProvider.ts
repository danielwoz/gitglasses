import * as vscode from 'vscode';
import { EngineClient } from '@gitglasses/rpc';
import { isFixedRevision } from './revisionLogic';

// gitglasses:/<repo-relative-path>?repoId=<id>&rev=<rev>[&root=<repo root>]
// Read-only virtual documents showing a file at a specific revision. Every
// surface that opens or diffs a past revision addresses it through this
// scheme, encoding the uri with encodeRevisionUri.
//
// Repo ids are handed out per engine process, so a document that outlives an
// engine restart would name another repository by id. The root, when the uri
// carries it, is what identifies the repository; the id is the fallback.

type RootOf = (repoId: string) => string | undefined;

let rootOf: RootOf | undefined;

/** Installs the lookup encodeRevisionUri records each repository's root with
 *  (core does this at startup). */
export function setRevisionRootLookup(lookup: RootOf | undefined): void {
  rootOf = lookup;
}

export function encodeRevisionUri(repoId: string, relativePath: string, rev: string): vscode.Uri {
  const query = new URLSearchParams({ repoId, rev });
  const root = rootOf?.(repoId);
  if (root) query.set('root', root);
  return vscode.Uri.from({
    scheme: 'gitglasses',
    path: '/' + relativePath,
    query: query.toString(),
  });
}

export interface DecodedRevisionUri {
  repoId: string;
  relativePath: string;
  rev: string;
  /** The repository's root when the uri was made, if it recorded one. */
  root?: string;
}

export function decodeRevisionUri(uri: vscode.Uri): DecodedRevisionUri | undefined {
  if (uri.scheme !== 'gitglasses') return undefined;
  const query = new URLSearchParams(uri.query);
  const repoId = query.get('repoId');
  const rev = query.get('rev');
  if (!repoId || !rev) return undefined;
  const decoded: DecodedRevisionUri = { repoId, relativePath: uri.path.replace(/^\//, ''), rev };
  const root = query.get('root');
  if (root) decoded.root = root;
  return decoded;
}

/** How long a burst of repository changes settles before open documents are
 *  read again. */
const REFRESH_SETTLE_MS = 150;

export class RevisionContentProvider
  implements vscode.TextDocumentContentProvider, vscode.Disposable
{
  private emitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.emitter.event;
  /** Repositories whose moved documents a pending flush re-reads; 'all'
   *  covers every repository. */
  private pendingRepos: Set<string> | 'all' = new Set();
  /** Whether the pending flush re-reads documents at fixed commits too. */
  private pendingFixed = false;
  private timer: ReturnType<typeof setTimeout> | undefined;

  /**
   * @param repoIdForRoot the current id of the repository at a root, so a
   *   document made before an engine restart still reads its own repository.
   */
  constructor(
    private readonly engine: EngineClient,
    private readonly repoIdForRoot: (root: string) => string | undefined = () => undefined,
  ) {}

  async provideTextDocumentContent(
    uri: vscode.Uri,
    token: vscode.CancellationToken,
  ): Promise<string | undefined> {
    const decoded = decodeRevisionUri(uri);
    if (!decoded) return undefined;
    try {
      const result = await this.engine.request(
        'rev/fileAtRev',
        { repoId: this.repoIdOf(decoded), path: decoded.relativePath, rev: decoded.rev },
        token,
      );
      return result.contents;
    } catch {
      return undefined; // file absent at that revision: empty virtual doc
    }
  }

  /** Re-reads one revision document. */
  refresh(uri: vscode.Uri): void {
    this.emitter.fire(uri);
  }

  /**
   * Re-reads the open documents whose revision can now name other content:
   * HEAD, a branch, a tag or the index after a commit, checkout, reset,
   * stash or fetch, in one repository or (without an id) in all of them. A
   * document at a full commit id never changes. Bursts are coalesced.
   */
  refreshMoved(repoId?: string): void {
    if (repoId === undefined) this.pendingRepos = 'all';
    else if (this.pendingRepos !== 'all') this.pendingRepos.add(repoId);
    this.schedule();
  }

  /** Re-reads every open revision document, which an engine restart needs:
   *  the ids the documents were read with may name other repositories now. */
  refreshAll(): void {
    this.pendingRepos = 'all';
    this.pendingFixed = true;
    this.schedule();
  }

  private schedule(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), REFRESH_SETTLE_MS);
  }

  private flush(): void {
    const repos = this.pendingRepos;
    const fixedToo = this.pendingFixed;
    this.pendingRepos = new Set();
    this.pendingFixed = false;
    for (const document of vscode.workspace.textDocuments) {
      const decoded = decodeRevisionUri(document.uri);
      if (!decoded) continue;
      if (!fixedToo && isFixedRevision(decoded.rev)) continue;
      if (repos !== 'all' && !repos.has(this.repoIdOf(decoded))) continue;
      this.emitter.fire(document.uri);
    }
  }

  private repoIdOf(decoded: DecodedRevisionUri): string {
    return (decoded.root && this.repoIdForRoot(decoded.root)) || decoded.repoId;
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.emitter.dispose();
  }
}
