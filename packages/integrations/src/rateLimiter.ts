import { systemClock, type Clock } from './cache.js';
import { headerGetter, type HttpHeadersLike } from './http.js';

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

    const remainingRaw = get('x-ratelimit-remaining');
    if (remainingRaw === undefined) {
      return;
    }
    const remaining = Number(remainingRaw);
    if (!Number.isFinite(remaining)) {
      return;
    }
    const resetRaw = get('x-ratelimit-reset');
    const resetMs =
      resetRaw !== undefined && Number.isFinite(Number(resetRaw))
        ? Number(resetRaw) * 1000
        : undefined;

    if (remaining <= 0) {
      if (resetMs !== undefined) {
        state.blockedUntil = Math.max(state.blockedUntil, resetMs);
      }
      return;
    }

    const limitRaw = get('x-ratelimit-limit');
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
