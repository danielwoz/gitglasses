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
 * coalescing of concurrent fetches for the same key. Pass `maxEntries` to
 * bound a cache whose key space is open-ended; the least recently written
 * entries are dropped first.
 */
export class TtlCache<T> {
  private readonly entries = new Map<string, Entry<T>>();
  private readonly inflight = new Map<string, Promise<T>>();

  constructor(
    private readonly clock: Clock = systemClock,
    private readonly maxEntries?: number
  ) {}

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
    this.store(key, value, ttlMs);
  }

  /**
   * Drops `key`, including any fetch in flight for it, so the next read starts
   * a new one. A forced refresh that left the in-flight entry in place would
   * hand the caller back the very value it is refreshing away from.
   */
  delete(key: string): void {
    this.entries.delete(key);
    this.inflight.delete(key);
  }

  clear(): void {
    this.entries.clear();
    this.inflight.clear();
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
    // A fetch superseded by delete()/clear() still resolves its own callers but
    // no longer owns the key, so it neither writes its result back nor evicts
    // the fetch that replaced it.
    const owns = (): boolean => this.inflight.get(key) === pending;
    const pending = (async () => {
      try {
        const value = await fetcher();
        if (owns()) {
          this.store(key, value, ttlMs);
        }
        return value;
      } finally {
        if (owns()) {
          this.inflight.delete(key);
        }
      }
    })();
    this.inflight.set(key, pending);
    return pending;
  }

  /** Writes an entry as the most recent, evicting the oldest past maxEntries. */
  private store(key: string, value: T, ttlMs: number): void {
    this.entries.delete(key);
    this.entries.set(key, { value, storedAt: this.clock.now(), ttlMs });
    if (this.maxEntries === undefined) {
      return;
    }
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done === true) {
        return;
      }
      this.entries.delete(oldest.value);
    }
  }
}
