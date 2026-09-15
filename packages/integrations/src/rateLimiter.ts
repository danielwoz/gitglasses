import { systemClock, type Clock } from './cache.js';
import { RateLimitError } from './errors.js';
import {
  defaultFetch,
  DEFAULT_HTTP_TIMEOUT_MS,
  type FetchLike,
  type HttpHeadersLike,
} from './http.js';
import { readRateLimitSignals } from './rateLimitHeaders.js';

export type SleepFn = (ms: number) => Promise<void>;

const defaultSleep: SleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Burst size per host: requests admitted back-to-back before the refill rate
 * takes over. Covers a launchpad refresh's list calls and the opening of its
 * per-result enrichment.
 */
export const DEFAULT_CAPACITY = 20;

/**
 * Sustained requests per second per host. Below every forge's documented
 * ceiling (GitHub's secondary limit allows ~15/s per REST endpoint and 100
 * concurrent requests; gitlab.com allows 2000/min, ~33/s), so the bucket
 * governs runaway fan-out while the response headers govern the real quota.
 */
export const DEFAULT_REFILL_PER_SECOND = 10;

/**
 * Longest wait acquire() admits before failing fast: twice the ceiling on the
 * request it is waiting to issue.
 */
export const MAX_ACQUIRE_WAIT_MS = 2 * DEFAULT_HTTP_TIMEOUT_MS;

export interface RateLimiterOptions {
  /** Maximum burst size per host. Default DEFAULT_CAPACITY. */
  capacity?: number;
  /** Tokens added per second per host. Default DEFAULT_REFILL_PER_SECOND. */
  refillPerSecond?: number;
  /** Remaining/limit ratio below which request spacing kicks in. Default 0.15. */
  lowRemainingRatio?: number;
  /** Longest admitted wait before acquire() rejects. Default MAX_ACQUIRE_WAIT_MS. */
  maxWaitMs?: number;
  clock?: Clock;
  sleep?: SleepFn;
}

interface HostState {
  tokens: number;
  lastRefill: number;
  /** No requests until this timestamp (Retry-After / exhausted limit). */
  blockedUntil: number;
  /** Minimum gap between requests while the provider reports low remaining quota. */
  spacingMs: number;
  nextAllowedAt: number;
  /** Resolves when the last caller to join the queue has been admitted. */
  tail: Promise<void>;
}

/** The reason an aborted signal carries, as an Error. */
function abortReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  if (reason instanceof Error) {
    return reason;
  }
  const error = new Error('request aborted while waiting for the rate limiter');
  error.name = 'AbortError';
  return error;
}

/** Backoff applied when a forge reports zero remaining but no reset time. */
export const DEFAULT_EXHAUSTED_BACKOFF_MS = 60_000;

/**
 * Per-host token bucket that also honors provider rate-limit response headers
 * (X-RateLimit-Remaining/Reset and Retry-After). When the reported remaining
 * quota drops below `lowRemainingRatio`, requests are spaced out so the quota
 * lasts until the reset time.
 */
export class RateLimiter {
  private readonly capacity: number;
  private readonly refillPerSecond: number;
  private readonly lowRemainingRatio: number;
  private readonly maxWaitMs: number;
  private readonly clock: Clock;
  private readonly sleep: SleepFn;
  private readonly hosts = new Map<string, HostState>();

  constructor(options: RateLimiterOptions = {}) {
    this.capacity = options.capacity ?? DEFAULT_CAPACITY;
    this.refillPerSecond = options.refillPerSecond ?? DEFAULT_REFILL_PER_SECOND;
    this.lowRemainingRatio = options.lowRemainingRatio ?? 0.15;
    this.maxWaitMs = options.maxWaitMs ?? MAX_ACQUIRE_WAIT_MS;
    this.clock = options.clock ?? systemClock;
    this.sleep = options.sleep ?? defaultSleep;
  }

