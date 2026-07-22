// Workspace → wasm MEMFS bridge. The wasm engine only sees its Emscripten
// in-memory filesystem, so before repo/discover the workspace folder
// (.git/** plus the working tree) is mirrored into a mount path, and file
// change events are copied over incrementally afterwards.
//
// Wasm mode is READ-ONLY v1: stage/commit mutations are never wired on the
// web (they would mutate the MEMFS copy only and silently diverge from the
// user's real repository), and changes inside .git made outside this window
// (e.g. an external push) are not watched — reopening the workspace resyncs.
//
// Everything here is vscode-free and driven through injected filesystem
// interfaces so the planning logic is unit-testable.

export type SourceEntryKind = 'file' | 'directory' | 'symlink' | 'unknown';

export interface SourceEntry {
  name: string;
  kind: SourceEntryKind;
}

/** Read side: the workspace, adapted from vscode.workspace.fs. Paths are
 *  POSIX and relative to the workspace folder root ('' = the root). */
export interface SourceFs {
  list(relPath: string): Promise<SourceEntry[]>;
  read(relPath: string): Promise<Uint8Array>;
  stat(relPath: string): Promise<{ kind: SourceEntryKind; size: number }>;
}

/** Write side: the Emscripten module FS. Paths are absolute MEMFS paths. */
export interface MemfsWriter {
  mkdirTree(path: string): void;
  writeFile(path: string, data: Uint8Array): void;
  /** Best-effort removal of a file or (empty) directory. */
  remove(path: string): void;
}

export const DEFAULT_MAX_REPO_BYTES = 200 * 1024 * 1024;
export const DEFAULT_MOUNT_PATH = '/workspace';

export class RepoTooLargeError extends Error {
  constructor(
    readonly copiedBytes: number,
    readonly limitBytes: number,
  ) {
    super(
      `workspace is too large to mirror into the in-memory engine: ` +
        `${(copiedBytes / (1024 * 1024)).toFixed(1)} MB copied when the limit of ` +
        `${(limitBytes / (1024 * 1024)).toFixed(1)} MB was reached ` +
        `(raise "gitglasses.web.maxRepoBytes" to allow more)`,
    );
    this.name = 'RepoTooLargeError';
  }
}

/** POSIX-relative path of `fullPath` under `rootPath`, undefined when the
 *  path lies outside the root ('' = the root itself). */
export function workspaceRelativePath(
  rootPath: string,
  fullPath: string,
): string | undefined {
  const root = rootPath.endsWith('/') ? rootPath.slice(0, -1) : rootPath;
  if (fullPath === root) return '';
  if (!fullPath.startsWith(`${root}/`)) return undefined;
  return fullPath.slice(root.length + 1);
}

export interface MemfsBridgeOptions {
  maxTotalBytes?: number;
  mountPath?: string;
}

export interface MirrorStats {
  files: number;
  bytes: number;
}

export class MemfsBridge {
  readonly mountPath: string;
  private readonly maxTotalBytes: number;
  private readonly pending = new Set<string>();
  private readonly syncHandlers = new Set<(paths: string[]) => void>();

  constructor(
    private readonly source: SourceFs,
    options: MemfsBridgeOptions = {},
  ) {
    this.mountPath = options.mountPath ?? DEFAULT_MOUNT_PATH;
    this.maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_REPO_BYTES;
  }

  /** True when the workspace root has a real .git directory. A .git file
   *  (worktree/submodule indirection) points outside the mirror, which v1
   *  cannot follow; virtual repos have no .git at all. */
  async hasGitDir(): Promise<boolean> {
    try {
      return (await this.source.stat('.git')).kind === 'directory';
    } catch {
      return false;
    }
  }

  /** Full recursive copy of the workspace into the MEMFS mount. Symlinks and
   *  special entries are skipped (MEMFS mirror holds plain files only).
   *  Aborts with RepoTooLargeError once the copied bytes exceed the limit. */
  async mirrorInto(target: MemfsWriter): Promise<MirrorStats> {
    target.mkdirTree(this.mountPath);
    const stats: MirrorStats = { files: 0, bytes: 0 };
    await this.mirrorDirectory(target, '', stats);
    return stats;
  }

  private async mirrorDirectory(
    target: MemfsWriter,
    relPath: string,
    stats: MirrorStats,
  ): Promise<void> {
    for (const entry of await this.source.list(relPath)) {
      const childRel = relPath ? `${relPath}/${entry.name}` : entry.name;
      const memfsPath = `${this.mountPath}/${childRel}`;
      if (entry.kind === 'directory') {
        target.mkdirTree(memfsPath);
        await this.mirrorDirectory(target, childRel, stats);
      } else if (entry.kind === 'file') {
        const data = await this.source.read(childRel);
        stats.files += 1;
        stats.bytes += data.byteLength;
        if (stats.bytes > this.maxTotalBytes) {
          throw new RepoTooLargeError(stats.bytes, this.maxTotalBytes);
        }
        target.writeFile(memfsPath, data);
      }
      // 'symlink' / 'unknown' entries are intentionally not mirrored.
    }
  }

  /** Queues a changed workspace-relative path for the next flush. Duplicate
   *  events between flushes collapse to one copy. */
  queueChange(relPath: string): void {
    const normalized = relPath.replace(/^\.\//, '').replace(/^\/+/, '');
    if (normalized === '' || normalized === '.') return;
    if (normalized.split('/').includes('..')) return;
    this.pending.add(normalized);
  }

  pendingCount(): number {
    return this.pending.size;
  }

  /** Copies every queued path into the MEMFS mount (or removes it when it no
   *  longer exists in the workspace), then notifies onDidSyncChanges. */
  async flushInto(target: MemfsWriter): Promise<string[]> {
    const paths = [...this.pending];
    this.pending.clear();
    const synced: string[] = [];
    for (const relPath of paths) {
      const memfsPath = `${this.mountPath}/${relPath}`;
      try {
        const stat = await this.source.stat(relPath);
        if (stat.kind === 'file') {
          const data = await this.source.read(relPath);
          const parent = memfsPath.slice(0, memfsPath.lastIndexOf('/'));
          if (parent) target.mkdirTree(parent);
          target.writeFile(memfsPath, data);
          synced.push(relPath);
        } else if (stat.kind === 'directory') {
          target.mkdirTree(memfsPath);
          synced.push(relPath);
        }
      } catch {
        // Gone from the workspace: drop the mirror copy too.
        target.remove(memfsPath);
        synced.push(relPath);
      }
    }
    if (synced.length > 0) {
      for (const handler of [...this.syncHandlers]) handler(synced);
    }
    return synced;
  }

  /** Fires after each flush that copied at least one change. The engine
   *  cannot watch MEMFS, so the extension synthesizes the refresh work a
   *  repo/didChange push would normally trigger from this event. */
  onDidSyncChanges(handler: (paths: string[]) => void): { dispose(): void } {
    this.syncHandlers.add(handler);
    return { dispose: () => this.syncHandlers.delete(handler) };
  }
}
