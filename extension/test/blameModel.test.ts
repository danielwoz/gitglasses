// BlameModel's request sharing, cancellation and buffer-version checks.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { ErrorCodes, type BlameHunk } from '@gitglasses/protocol';
import type { CancellationLike, EngineClient } from '@gitglasses/rpc';
import {
  affectsOtherFilesBlame,
  BlameModel,
  StaleBlameError,
  type BlameKey,
} from '../src/model/blameModel';

const SHA = 'c'.repeat(40);

interface Call {
  params: Record<string, unknown>;
  token?: CancellationLike;
  cancelled: boolean;
  answer(docVersion?: number): void;
}

/** An engine whose blame/file requests stay open until the test answers
 *  them; cancelling a request's token rejects it like the real client. */
function controlledEngine() {
  const calls: Call[] = [];
  const listeners = new Set<(params: { streamId: string; hunks: BlameHunk[] }) => void>();
  const engine = {
    onNotification(_method: string, handler: (params: never) => void) {
      listeners.add(handler as never);
      return { dispose: () => listeners.delete(handler as never) };
    },
    request(method: string, params: Record<string, unknown>, token?: CancellationLike) {
      if (method !== 'blame/file') throw new Error(`unexpected request ${method}`);
      return new Promise((resolve, reject) => {
        const call: Call = {
          params,
          token,
          cancelled: false,
          answer(docVersion?: number) {
            for (const listener of listeners) {
              listener({
                streamId: String(params.streamId),
                hunks: [{ sha: SHA, resultLine: 1, originalLine: 1, lineCount: 1, path: 'a.ts' }],
              });
            }
            resolve({
              streamId: params.streamId,
              totalLines: 1,
              fromCache: false,
              lfs: false,
              commits: {},
              ...(docVersion === undefined ? {} : { docVersion }),
            });
          },
        };
        token?.onCancellationRequested(() => {
          call.cancelled = true;
          reject(Object.assign(new Error('cancelled'), { code: ErrorCodes.Cancelled }));
        });
        calls.push(call);
      });
    },
  };
  return { engine: engine as unknown as EngineClient, calls };
}

