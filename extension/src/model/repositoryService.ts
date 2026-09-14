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

/** Whether two repository roots are the same path, ignoring a trailing
 *  separator, separator style, and case on Windows. */
export function sameRoot(a: string, b: string): boolean {
  const normalize = (value: string): string => {
    const slashed = value.replace(/\\/g, '/').replace(/\/+$/, '');
    return process.platform === 'win32' ? slashed.toLowerCase() : slashed;
  };
  return normalize(a) === normalize(b);
}

/** A repository's display name: the last segment of its root path. */
export function repoName(rootPath: string): string {
  const parts = rootPath.replace(/\\/g, '/').replace(/\/+$/, '').split('/');
  return parts[parts.length - 1] || rootPath;
}

// Maps workspace files to engine repo ids, discovering repos lazily on first
// touch of a file inside them.
export class RepositoryService {
  private rootsById = new Map<string, string>();
  /** (repoId, rootPath) ordered by path length, longest first, so nested repos
   *  match before their parents. Rebuilt on mutation, not per lookup. */
  private sortedRoots: [string, string][] = [];
  private discovering = new Map<string, Promise<string | undefined>>();

  constructor(private readonly engine: EngineClient) {}

  private setRoot(repoId: string, rootPath: string): void {
    this.rootsById.set(repoId, rootPath);
    this.sortedRoots = [...this.rootsById.entries()].sort((a, b) => b[1].length - a[1].length);
  }

  private clearRoots(): void {
    this.rootsById.clear();
    this.sortedRoots = [];
  }

  /** Synchronous lookup against already-discovered repos. */
  locate(uri: vscode.Uri): LocatedFile | undefined {
    if (uri.scheme !== 'file') return undefined;
    const fsPath = uri.fsPath;
    for (const [repoId, rootPath] of this.sortedRoots) {
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
          this.setRoot(info.repoId, info.rootPath.replace(/\/$/, ''));
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
    this.clearRoots();
    for (const root of roots) {
      try {
        const info = await this.engine.request('repo/discover', { path: root });
        this.setRoot(info.repoId, info.rootPath.replace(/\/$/, ''));
      } catch {
        // Repo may have vanished; drop it.
      }
    }
  }
}
