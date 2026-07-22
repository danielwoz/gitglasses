import { describe, expect, it } from 'vitest';
import { relativeTime } from '../src/system/dates';

const NOW = 1_700_000_000;

describe('relativeTime', () => {
  it('reports just now under a minute', () => {
    expect(relativeTime(NOW, NOW)).toBe('just now');
    expect(relativeTime(NOW - 59, NOW)).toBe('just now');
  });

  it('reports singular units', () => {
    expect(relativeTime(NOW - 60, NOW)).toBe('1 minute ago');
    expect(relativeTime(NOW - 3600, NOW)).toBe('1 hour ago');
    expect(relativeTime(NOW - 86400, NOW)).toBe('1 day ago');
    expect(relativeTime(NOW - 7 * 86400, NOW)).toBe('1 week ago');
    expect(relativeTime(NOW - 30 * 86400, NOW)).toBe('1 month ago');
    expect(relativeTime(NOW - 365 * 86400, NOW)).toBe('1 year ago');
  });

  it('reports plural units', () => {
    expect(relativeTime(NOW - 5 * 60, NOW)).toBe('5 minutes ago');
    expect(relativeTime(NOW - 3 * 3600, NOW)).toBe('3 hours ago');
    expect(relativeTime(NOW - 2 * 365 * 86400, NOW)).toBe('2 years ago');
  });

  it('picks the largest whole unit', () => {
    // 6 days -> days, not weeks; 45 days -> months, not weeks.
    expect(relativeTime(NOW - 6 * 86400, NOW)).toBe('6 days ago');
    expect(relativeTime(NOW - 45 * 86400, NOW)).toBe('1 month ago');
  });
});
