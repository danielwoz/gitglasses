import { systemClock, type Clock } from './cache.js';
import { defaultFetch, headerGetter, type FetchLike, type HttpHeadersLike } from './http.js';

export type SleepFn = (ms: number) => Promise<void>;

const defaultSleep: SleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export interface RateLimiterOptions {
  /** Maximum burst size per host. Default 10. */
  capacity?: number;
  /** Tokens added per second per host. Default 2. */
  refillPerSecond?: number;
  /** Remaining/limit ratio below which request spacing kicks in. Default 0.15. */
  lowRemainingRatio?: number;
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
}

/**
 * Per-host token bucket that also honors provider rate-limit response headers
 * (X-RateLimit-Remaining/Reset and Retry-After). When the reported remaining
 * quota drops below `lowRemainingRatio`, requests are spaced out so the quota
 * lasts until the reset time.
 */
/** Backoff applied when a forge reports zero remaining but no reset time. */
export const DEFAULT_EXHAUSTED_BACKOFF_MS = 60_000;

export class RateLimiter {
  private readonly capacity: number;
  private readonly refillPerSecond: number;
  private readonly lowRemainingRatio: number;
  private readonly clock: Clock;
  private readonly sleep: SleepFn;
  private readonly hosts = new Map<string, HostState>();

  constructor(options: RateLimiterOptions = {}) {
    this.capacity = options.capacity ?? 10;
    this.refillPerSecond = options.refillPerSecond ?? 2;
    this.lowRemainingRatio = options.lowRemainingRatio ?? 0.15;
    this.clock = options.clock ?? systemClock;
    this.sleep = options.sleep ?? defaultSleep;
  }

  /** Resolves when a request to `host` may proceed; waits as needed. */
  async acquire(host: string): Promise<void> {
    const state = this.stateFor(host);
    for (;;) {
      const now = this.clock.now();
      let waitMs: number;
      if (state.blockedUntil > now) {
        waitMs = state.blockedUntil - now;
      } else if (state.nextAllowedAt > now) {
        waitMs = state.nextAllowedAt - now;
      } else {
        this.refill(state, now);
        if (state.tokens >= 1) {
          state.tokens -= 1;
          if (state.spacingMs > 0) {
            state.nextAllowedAt = now + state.spacingMs;
          }
          return;
        }
        waitMs = Math.ceil(((1 - state.tokens) / this.refillPerSecond) * 1000);
      }
      await this.sleep(Math.max(waitMs, 1));
    }
  }

  /** Feed rate-limit response headers back into the limiter for `host`. */
  updateFromHeaders(host: string, headers: HttpHeadersLike | Record<string, string>): void {
    const get = headerGetter(headers);
    const state = this.stateFor(host);
    const now = this.clock.now();

    const retryAfter = get('retry-after');
    if (retryAfter !== undefined) {
      const seconds = Number(retryAfter);
      if (Number.isFinite(seconds)) {
        state.blockedUntil = Math.max(state.blockedUntil, now + seconds * 1000);
      } else {
        const dateMs = Date.parse(retryAfter);
        if (!Number.isNaN(dateMs)) {
          state.blockedUntil = Math.max(state.blockedUntil, dateMs);
        }
      }
    }

    const remainingRaw = (get('x-ratelimit-remaining') ?? get('ratelimit-remaining'));
    if (remainingRaw === undefined) {
      return;
    }
    const remaining = Number(remainingRaw);
    if (!Number.isFinite(remaining)) {
      return;
    }
    const resetRaw = (get('x-ratelimit-reset') ?? get('ratelimit-reset'));
    const resetMs =
      resetRaw !== undefined && Number.isFinite(Number(resetRaw))
        ? Number(resetRaw) * 1000
        : undefined;

    if (remaining <= 0) {
      // No reset header is the common case on forges that only send
      // "remaining"; sailing through would spend the next window instantly.
      state.blockedUntil = Math.max(state.blockedUntil, resetMs ?? now + DEFAULT_EXHAUSTED_BACKOFF_MS);
      return;
    }

    const limitRaw = (get('x-ratelimit-limit') ?? get('ratelimit-limit'));
    const limit =
      limitRaw !== undefined && Number(limitRaw) > 0 ? Number(limitRaw) : this.capacity;
    if (remaining / limit < this.lowRemainingRatio) {
      const windowMs = (resetMs ?? now + 60_000) - now;
      state.spacingMs = Math.max(0, Math.floor(windowMs / Math.max(remaining, 1)));
    } else {
      state.spacingMs = 0;
    }
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
 * feeds its headers back in, keyed by the request's host.
 *
 * The limiter existed but nothing called it, so provider fan-out — GitLab
 * issues one /approvals request per merge request concurrently, Bitbucket up
 * to ten — ran entirely ungoverned and ignored Retry-After.
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
    await limiter.acquire(host);
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
