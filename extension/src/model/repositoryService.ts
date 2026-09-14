import * as vscode from 'vscode';
import * as path from 'node:path';
import { EngineClient } from '@gitglasses/rpc';

export interface LocatedFile {
  repoId: string;
  rootPath: string;
  relativePath: string;
}

/**
 * The repo-relative path of `fsPath` inside `rootPath`, or undefined when it
 * lies outside.
 *
 * The two sides come from different worlds. rootPath is libgit2's
 * git_repository_workdir(), which uses forward slashes on every platform;
 * fsPath is VS Code's, which uses backslashes on Windows. A raw startsWith
 * between them never matches there, which would leave blame, annotations,
 * staging and open-on-remote silently doing nothing on Windows. Drive letters
 * also vary in case between the two, and NTFS is case-insensitive anyway.
 */
export function relativeWithinRoot(
  rootPath: string,
  fsPath: string,
  caseInsensitive: boolean = process.platform === 'win32',
): string | undefined {
  const normalize = (value: string): string => {
    const slashed = value.replace(/\\/g, '/').replace(/\/+$/, '');
    return caseInsensitive ? slashed.toLowerCase() : slashed;
  };

  const root = normalize(rootPath);
  const target = normalize(fsPath);
  if (root === '') return undefined;
  if (target === root) return '';
  if (!target.startsWith(`${root}/`)) return undefined;

  // Slice the original (not the case-folded copy) so the path keeps its case.
  const rawTarget = fsPath.replace(/\\/g, '/');
  return rawTarget.slice(root.length + 1);
}

// Maps workspace files to engine repo ids, discovering repos lazily on first
// touch of a file inside them.
export class RepositoryService {
  private rootsById = new Map<string, string>();
  private discovering = new Map<string, Promise<string | undefined>>();

  constructor(private readonly engine: EngineClient) {}

  /** Synchronous lookup against already-discovered repos. */
  locate(uri: vscode.Uri): LocatedFile | undefined {
    if (uri.scheme !== 'file') return undefined;
    const fsPath = uri.fsPath;
    // Sort by path length (longest first) so nested repos match before parents.
    const sorted = [...this.rootsById.entries()].sort(
      (a, b) => b[1].length - a[1].length,
    );
    for (const [repoId, rootPath] of sorted) {
      const relative = relativeWithinRoot(rootPath, fsPath);
      if (relative === undefined) continue;
      return { repoId, rootPath, relativePath: relative };
    }
    return undefined;
  }

  /** Discovers the repo containing the file if not yet known. */
  async locateOrDiscover(uri: vscode.Uri): Promise<LocatedFile | undefined> {
    const located = this.locate(uri);
    if (located) return located;
    if (uri.scheme !== 'file') return undefined;

    const dir = path.dirname(uri.fsPath);
    let inflight = this.discovering.get(dir);
    if (!inflight) {
      inflight = this.engine
        .request('repo/discover', { path: dir })
        .then((info) => {
          // Engine reports the root with a trailing slash; normalize.
          this.rootsById.set(info.repoId, info.rootPath.replace(/\/$/, ''));
          return info.repoId;
        })
        .catch(() => undefined)
        .finally(() => this.discovering.delete(dir));
      this.discovering.set(dir, inflight);
    }
    await inflight;
    return this.locate(uri);
  }

  /** Re-register all known repos (after an engine respawn: ids are stale). */
  async rediscoverAll(): Promise<void> {
    const roots = [...this.rootsById.values()];
    this.rootsById.clear();
    for (const root of roots) {
      try {
        const info = await this.engine.request('repo/discover', { path: root });
        this.rootsById.set(info.repoId, info.rootPath.replace(/\/$/, ''));
      } catch {
        // Repo may have vanished; drop it.
      }
    }
  }
}
