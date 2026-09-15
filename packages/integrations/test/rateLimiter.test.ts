import { describe, expect, it } from 'vitest';
import { RateLimitError } from '../src/errors.js';
import { MAX_ACQUIRE_WAIT_MS, RateLimiter } from '../src/rateLimiter.js';
import { FakeClock, fakeSleep } from './helpers.js';

function makeLimiter(capacity: number, refillPerSecond: number) {
  const clock = new FakeClock(1_000_000);
  const { sleeps, sleep } = fakeSleep(clock);
  const limiter = new RateLimiter({ capacity, refillPerSecond, clock, sleep });
  return { limiter, clock, sleeps };
}

describe('RateLimiter', () => {
  it('grants requests immediately while tokens remain', async () => {
    const { limiter, sleeps } = makeLimiter(3, 1);
    await limiter.acquire('github.com');
    await limiter.acquire('github.com');
    await limiter.acquire('github.com');
    expect(sleeps).toEqual([]);
  });

  it('queues requests once the bucket is exhausted', async () => {
    const { limiter, sleeps } = makeLimiter(2, 1);
    await limiter.acquire('github.com');
    await limiter.acquire('github.com');
    await limiter.acquire('github.com');
    expect(sleeps.length).toBeGreaterThan(0);
    expect(sleeps[0]).toBe(1000);
  });

  it('tracks buckets per host independently', async () => {
    const { limiter, sleeps } = makeLimiter(1, 1);
    await limiter.acquire('github.com');
    await limiter.acquire('gitlab.com');
    expect(sleeps).toEqual([]);
  });

  it('refills tokens over time', async () => {
    const { limiter, clock, sleeps } = makeLimiter(1, 2);
    await limiter.acquire('github.com');
    clock.advance(500);
    await limiter.acquire('github.com');
    expect(sleeps).toEqual([]);
  });

  it('honors Retry-After given in seconds', async () => {
    const { limiter, sleeps } = makeLimiter(5, 5);
    limiter.updateFromHeaders('github.com', { 'Retry-After': '30' });
    await limiter.acquire('github.com');
    expect(sleeps[0]).toBe(30_000);
  });

  it('honors Retry-After given as an http-date', async () => {
    const clock = new FakeClock(Date.parse('2026-07-22T10:00:00Z'));
    const { sleeps, sleep } = fakeSleep(clock);
    const limiter = new RateLimiter({ capacity: 5, refillPerSecond: 5, clock, sleep });
    limiter.updateFromHeaders('github.com', {
      'retry-after': 'Wed, 22 Jul 2026 10:00:45 GMT',
    });
    await limiter.acquire('github.com');
    expect(sleeps[0]).toBe(45_000);
  });

  it('blocks until reset when the reported remaining quota is zero', async () => {
    const clock = new FakeClock(50_000);
    const { sleeps, sleep } = fakeSleep(clock);
    const limiter = new RateLimiter({ capacity: 5, refillPerSecond: 5, clock, sleep });
    limiter.updateFromHeaders('github.com', {
      'X-RateLimit-Remaining': '0',
      'X-RateLimit-Reset': '80', // epoch seconds -> 80_000 ms
    });
    await limiter.acquire('github.com');
    expect(sleeps[0]).toBe(30_000);
  });

  it('spaces requests when remaining quota drops below 15%', async () => {
    const clock = new FakeClock(0);
    const { sleeps, sleep } = fakeSleep(clock);
    const limiter = new RateLimiter({ capacity: 100, refillPerSecond: 100, clock, sleep });
    limiter.updateFromHeaders('github.com', {
      'X-RateLimit-Remaining': '10',
      'X-RateLimit-Limit': '100',
      'X-RateLimit-Reset': '100', // 100s away, 10 left -> ~10s spacing
    });
    await limiter.acquire('github.com'); // first proceeds, sets next slot
    await limiter.acquire('github.com'); // must wait out the spacing
    expect(sleeps.length).toBeGreaterThan(0);
    expect(sleeps[0]).toBeGreaterThanOrEqual(9_000);
    expect(sleeps[0]).toBeLessThanOrEqual(10_000);
  });

  it('clears spacing when the quota recovers', async () => {
    const clock = new FakeClock(0);
    const { sleeps, sleep } = fakeSleep(clock);
    const limiter = new RateLimiter({ capacity: 100, refillPerSecond: 100, clock, sleep });
    limiter.updateFromHeaders('github.com', {
      'X-RateLimit-Remaining': '5',
      'X-RateLimit-Limit': '100',
      'X-RateLimit-Reset': '100',
    });
    limiter.updateFromHeaders('github.com', {
      'X-RateLimit-Remaining': '90',
      'X-RateLimit-Limit': '100',
      'X-RateLimit-Reset': '100',
    });
    await limiter.acquire('github.com');
    await limiter.acquire('github.com');
    expect(sleeps).toEqual([]);
  });

  it('reads headers from a Headers-like object', async () => {
    const { limiter, sleeps } = makeLimiter(5, 5);
    const headers = new Map([['retry-after', '10']]);
    limiter.updateFromHeaders('github.com', {
      get: (name: string) => headers.get(name.toLowerCase()) ?? null,
    });
    await limiter.acquire('github.com');
    expect(sleeps[0]).toBe(10_000);
  });

  it('reads a delta-seconds reset as a delay from now', async () => {
    const clock = new FakeClock(1_700_000_000_000);
    const { sleeps, sleep } = fakeSleep(clock);
    const limiter = new RateLimiter({ clock, sleep });
    limiter.updateFromHeaders('gitlab.com', {
      'RateLimit-Remaining': '0',
      'RateLimit-Reset': '45',
    });
    await limiter.acquire('gitlab.com');
    expect(sleeps[0]).toBe(45_000);
  });

  it('still reads an absolute epoch reset as a point in time', async () => {
    const clock = new FakeClock(1_700_000_000_000);
    const { sleeps, sleep } = fakeSleep(clock);
    const limiter = new RateLimiter({ clock, sleep });
    limiter.updateFromHeaders('github.com', {
      'X-RateLimit-Remaining': '0',
      'X-RateLimit-Reset': '1700000050',
    });
    await limiter.acquire('github.com');
    expect(sleeps[0]).toBe(50_000);
  });
});

