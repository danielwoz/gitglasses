/** One reading of the rate-limit response headers, shared by every consumer. */

import { headerGetter, type HttpHeadersLike } from './http.js';

/** Header spellings carrying the reset time, most specific first. */
const RESET_HEADERS = [
  'x-ratelimit-reset',
  'ratelimit-reset',
  'x-ratelimit-requests-reset',
] as const;

const REMAINING_HEADERS = ['x-ratelimit-remaining', 'ratelimit-remaining'] as const;

const LIMIT_HEADERS = ['x-ratelimit-limit', 'ratelimit-limit'] as const;

/** Values above ~5000 AD in seconds are already millisecond timestamps. */
const EPOCH_MS_THRESHOLD = 1e11;

/**
 * Largest value read as delta-seconds. A larger value resolving to the past is
 * an epoch for a window that has already reset, not a day-long delay.
 */
const MAX_DELTA_SECONDS = 24 * 60 * 60;

export interface RateLimitSignals {
  /** Requests left in the current window. */
  remaining?: number;
  /** Size of the current window. */
  limit?: number;
  /** Epoch ms the window resets at. */
  resetAt?: number;
  /** Epoch ms until which Retry-After bars requests. */
  retryAfterUntil?: number;
}

/**
 * Epoch ms for a reset header value.
 *
 * `X-RateLimit-Reset` carries an absolute epoch while the RFC-draft
 * `RateLimit-Reset` carries delta-seconds, and the same digits mean either.
 * They are told apart by result: a value landing in the past is re-read as a
 * delta from `now`, unless it is too large to be one.
 */
export function parseResetValue(value: string, now: number): number | undefined {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) {
    return undefined;
  }
  const absolute = seconds > EPOCH_MS_THRESHOLD ? seconds : seconds * 1000;
  if (absolute > now || seconds > MAX_DELTA_SECONDS) {
    return absolute;
  }
  return now + seconds * 1000;
}

/** Epoch ms a Retry-After value (delta-seconds or an http-date) points at. */
export function parseRetryAfter(value: string, now: number): number | undefined {
  const seconds = Number(value);
  if (Number.isFinite(seconds)) {
    return now + Math.max(seconds, 0) * 1000;
  }
  const dateMs = Date.parse(value);
  return Number.isNaN(dateMs) ? undefined : dateMs;
}

/** Reads every rate-limit signal a response carries, resolved against `now`. */
export function readRateLimitSignals(
  headers: HttpHeadersLike | Record<string, string>,
  now: number
): RateLimitSignals {
  const get = headerGetter(headers);
  const signals: RateLimitSignals = {};

  for (const header of RESET_HEADERS) {
    const raw = get(header);
    if (raw !== undefined) {
      const resetAt = parseResetValue(raw, now);
      if (resetAt !== undefined) {
        signals.resetAt = resetAt;
        break;
      }
    }
  }

  const retryAfter = get('retry-after');
  if (retryAfter !== undefined) {
    signals.retryAfterUntil = parseRetryAfter(retryAfter, now);
  }

  signals.remaining = numericHeader(get, REMAINING_HEADERS);
  signals.limit = numericHeader(get, LIMIT_HEADERS);
  return signals;
}

function numericHeader(
  get: (name: string) => string | undefined,
  names: readonly string[]
): number | undefined {
  for (const name of names) {
    const raw = get(name);
    if (raw !== undefined && Number.isFinite(Number(raw))) {
      return Number(raw);
    }
  }
  return undefined;
}
