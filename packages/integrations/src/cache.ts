/** Injectable clock so time-based behavior is testable. */
export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

interface Entry<T> {
  value: T;
  storedAt: number;
  ttlMs: number;
}

export interface CachedResult<T> {
  value: T;
  /** True when the value was past its ttl and a background refresh was kicked off. */
  stale: boolean;
}

/**
 * A TTL cache with per-entry ttl, a stale-while-revalidate helper, and
 * coalescing of concurrent fetches for the same key.
 */
export class TtlCache<T> {
  private readonly entries = new Map<string, Entry<T>>();
  private readonly inflight = new Map<string, Promise<T>>();

  constructor(private readonly clock: Clock = systemClock) {}

  /** Fresh value for `key`, or undefined when absent or past its ttl. */
  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) {
      return undefined;
    }
    if (this.clock.now() - entry.storedAt >= entry.ttlMs) {
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: T, ttlMs: number): void {
    this.entries.set(key, { value, storedAt: this.clock.now(), ttlMs });
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }

  /**
   * Stale-while-revalidate read:
   * - age < ttlMs: cached value, `stale: false`, fetcher not called.
   * - ttlMs <= age < ttlMs + staleMs: cached value immediately with `stale: true`,
   *   while the fetcher refreshes the entry in the background.
   * - otherwise: awaits the fetcher and caches the result.
   * Concurrent fetches for the same key share a single fetcher invocation.
   */
  async getOrFetch(
    key: string,
    ttlMs: number,
    staleMs: number,
    fetcher: () => Promise<T>
  ): Promise<CachedResult<T>> {
    const entry = this.entries.get(key);
    if (entry) {
      const age = this.clock.now() - entry.storedAt;
      if (age < ttlMs) {
        return { value: entry.value, stale: false };
      }
      if (age < ttlMs + staleMs) {
        void this.refresh(key, ttlMs, fetcher).catch(() => undefined);
        return { value: entry.value, stale: true };
      }
    }
    const value = await this.refresh(key, ttlMs, fetcher);
    return { value, stale: false };
  }

  private refresh(key: string, ttlMs: number, fetcher: () => Promise<T>): Promise<T> {
    const existing = this.inflight.get(key);
    if (existing) {
      return existing;
    }
    const pending = (async () => {
      try {
        const value = await fetcher();
        this.entries.set(key, { value, storedAt: this.clock.now(), ttlMs });
        return value;
      } finally {
        this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, pending);
    return pending;
  }
}
