import { describe, expect, it } from 'vitest';
import {
  MemfsBridge,
  MemfsWriter,
  RepoTooLargeError,
  SourceEntry,
  SourceEntryKind,
  SourceFs,
  workspaceRelativePath,
} from '../src/web/memfsBridge';

// In-memory SourceFs over a flat { 'rel/path': contents } spec; directories
// are implied by file paths, and entries whose value is 'symlink' surface as
// symlinks.
function fakeSource(files: Record<string, string>): SourceFs {
  const kindAt = (rel: string): SourceEntryKind | undefined => {
    if (rel === '') return 'directory';
    if (files[rel] === '\0symlink') return 'symlink';
    if (rel in files) return 'file';
    const prefix = `${rel}/`;
    return Object.keys(files).some((key) => key.startsWith(prefix))
      ? 'directory'
      : undefined;
  };
  return {
    async list(rel) {
      const prefix = rel === '' ? '' : `${rel}/`;
      const names = new Map<string, SourceEntry>();
      for (const key of Object.keys(files)) {
        if (!key.startsWith(prefix)) continue;
        const name = key.slice(prefix.length).split('/')[0];
        if (!names.has(name)) {
          names.set(name, { name, kind: kindAt(`${prefix}${name}`) ?? 'unknown' });
        }
      }
      if (kindAt(rel) !== 'directory') throw new Error(`ENOTDIR: ${rel}`);
      return [...names.values()];
    },
    async read(rel) {
      const contents = files[rel];
      if (contents === undefined) throw new Error(`ENOENT: ${rel}`);
      return new TextEncoder().encode(contents);
    },
    async stat(rel) {
      const kind = kindAt(rel);
      if (!kind) throw new Error(`ENOENT: ${rel}`);
      return { kind, size: files[rel]?.length ?? 0 };
    },
  };
}

interface Recorded {
  writer: MemfsWriter;
  written: Map<string, string>;
  dirs: string[];
  removed: string[];
}

function recordingWriter(): Recorded {
  const written = new Map<string, string>();
  const dirs: string[] = [];
  const removed: string[] = [];
  return {
    written,
    dirs,
    removed,
    writer: {
      mkdirTree: (path) => void dirs.push(path),
      writeFile: (path, data) => void written.set(path, new TextDecoder().decode(data)),
      remove: (path) => void removed.push(path),
    },
  };
}

describe('MemfsBridge.mirrorInto', () => {
  it('copies .git and working-tree files into the mount, skipping symlinks', async () => {
    const bridge = new MemfsBridge(
      fakeSource({
        '.git/HEAD': 'ref: refs/heads/main\n',
        '.git/objects/ab/cdef': 'blob',
        'src/app.ts': 'export {}\n',
        'README.md': 'hi\n',
        'link.ts': '\0symlink',
      }),
    );
    const { writer, written, dirs } = recordingWriter();
    const stats = await bridge.mirrorInto(writer);

    expect(stats.files).toBe(4);
    expect([...written.keys()].sort()).toEqual([
      '/workspace/.git/HEAD',
      '/workspace/.git/objects/ab/cdef',
      '/workspace/README.md',
      '/workspace/src/app.ts',
    ]);
    expect(written.get('/workspace/.git/HEAD')).toBe('ref: refs/heads/main\n');
    expect(dirs).toContain('/workspace');
    expect(dirs).toContain('/workspace/.git/objects/ab');
    expect([...written.keys()].some((key) => key.includes('link.ts'))).toBe(false);
  });

  it('aborts with RepoTooLargeError naming the copied size and the limit', async () => {
    const bridge = new MemfsBridge(
      fakeSource({ 'big.bin': 'x'.repeat(64), 'huge.bin': 'y'.repeat(64) }),
      { maxTotalBytes: 100 },
    );
    const { writer } = recordingWriter();
    const error = await bridge.mirrorInto(writer).then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(RepoTooLargeError);
    const tooLarge = error as RepoTooLargeError;
    expect(tooLarge.limitBytes).toBe(100);
    expect(tooLarge.copiedBytes).toBeGreaterThan(100);
    expect(tooLarge.message).toContain('gitglasses.web.maxRepoBytes');
  });

  it('respects a custom mount path', async () => {
    const bridge = new MemfsBridge(fakeSource({ 'a.txt': 'a' }), {
      mountPath: '/repo',
    });
    const { writer, written } = recordingWriter();
    await bridge.mirrorInto(writer);
    expect([...written.keys()]).toEqual(['/repo/a.txt']);
  });
});

describe('MemfsBridge.hasGitDir', () => {
  it('is true only for a real .git directory', async () => {
    const withDir = new MemfsBridge(fakeSource({ '.git/HEAD': 'x', 'a.txt': 'a' }));
    const withFile = new MemfsBridge(fakeSource({ '.git': 'gitdir: elsewhere' }));
    const without = new MemfsBridge(fakeSource({ 'a.txt': 'a' }));
    expect(await withDir.hasGitDir()).toBe(true);
    expect(await withFile.hasGitDir()).toBe(false);
    expect(await without.hasGitDir()).toBe(false);
  });
});

describe('MemfsBridge change sync', () => {
  it('dedupes queued paths and rejects escapes', () => {
    const bridge = new MemfsBridge(fakeSource({}));
    bridge.queueChange('src/app.ts');
    bridge.queueChange('./src/app.ts');
    bridge.queueChange('src/app.ts');
    bridge.queueChange('../outside.ts');
    bridge.queueChange('');
    expect(bridge.pendingCount()).toBe(1);
  });

  it('flushes changed files, removes deleted ones, and fires onDidSyncChanges once', async () => {
    const bridge = new MemfsBridge(
      fakeSource({ 'src/app.ts': 'v2', 'kept.txt': 'same' }),
    );
    const { writer, written, removed } = recordingWriter();
    const batches: string[][] = [];
    bridge.onDidSyncChanges((paths) => batches.push(paths));

    bridge.queueChange('src/app.ts');
    bridge.queueChange('gone.txt'); // not in the source anymore
    const synced = await bridge.flushInto(writer);

    expect(written.get('/workspace/src/app.ts')).toBe('v2');
    expect(removed).toEqual(['/workspace/gone.txt']);
    expect(synced.sort()).toEqual(['gone.txt', 'src/app.ts']);
    expect(batches).toHaveLength(1);
    expect(bridge.pendingCount()).toBe(0);
  });

  it('does not fire the sync event when nothing was pending', async () => {
    const bridge = new MemfsBridge(fakeSource({}));
    const { writer } = recordingWriter();
    let fired = 0;
    bridge.onDidSyncChanges(() => {
      fired += 1;
    });
    await bridge.flushInto(writer);
    expect(fired).toBe(0);
  });
});

describe('workspaceRelativePath', () => {
  it('maps paths under the root and rejects outsiders', () => {
    expect(workspaceRelativePath('/mount', '/mount/src/a.ts')).toBe('src/a.ts');
    expect(workspaceRelativePath('/mount/', '/mount/a.ts')).toBe('a.ts');
    expect(workspaceRelativePath('/mount', '/mount')).toBe('');
    expect(workspaceRelativePath('/mount', '/mountain/a.ts')).toBeUndefined();
    expect(workspaceRelativePath('/mount', '/other/a.ts')).toBeUndefined();
  });
});
