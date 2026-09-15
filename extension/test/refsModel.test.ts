import { describe, expect, it } from 'vitest';
import type { EngineClient } from '@gitglasses/rpc';
import { RefsModel } from '../src/model/refsModel';

interface Recorded {
  calls: string[];
  resolve: (value?: unknown) => void;
}

/** Engine stub counting refs/list calls, with a fixed empty payload. */
function stubEngine(recorded: Recorded, fail = false): EngineClient {
  return {
    request: async (method: string, params: { repoId: string }) => {
      recorded.calls.push(`${method}:${params.repoId}`);
      if (fail) throw new Error('engine down');
      return { branches: [], remotes: [], tags: [] };
    },
  } as unknown as EngineClient;
}

function recorder(): Recorded {
  return { calls: [], resolve: () => undefined };
}

describe('RefsModel', () => {
  it('serves concurrent callers from one request', async () => {
    const recorded = recorder();
    const model = new RefsModel(stubEngine(recorded));

    await Promise.all([model.list('r1'), model.list('r1'), model.list('r1')]);

    expect(recorded.calls).toEqual(['refs/list:r1']);
  });

  it('keeps repositories apart', async () => {
    const recorded = recorder();
    const model = new RefsModel(stubEngine(recorded));

    await Promise.all([model.list('r1'), model.list('r2')]);

    expect(recorded.calls.sort()).toEqual(['refs/list:r1', 'refs/list:r2']);
  });

  it('answers later callers from cache until the ttl expires', async () => {
    const recorded = recorder();
    let now = 1000;
    const model = new RefsModel(stubEngine(recorded), 2000, () => now);

    await model.list('r1');
    now = 2999;
    await model.list('r1');
    expect(recorded.calls).toHaveLength(1);

    now = 3001;
    await model.list('r1');
    expect(recorded.calls).toHaveLength(2);
  });

  it('refetches after invalidation', async () => {
    const recorded = recorder();
    const model = new RefsModel(stubEngine(recorded));

    await model.list('r1');
    model.invalidate('r1');
    await model.list('r1');
    expect(recorded.calls).toHaveLength(2);

    model.invalidate();
    await model.list('r1');
    expect(recorded.calls).toHaveLength(3);
  });

  it('does not cache a failure', async () => {
    const recorded = recorder();
    const model = new RefsModel(stubEngine(recorded, true));

    await expect(model.list('r1')).rejects.toThrow('engine down');
    await expect(model.list('r1')).rejects.toThrow('engine down');
    expect(recorded.calls).toHaveLength(2);
  });
});
