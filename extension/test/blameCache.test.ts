import { describe, expect, it } from 'vitest';
import type { BlameCommit, BlameHunk } from '@gitglasses/protocol';
import type { EngineClient } from '@gitglasses/rpc';
import { BlameModel, estimateBlameBytes } from '../src/model/blameModel';

interface BlameResult {
  hunks: BlameHunk[];
  commits: Record<string, BlameCommit>;
  totalLines: number;
}

function makeResult(hunkCount: number): BlameResult {
  const hunks: BlameHunk[] = [];
  const commits: Record<string, BlameCommit> = {};
  for (let i = 0; i < hunkCount; i++) {
    const sha = `${i}`.padStart(40, '0');
    hunks.push({ sha, resultLine: i + 1, originalLine: i + 1, lineCount: 1, path: 'file.ts' });
    commits[sha] = {
      author: { name: 'A', email: 'a@example.invalid', time: 1000 + i },
      committer: { name: 'A', email: 'a@example.invalid', time: 1000 + i },
      summary: `commit ${i}`,
      boundary: false,
    };
  }
  return { hunks, commits, totalLines: hunkCount };
}

/** Engine stand-in that streams a canned blame and records every request. */
function fakeEngine(resultFor: (path: string) => BlameResult | Error = () => makeResult(2)) {
  const listeners = new Set<(params: { streamId: string; hunks: BlameHunk[] }) => void>();
  const requests: { repoId: string; path: string }[] = [];
  const engine = {
    requests,
    onNotification(method: string, handler: (params: never) => void) {
      if (method !== 'blame/hunks') throw new Error(`unexpected notification ${method}`);
      listeners.add(handler as never);
      return { dispose: () => listeners.delete(handler as never) };
    },
    async request(method: string, params: { repoId: string; path: string; streamId: string }) {
      if (method !== 'blame/file') throw new Error(`unexpected request ${method}`);
      requests.push({ repoId: params.repoId, path: params.path });
      const result = resultFor(params.path);
      if (result instanceof Error) throw result;
      for (const listener of listeners) {
        listener({ streamId: params.streamId, hunks: result.hunks });
      }
      return { commits: result.commits, totalLines: result.totalLines };
    },
  };
  return engine;
}

function asEngine(fake: ReturnType<typeof fakeEngine>): EngineClient {
  return fake as unknown as EngineClient;
}

const onDisk = (path: string) => ({ repoId: 'r1', path, version: -1 });

describe('BlameModel caching', () => {
  it('serves a repeated key from the cache', async () => {
    const engine = fakeEngine();
    const model = new BlameModel(asEngine(engine));
    await model.getBlame(onDisk('a.ts'));
    await model.getBlame(onDisk('a.ts'));
    expect(engine.requests).toHaveLength(1);
  });

  it('does not cache a failed request', async () => {
    const engine = fakeEngine(() => new Error('boom'));
    const model = new BlameModel(asEngine(engine));
    await expect(model.getBlame(onDisk('a.ts'))).rejects.toThrow('boom');
    await expect(model.getBlame(onDisk('a.ts'))).rejects.toThrow('boom');
    expect(engine.requests).toHaveLength(2);
    expect(model.stats().entries).toBe(0);
  });

  it('invalidate drops a repo and resets the byte total', async () => {
    const engine = fakeEngine();
    const model = new BlameModel(asEngine(engine));
    await model.getBlame({ repoId: 'r1', path: 'a.ts', version: -1 });
    await model.getBlame({ repoId: 'r2', path: 'b.ts', version: -1 });
    model.invalidate('r1');
    expect(model.stats().entries).toBe(1);
    model.invalidate();
    expect(model.stats()).toEqual({ entries: 0, bytes: 0 });
  });
});

