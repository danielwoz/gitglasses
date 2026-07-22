import { describe, expect, it } from 'vitest';
import { RateLimiter } from '../src/rateLimiter.js';
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
});