  /**
   * Resolves when a request to `host` may proceed, waiting as needed.
   *
   * Callers are admitted in arrival order: each joins a per-host queue and
   * only the one at its head sleeps, so a token wakes one waiter rather than
   * all of them. Rejects with RateLimitError carrying `resetAt` when the wait
   * would run past `maxWaitMs`, and with the signal's reason when `signal`
   * aborts.
   */
  async acquire(host: string, signal?: AbortSignal): Promise<void> {
    const state = this.stateFor(host);
    const deadline = this.clock.now() + this.maxWaitMs;
    const ahead = state.tail;
    let admitted!: () => void;
    state.tail = new Promise<void>((resolve) => {
      admitted = resolve;
    });
    try {
      await ahead;
      for (;;) {
        if (signal?.aborted) {
          throw abortReason(signal);
        }
        const now = this.clock.now();
        let until: number;
        if (state.blockedUntil > now) {
          until = state.blockedUntil;
        } else if (state.nextAllowedAt > now) {
          until = state.nextAllowedAt;
        } else {
          this.refill(state, now);
          if (state.tokens >= 1) {
            state.tokens -= 1;
            if (state.spacingMs > 0) {
              state.nextAllowedAt = now + state.spacingMs;
            }
            return;
          }
          until = now + Math.ceil(((1 - state.tokens) / this.refillPerSecond) * 1000);
        }
        if (until > deadline) {
          throw new RateLimitError(
            `${host} is rate limited until ${new Date(until).toISOString()}, ` +
              `longer than the ${this.maxWaitMs} ms this request will wait`,
            new Date(until),
            429
          );
        }
        await this.wait(Math.max(until - now, 1), signal);
      }
    } finally {
      admitted();
    }
  }

  /** Feed rate-limit response headers back into the limiter for `host`. */
  updateFromHeaders(host: string, headers: HttpHeadersLike | Record<string, string>): void {
    const state = this.stateFor(host);
    const now = this.clock.now();
    const { remaining, limit: reportedLimit, resetAt, retryAfterUntil } = readRateLimitSignals(
      headers,
      now
    );

    if (retryAfterUntil !== undefined) {
      state.blockedUntil = Math.max(state.blockedUntil, retryAfterUntil);
    }
    if (remaining === undefined) {
      return;
    }

    if (remaining <= 0) {
      // Forges that report only "remaining" leave the reset time out, so an
      // exhausted window falls back to a fixed backoff.
      state.blockedUntil = Math.max(
        state.blockedUntil,
        resetAt ?? now + DEFAULT_EXHAUSTED_BACKOFF_MS
      );
      return;
    }

    const limit = reportedLimit !== undefined && reportedLimit > 0 ? reportedLimit : this.capacity;
    if (remaining / limit < this.lowRemainingRatio) {
      const windowMs = (resetAt ?? now + 60_000) - now;
      state.spacingMs = Math.max(0, Math.floor(windowMs / Math.max(remaining, 1)));
    } else {
      state.spacingMs = 0;
    }
  }

  /** Sleeps `ms`, rejecting early when `signal` aborts. */
  private wait(ms: number, signal?: AbortSignal): Promise<void> {
    if (!signal) {
      return this.sleep(ms);
    }
    return new Promise<void>((resolve, reject) => {
      const onAbort = (): void => reject(abortReason(signal));
      signal.addEventListener('abort', onAbort, { once: true });
      this.sleep(ms).then(
        () => {
          signal.removeEventListener('abort', onAbort);
          resolve();
        },
        (error: unknown) => {
          signal.removeEventListener('abort', onAbort);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      );
    });
  }

  private stateFor(host: string): HostState {
    let state = this.hosts.get(host);
    if (!state) {
      state = {
        tokens: this.capacity,
        lastRefill: this.clock.now(),
        blockedUntil: 0,
        spacingMs: 0,
        nextAllowedAt: 0,
        tail: Promise.resolve(),
      };
      this.hosts.set(host, state);
    }
    return state;
  }

  private refill(state: HostState, now: number): void {
    const elapsed = Math.max(0, now - state.lastRefill);
    state.tokens = Math.min(
      this.capacity,
      state.tokens + (elapsed / 1000) * this.refillPerSecond
    );
    state.lastRefill = now;
  }
}

/**
 * Wraps a fetch so every request is admitted by `limiter` and every response
 * feeds its headers back in, keyed by the request's host. A caller-supplied
 * signal aborts the wait for admission as well as the request itself.
 */
export function rateLimitedFetch(inner: FetchLike, limiter: RateLimiter): FetchLike {
  return async (url, init) => {
    let host: string;
    try {
      host = new URL(url).host;
    } catch {
      // Not addressable per-host; pass through rather than fail the request.
      return inner(url, init);
    }
    await limiter.acquire(host, init?.signal);
    const response = await inner(url, init);
    limiter.updateFromHeaders(host, response.headers);
    return response;
  };
}

/**
 * Process-wide limiter shared by every provider, so concurrent calls against
 * one host queue behind each other rather than each keeping its own budget.
 */
export const sharedRateLimiter = new RateLimiter();

/**
 * The default transport for providers: the runtime fetch with a timeout and a
 * size bound, admitted through the shared limiter.
 */
export const governedFetch: FetchLike = rateLimitedFetch(defaultFetch, sharedRateLimiter);
