// Reset headers carry either an absolute epoch or RFC-draft delta-seconds,
// and the same digits mean either, so the reading is pinned here.

import { describe, expect, it } from 'vitest';
import { parseResetValue, parseRetryAfter, readRateLimitSignals } from '../src/rateLimitHeaders.js';

const NOW = 1_700_000_000_000;

describe('parseResetValue', () => {
  it('reads an epoch in the future as an absolute time', () => {
    expect(parseResetValue('1700000060', NOW)).toBe(1_700_000_060_000);
  });

  it('reads epoch milliseconds as an absolute time', () => {
    expect(parseResetValue('1700000060000', NOW)).toBe(1_700_000_060_000);
  });

  it('reads a small value landing in the past as delta-seconds', () => {
    expect(parseResetValue('60', NOW)).toBe(NOW + 60_000);
  });

  it('reads zero as "now"', () => {
    expect(parseResetValue('0', NOW)).toBe(NOW);
  });

  it('keeps an epoch that has already passed rather than reading it as a delta', () => {
    expect(parseResetValue('1600000000', NOW)).toBe(1_600_000_000_000);
  });

  it('ignores values that are not numbers', () => {
    expect(parseResetValue('soon', NOW)).toBeUndefined();
    expect(parseResetValue('-5', NOW)).toBeUndefined();
  });
});

describe('parseRetryAfter', () => {
  it('reads delta-seconds', () => {
    expect(parseRetryAfter('30', NOW)).toBe(NOW + 30_000);
  });

  it('reads an http-date', () => {
    expect(parseRetryAfter('Wed, 22 Jul 2026 10:00:45 GMT', NOW)).toBe(
      Date.parse('2026-07-22T10:00:45Z')
    );
  });

  it('ignores an unparseable value', () => {
    expect(parseRetryAfter('later', NOW)).toBeUndefined();
  });
});

describe('readRateLimitSignals', () => {
  it('reads every spelling from a plain record', () => {
    expect(
      readRateLimitSignals(
        { 'RateLimit-Remaining': '4', 'RateLimit-Limit': '100', 'RateLimit-Reset': '20' },
        NOW
      )
    ).toEqual({ remaining: 4, limit: 100, resetAt: NOW + 20_000 });
  });

  it('prefers the x-prefixed reset and reads a Headers-like object', () => {
    const headers = new Map([
      ['x-ratelimit-reset', '1700000030'],
      ['ratelimit-reset', '999'],
    ]);
    const signals = readRateLimitSignals(
      { get: (name: string) => headers.get(name.toLowerCase()) ?? null },
      NOW
    );
    expect(signals.resetAt).toBe(1_700_000_030_000);
  });

  it('reads the Jira spelling of the reset header', () => {
    expect(readRateLimitSignals({ 'x-ratelimit-requests-reset': '15' }, NOW).resetAt).toBe(
      NOW + 15_000
    );
  });

  it('reports Retry-After separately from the reset time', () => {
    const signals = readRateLimitSignals({ 'retry-after': '90' }, NOW);
    expect(signals.retryAfterUntil).toBe(NOW + 90_000);
    expect(signals.resetAt).toBeUndefined();
  });
});