describe('BlameModel eviction order', () => {
  it('evicts the least recently used entry, not the oldest inserted', async () => {
    const engine = fakeEngine();
    const model = new BlameModel(asEngine(engine), Infinity, 2);
    await model.getBlame(onDisk('a.ts'));
    await model.getBlame(onDisk('b.ts'));
    // Reading 'a' again makes 'b' the least recently used.
    await model.getBlame(onDisk('a.ts'));
    await model.getBlame(onDisk('c.ts'));

    engine.requests.length = 0;
    await model.getBlame(onDisk('a.ts'));
    expect(engine.requests).toHaveLength(0); // still cached
    await model.getBlame(onDisk('b.ts'));
    expect(engine.requests.map((r) => r.path)).toEqual(['b.ts']); // was evicted
  });

  it('keeps the entry count within the cap', async () => {
    const engine = fakeEngine();
    const model = new BlameModel(asEngine(engine), Infinity, 3);
    for (let i = 0; i < 10; i++) await model.getBlame(onDisk(`f${i}.ts`));
    expect(model.stats().entries).toBe(3);
  });
});

describe('BlameModel byte budget', () => {
  it('counts bytes for what it holds', async () => {
    const engine = fakeEngine(() => makeResult(50));
    const model = new BlameModel(asEngine(engine));
    const blame = await model.getBlame(onDisk('a.ts'));
    expect(model.stats().bytes).toBe(estimateBlameBytes(blame));
    expect(model.stats().bytes).toBeGreaterThan(0);
  });

  it('evicts until the byte budget is met', async () => {
    const engine = fakeEngine(() => makeResult(100));
    const oneEntry = estimateBlameBytes(makeResult(100));
    // Room for two entries but not three.
    const model = new BlameModel(asEngine(engine), oneEntry * 2 + 1, Infinity);
    await model.getBlame(onDisk('a.ts'));
    await model.getBlame(onDisk('b.ts'));
    expect(model.stats().entries).toBe(2);
    await model.getBlame(onDisk('c.ts'));
    expect(model.stats().entries).toBe(2);
    expect(model.stats().bytes).toBeLessThanOrEqual(oneEntry * 2 + 1);
  });

  it('scales the estimate with the amount of blame held', async () => {
    expect(estimateBlameBytes(makeResult(200))).toBeGreaterThan(
      estimateBlameBytes(makeResult(20)) * 5,
    );
  });
});

describe('BlameModel superseded versions', () => {
  const key = (path: string, version: number) => ({ repoId: 'r1', path, version });

  it('drops older buffer versions of the same file', async () => {
    const engine = fakeEngine();
    const model = new BlameModel(asEngine(engine));
    await model.getBlame(key('a.ts', 4));
    await model.getBlame(key('a.ts', 5));
    expect(model.stats().entries).toBe(1);

    engine.requests.length = 0;
    await model.getBlame(key('a.ts', 5));
    expect(engine.requests).toHaveLength(0);
  });

  it('keeps the on-disk entry when a dirty version arrives', async () => {
    const engine = fakeEngine();
    const model = new BlameModel(asEngine(engine));
    await model.getBlame(key('a.ts', -1));
    await model.getBlame(key('a.ts', 7));
    expect(model.stats().entries).toBe(2);

    // Undo back to the saved contents must still hit the cache.
    engine.requests.length = 0;
    await model.getBlame(key('a.ts', -1));
    expect(engine.requests).toHaveLength(0);
  });

  it('drops every buffer version once the buffer matches disk again', async () => {
    const engine = fakeEngine();
    const model = new BlameModel(asEngine(engine));
    await model.getBlame(key('a.ts', 7));
    await model.getBlame(key('a.ts', 8));
    await model.getBlame(key('a.ts', -1));
    expect(model.stats().entries).toBe(1);
  });

  it('leaves other files and other repos alone', async () => {
    const engine = fakeEngine();
    const model = new BlameModel(asEngine(engine));
    await model.getBlame(key('a.ts', 1));
    await model.getBlame(key('b.ts', 1));
    await model.getBlame({ repoId: 'r2', path: 'a.ts', version: 1 });
    await model.getBlame(key('a.ts', 2));
    expect(model.stats().entries).toBe(3);
  });

  it('keeps a long edit session to one entry per file', async () => {
    const engine = fakeEngine();
    const model = new BlameModel(asEngine(engine));
    for (let version = 1; version <= 200; version++) {
      await model.getBlame(key('a.ts', version));
    }
    expect(model.stats().entries).toBe(1);
  });
});
