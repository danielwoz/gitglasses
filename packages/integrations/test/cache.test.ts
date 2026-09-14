import { describe, expect, it } from 'vitest';
import { TtlCache } from '../src/cache.js';
import { FakeClock } from './helpers.js';

describe('TtlCache', () => {
  it('returns values within their ttl', () => {
    const clock = new FakeClock();
    const cache = new TtlCache<string>(clock);
    cache.set('k', 'v', 1000);
    clock.advance(999);
    expect(cache.get('k')).toBe('v');
  });

  it('expires values after their per-entry ttl', () => {
    const clock = new FakeClock();
    const cache = new TtlCache<string>(clock);
    cache.set('short', 'a', 500);
    cache.set('long', 'b', 5000);
    clock.advance(1000);
    expect(cache.get('short')).toBeUndefined();
    expect(cache.get('long')).toBe('b');
  });

  it('getOrFetch returns a fresh value without calling the fetcher', async () => {
    const clock = new FakeClock();
    const cache = new TtlCache<string>(clock);
    let calls = 0;
    cache.set('k', 'cached', 1000);
    const result = await cache.getOrFetch('k', 1000, 1000, async () => {
      calls += 1;
      return 'fetched';
    });
    expect(result).toEqual({ value: 'cached', stale: false });
    expect(calls).toBe(0);
  });

  it('getOrFetch fetches and caches on a miss', async () => {
    const clock = new FakeClock();
    const cache = new TtlCache<string>(clock);
    const result = await cache.getOrFetch('k', 1000, 0, async () => 'fetched');
    expect(result).toEqual({ value: 'fetched', stale: false });
    expect(cache.get('k')).toBe('fetched');
  });

  it('serves stale values within the stale window and revalidates in the background', async () => {
    const clock = new FakeClock();
    const cache = new TtlCache<string>(clock);
    cache.set('k', 'old', 1000);
    clock.advance(1500);
    let calls = 0;
    const result = await cache.getOrFetch('k', 1000, 1000, async () => {
      calls += 1;
      return 'new';
    });
    expect(result).toEqual({ value: 'old', stale: true });
    // Allow the background revalidation to settle.
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toBe(1);
    expect(cache.get('k')).toBe('new');
  });

  it('refetches synchronously once the stale window has passed', async () => {
    const clock = new FakeClock();
    const cache = new TtlCache<string>(clock);
    cache.set('k', 'old', 1000);
    clock.advance(2500);
    const result = await cache.getOrFetch('k', 1000, 1000, async () => 'new');
    expect(result).toEqual({ value: 'new', stale: false });
  });

  it('coalesces concurrent fetches for the same key', async () => {
    const clock = new FakeClock();
    const cache = new TtlCache<string>(clock);
    let calls = 0;
    let release!: (value: string) => void;
    const fetcher = () => {
      calls += 1;
      return new Promise<string>((resolve) => {
        release = resolve;
      });
    };
    const first = cache.getOrFetch('k', 1000, 0, fetcher);
    const second = cache.getOrFetch('k', 1000, 0, fetcher);
    release('shared');
    const [a, b] = await Promise.all([first, second]);
    expect(calls).toBe(1);
    expect(a.value).toBe('shared');
    expect(b.value).toBe('shared');
  });

  it('delete drops the in-flight fetch so a forced refresh starts a new one', async () => {
    const cache = new TtlCache<string>(new FakeClock());
    const releases: Array<() => void> = [];
    const fetcher = (): Promise<string> => {
      const index = releases.length;
      return new Promise<string>((resolve) => {
        releases.push(() => resolve(index === 0 ? 'stale' : 'fresh'));
      });
    };
    const first = cache.getOrFetch('k', 1000, 0, fetcher);
    cache.delete('k');
    const forced = cache.getOrFetch('k', 1000, 0, fetcher);
    for (const release of releases) release();
    const [a, b] = await Promise.all([first, forced]);

    expect(releases).toHaveLength(2);
    expect(a.value).toBe('stale');
    expect(b.value).toBe('fresh');
    // The superseded fetch does not write its result back over the new one.
    expect(cache.get('k')).toBe('fresh');
  });

  it('clear drops in-flight fetches too', async () => {
    const cache = new TtlCache<string>(new FakeClock());
    let calls = 0;
    const fetcher = async (): Promise<string> => {
      calls += 1;
      return `v${calls}`;
    };
    const first = cache.getOrFetch('k', 1000, 0, fetcher);
    cache.clear();
    await Promise.all([first, cache.getOrFetch('k', 1000, 0, fetcher)]);
    expect(calls).toBe(2);
  });

  it('evicts the least recently written entry past maxEntries', () => {
    const cache = new TtlCache<string>(new FakeClock(), 2);
    cache.set('a', '1', 1000);
    cache.set('b', '2', 1000);
    cache.set('a', '1b', 1000);
    cache.set('c', '3', 1000);
    expect(cache.get('a')).toBe('1b');
    expect(cache.get('c')).toBe('3');
    expect(cache.get('b')).toBeUndefined();
  });

  it('does not coalesce fetches across different keys', async () => {
    const clock = new FakeClock();
    const cache = new TtlCache<string>(clock);
    let calls = 0;
    const fetcher = async () => {
      calls += 1;
      return `v${calls}`;
    };
    await Promise.all([
      cache.getOrFetch('a', 1000, 0, fetcher),
      cache.getOrFetch('b', 1000, 0, fetcher),
    ]);
    expect(calls).toBe(2);
  });
});