describe('RateLimiter.acquire limits', () => {
  it('rejects rather than waiting past the admission cap, naming the reset time', async () => {
    const clock = new FakeClock(1_700_000_000_000);
    const { sleeps, sleep } = fakeSleep(clock);
    const limiter = new RateLimiter({ clock, sleep });
    limiter.updateFromHeaders('gitlab.com', { 'retry-after': '3600' });

    const error = await limiter.acquire('gitlab.com').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RateLimitError);
    expect((error as RateLimitError).resetAt?.getTime()).toBe(1_700_000_000_000 + 3_600_000);
    // Nothing is slept: the caller is told to come back instead.
    expect(sleeps).toEqual([]);
    expect(clock.now()).toBe(1_700_000_000_000);
  });

  it('waits out a block that fits inside the cap', async () => {
    const clock = new FakeClock(1_700_000_000_000);
    const { sleeps, sleep } = fakeSleep(clock);
    const limiter = new RateLimiter({ clock, sleep });
    limiter.updateFromHeaders('gitlab.com', {
      'retry-after': String(MAX_ACQUIRE_WAIT_MS / 1000 - 1),
    });
    await limiter.acquire('gitlab.com');
    expect(sleeps[0]).toBe(MAX_ACQUIRE_WAIT_MS - 1000);
  });

  it('honors a custom maxWaitMs', async () => {
    const clock = new FakeClock(0);
    const { sleep } = fakeSleep(clock);
    const limiter = new RateLimiter({ clock, sleep, maxWaitMs: 5_000 });
    limiter.updateFromHeaders('gitlab.com', { 'retry-after': '6' });
    await expect(limiter.acquire('gitlab.com')).rejects.toBeInstanceOf(RateLimitError);
  });

  it('rejects immediately when the signal is already aborted', async () => {
    const { limiter, sleeps } = makeLimiter(1, 1);
    const controller = new AbortController();
    controller.abort();
    await expect(limiter.acquire('github.com', controller.signal)).rejects.toThrow();
    expect(sleeps).toEqual([]);
  });

  it('rejects a wait in progress when the signal aborts', async () => {
    const clock = new FakeClock(0);
    const controller = new AbortController();
    const limiter = new RateLimiter({
      capacity: 1,
      refillPerSecond: 1,
      clock,
      // A sleep that never settles, so only the abort can end the wait.
      sleep: () => {
        controller.abort();
        return new Promise<void>(() => undefined);
      },
    });
    await limiter.acquire('github.com');
    const error = await limiter.acquire('github.com', controller.signal).catch((e: unknown) => e);
    expect((error as Error).name).toBe('AbortError');
  });

  it('admits waiters in arrival order, waking one per token', async () => {
    const { limiter, sleeps } = makeLimiter(1, 1);
    await limiter.acquire('github.com');
    const order: number[] = [];
    await Promise.all([
      limiter.acquire('github.com').then(() => order.push(1)),
      limiter.acquire('github.com').then(() => order.push(2)),
      limiter.acquire('github.com').then(() => order.push(3)),
    ]);
    expect(order).toEqual([1, 2, 3]);
    expect(sleeps).toEqual([1000, 1000, 1000]);
  });

  it('keeps a rejected waiter from stalling the ones behind it', async () => {
    const clock = new FakeClock(0);
    const { sleep } = fakeSleep(clock);
    const limiter = new RateLimiter({ clock, sleep, maxWaitMs: 5_000 });
    limiter.updateFromHeaders('github.com', { 'retry-after': '600' });
    const blocked = limiter.acquire('github.com').catch((e: unknown) => e);
    const behind = limiter.acquire('github.com').catch((e: unknown) => e);
    expect(await blocked).toBeInstanceOf(RateLimitError);
    expect(await behind).toBeInstanceOf(RateLimitError);
  });
});
