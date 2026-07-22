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
