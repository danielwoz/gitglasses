// One refs/list fetch shared by every view that renders part of it. Branches,
// remotes and tags each need a third of the same payload and are queried at
// the same moment (sidebar open, refresh, ref change), so the fetch is cached
// per repo for a short window and the concurrent callers await one promise.

import type { RequestResult } from '@gitglasses/protocol';
import type { EngineClient } from '@gitglasses/rpc';

export type RefsList = RequestResult<'refs/list'>;

/** How long a completed fetch answers later callers. Long enough to cover the
 *  three views' staggered queries, short enough that an unnoticed ref change
 *  self-corrects. */
export const REFS_CACHE_TTL_MS = 2000;

interface Entry {
  promise: Promise<RefsList>;
  /** Completion time; in-flight entries have none and never expire. */
  settledAt?: number;
}

export class RefsModel {
  private entries = new Map<string, Entry>();

  constructor(
    private readonly engine: EngineClient,
    private readonly ttlMs: number = REFS_CACHE_TTL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  /** The repo's refs, from cache when one is in flight or still fresh. */
  list(repoId: string): Promise<RefsList> {
    const cached = this.entries.get(repoId);
    if (cached && (cached.settledAt === undefined || this.now() - cached.settledAt < this.ttlMs)) {
      return cached.promise;
    }
    const entry: Entry = {
      promise: this.engine.request('refs/list', { repoId }),
    };
    this.entries.set(repoId, entry);
    entry.promise.then(
      () => {
        entry.settledAt = this.now();
      },
      // A rejection is never cached: the next caller retries.
      () => this.drop(repoId, entry),
    );
    return entry.promise;
  }

  /** Drops cached refs for a repo, or for every repo. */
  invalidate(repoId?: string): void {
    if (repoId === undefined) this.entries.clear();
    else this.entries.delete(repoId);
  }

  private drop(repoId: string, entry: Entry): void {
    if (this.entries.get(repoId) === entry) this.entries.delete(repoId);
  }
}