/** A caller's cancellation token. */
function callerToken() {
  const listeners = new Set<() => void>();
  const token = {
    isCancellationRequested: false,
    onCancellationRequested(listener: () => void) {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
  };
  return {
    token,
    cancel() {
      token.isCancellationRequested = true;
      for (const listener of [...listeners]) listener();
    },
  };
}

const onDisk = (path = 'a.ts'): BlameKey => ({ repoId: 'r1', path, version: -1 });

afterEach(() => vi.useRealTimers());

describe('BlameModel shared requests', () => {
  it('keeps serving a caller without a token when the first caller cancels', async () => {
    const { engine, calls } = controlledEngine();
    const model = new BlameModel(engine);
    const line = callerToken();
    const lineBlame = model.getBlame(onDisk(), line.token);
    const annotations = model.getBlame(onDisk());
    line.cancel();

    await expect(lineBlame).rejects.toMatchObject({ code: ErrorCodes.Cancelled });
    expect(calls).toHaveLength(1);
    expect(calls[0].cancelled).toBe(false);
    calls[0].answer(-1);
    await expect(annotations).resolves.toMatchObject({ totalLines: 1 });
  });

  it('lets a caller that cancels and asks again rejoin the running request', async () => {
    vi.useFakeTimers();
    const { engine, calls } = controlledEngine();
    const model = new BlameModel(engine);
    for (let move = 0; move < 10; move++) {
      const cursor = callerToken();
      const pending = model.getBlame(onDisk(), cursor.token);
      cursor.cancel();
      await expect(pending).rejects.toMatchObject({ code: ErrorCodes.Cancelled });
      await vi.advanceTimersByTimeAsync(300);
    }
    const last = model.getBlame(onDisk(), callerToken().token);
    expect(calls).toHaveLength(1);
    expect(calls[0].cancelled).toBe(false);
    calls[0].answer(-1);
    await expect(last).resolves.toMatchObject({ totalLines: 1 });
  });

  it('cancels a request every caller has left, after a grace period', async () => {
    vi.useFakeTimers();
    const { engine, calls } = controlledEngine();
    const model = new BlameModel(engine, undefined, undefined, undefined, 1000);
    const caller = callerToken();
    const pending = model.getBlame(onDisk(), caller.token);
    caller.cancel();
    await expect(pending).rejects.toMatchObject({ code: ErrorCodes.Cancelled });

    await vi.advanceTimersByTimeAsync(999);
    expect(calls[0].cancelled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls[0].cancelled).toBe(true);
    // Nothing poisoned: the next ask starts afresh.
    void model.getBlame(onDisk(), callerToken().token).catch(() => undefined);
    expect(calls).toHaveLength(2);
  });

  it('cancels the running request of an invalidated file', async () => {
    const { engine, calls } = controlledEngine();
    const model = new BlameModel(engine);
    const pending = model.getBlame(onDisk('a.ts'));
    const other = model.getBlame(onDisk('b.ts'));
    model.invalidatePath('r1', 'a.ts');
    await expect(pending).rejects.toMatchObject({ code: ErrorCodes.Cancelled });
    expect(calls[1].cancelled).toBe(false);
    calls[1].answer(-1);
    await expect(other).resolves.toBeDefined();
    expect(model.stats().entries).toBe(1);
  });
});

describe('BlameModel saves', () => {
  it('drops every file of the repository when a file blame reads is saved', async () => {
    for (const saved of ['.mailmap', '.git-blame-ignore-revs', 'src/.gitattributes']) {
      const { engine, calls } = controlledEngine();
      const model = new BlameModel(engine);
      const pending = [model.getBlame(onDisk('a.ts')), model.getBlame(onDisk('b.ts'))];
      for (const call of calls) call.answer(-1);
      await Promise.all(pending);
      model.invalidateSaved('r1', saved);
      expect(model.stats().entries, saved).toBe(0);
    }
  });

  it('drops only the saved file otherwise', async () => {
    const { engine, calls } = controlledEngine();
    const model = new BlameModel(engine);
    const pending = [model.getBlame(onDisk('a.ts')), model.getBlame(onDisk('b.ts'))];
    for (const call of calls) call.answer(-1);
    await Promise.all(pending);
    model.invalidateSaved('r1', 'a.ts');
    expect(model.stats().entries).toBe(1);
  });

  it('knows which files change how other files are blamed', () => {
    expect(affectsOtherFilesBlame('.mailmap')).toBe(true);
    expect(affectsOtherFilesBlame('config/mailmap')).toBe(true);
    expect(affectsOtherFilesBlame('.git-blame-ignore-revs')).toBe(true);
    expect(affectsOtherFilesBlame('tools/blame-ignore-revs.txt')).toBe(true);
    expect(affectsOtherFilesBlame('docs/.gitattributes')).toBe(true);
    expect(affectsOtherFilesBlame('src/mailmap.ts')).toBe(false);
    expect(affectsOtherFilesBlame('README.md')).toBe(false);
  });
});

describe('BlameModel buffer versions', () => {
  it('asks for the buffer version it means, or the disk', () => {
    const { engine, calls } = controlledEngine();
    const model = new BlameModel(engine);
    void model.getBlame({ repoId: 'r1', path: 'a.ts', version: 7 });
    void model.getBlame(onDisk());
    void model.getBlame({ repoId: 'r1', path: 'a.ts', version: -1, rev: 'HEAD~2' });
    void model.getBlame({
      repoId: 'r1',
      path: 'b.ts',
      version: -1,
      options: { ignoreWhitespace: true, moves: 'withinFile', ignoreRevs: false },
    });
    expect(calls.map((c) => ({ ...c.params, streamId: undefined }))).toEqual([
      { repoId: 'r1', path: 'a.ts', docVersion: 7, streamId: undefined },
      { repoId: 'r1', path: 'a.ts', docVersion: -1, streamId: undefined },
      { repoId: 'r1', path: 'a.ts', rev: 'HEAD~2', streamId: undefined },
      {
        repoId: 'r1',
        path: 'b.ts',
        docVersion: -1,
        options: { ignoreWhitespace: true, moves: 'withinFile', ignoreRevs: false },
        streamId: undefined,
      },
    ]);
  });

  it('never caches an answer for another buffer version', async () => {
    const { engine, calls } = controlledEngine();
    const lines: string[] = [];
    const model = new BlameModel(engine, undefined, undefined, (line) => lines.push(line));
    const key = { repoId: 'r1', path: 'a.ts', version: 8 };
    const first = model.getBlame(key);
    calls[0].answer(7);
    await expect(first).rejects.toBeInstanceOf(StaleBlameError);
    expect(model.stats().entries).toBe(0);
    expect(lines).toEqual([]);

    const second = model.getBlame(key);
    expect(calls).toHaveLength(2);
    calls[1].answer(8);
    await expect(second).resolves.toMatchObject({ totalLines: 1, lfs: false });
    expect(model.stats().entries).toBe(1);
  });

  it('keys the cache by revision and options too', async () => {
    const { engine, calls } = controlledEngine();
    const model = new BlameModel(engine);
    const keys: BlameKey[] = [
      onDisk(),
      { ...onDisk(), rev: 'HEAD' },
      { ...onDisk(), options: { ignoreWhitespace: true } },
    ];
    for (const key of keys) {
      const pending = model.getBlame(key);
      calls[calls.length - 1].answer(key.rev ? undefined : -1);
      await pending;
    }
    expect(calls).toHaveLength(3);
    for (const key of keys) await model.getBlame(key);
    expect(calls).toHaveLength(3);
  });
});
