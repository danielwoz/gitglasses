import { BlameCommit, BlameHunk, ErrorCodes } from '@gitglasses/protocol';
import { CancellationLike, EngineClient, EngineRestartedError } from '@gitglasses/rpc';

export interface FileBlame {
  hunks: BlameHunk[];
  commits: Record<string, BlameCommit>;
  totalLines: number;
}

export interface BlameKey {
  repoId: string;
  path: string;
  /** Document version; bump invalidates. -1 = on-disk contents. */
  version: number;
}

/** Cache budget. One entry holds every hunk and every commit for a file, so
 *  entry count says little about memory; bytes bound it. */
export const MAX_CACHE_BYTES = 32 * 1024 * 1024;
/** Second bound, so many small files cannot grow the map without limit. */
export const MAX_CACHE_ENTRIES = 200;

/** Version standing for the on-disk contents rather than a dirty buffer. */
const ON_DISK_VERSION = -1;

/** Bound on the set of failures already logged once. */
const MAX_LOGGED_FAILURES = 200;

// Per-object allowances covering the fixed-width fields and the JS runtime's
// object headers; the variable-length strings are counted exactly.
const HUNK_OVERHEAD_BYTES = 120;
const COMMIT_OVERHEAD_BYTES = 200;

interface CacheEntry {
  promise: Promise<FileBlame>;
  repoId: string;
  path: string;
  version: number;
  /** Approximate retained bytes; 0 until the request resolves. */
  bytes: number;
}

function cacheKeyFor(key: BlameKey): string {
  return `${key.repoId}\0${key.path}\0${key.version}`;
}

/** Approximate retained size of a blame result; string payloads dominate. */
export function estimateBlameBytes(blame: FileBlame): number {
  let bytes = 0;
  for (const hunk of blame.hunks) {
    bytes += HUNK_OVERHEAD_BYTES + (hunk.sha.length + hunk.path.length) * 2;
    if (hunk.previous) bytes += (hunk.previous.sha.length + hunk.previous.path.length) * 2;
  }
  for (const sha of Object.keys(blame.commits)) {
    const commit = blame.commits[sha];
    bytes +=
      COMMIT_OVERHEAD_BYTES +
      (sha.length +
        commit.summary.length +
        commit.author.name.length +
        commit.author.email.length +
        commit.committer.name.length +
        commit.committer.email.length) *
        2;
  }
  return bytes;
}

// Whole-file blame cache: the engine is asked once per (repo, path, version);
// cursor movement is a purely local hunk lookup. Concurrent callers coalesce
// onto the in-flight request. Eviction is least-recently-used against a byte
// budget, and superseded versions of a file are dropped on insert.
export class BlameModel {
  private cache = new Map<string, CacheEntry>();
  private streamCounter = 0;
  private totalBytes = 0;
  private loggedFailures = new Set<string>();

  constructor(
    private readonly engine: EngineClient,
    private readonly maxBytes: number = MAX_CACHE_BYTES,
    private readonly maxEntries: number = MAX_CACHE_ENTRIES,
    /** Writes a line to the host's log; failed blame requests are reported
     *  here once each, since the editor surfaces show nothing for them. */
    private readonly log?: (line: string) => void,
  ) {}

  getBlame(key: BlameKey, token?: CancellationLike): Promise<FileBlame> {
    const cacheKey = cacheKeyFor(key);
    const existing = this.cache.get(cacheKey);
    if (existing) {
      this.touch(cacheKey, existing);
      return existing.promise;
    }

    this.evictSuperseded(key);

    const streamId = `b${this.streamCounter++}`;
    const hunks: BlameHunk[] = [];
    const sub = this.engine.onNotification('blame/hunks', (params) => {
      if (params.streamId === streamId) hunks.push(...params.hunks);
    });

    const promise = this.engine
      .request('blame/file', { repoId: key.repoId, path: key.path, streamId }, token)
      .then((result) => ({
        hunks,
        commits: result.commits,
        totalLines: result.totalLines,
      }))
      .finally(() => sub.dispose());

    const entry: CacheEntry = {
      promise,
      repoId: key.repoId,
      path: key.path,
      version: key.version,
      bytes: 0,
    };
    this.cache.set(cacheKey, entry);
    this.evictToBudget();

    promise.then(
      (blame) => {
        // Invalidation or eviction may have dropped the entry while the
        // request was in flight.
        if (this.cache.get(cacheKey) !== entry) return;
        entry.bytes = estimateBlameBytes(blame);
        this.totalBytes += entry.bytes;
        this.evictToBudget();
      },
      // A failed/cancelled request must not poison the cache.
      (error: unknown) => {
        this.remove(cacheKey);
        this.reportFailure(key, error);
      },
    );
    return promise;
  }

  hunkForLine(blame: FileBlame, line1Based: number): BlameHunk | undefined {
    return blame.hunks.find(
      (h) => line1Based >= h.resultLine && line1Based < h.resultLine + h.lineCount,
    );
  }

  /** Drop cached blame for a repo (on HEAD/index change) or everything. */
  invalidate(repoId?: string): void {
    if (repoId === undefined) {
      this.cache.clear();
      this.totalBytes = 0;
      return;
    }
    for (const [cacheKey, entry] of this.cache) {
      if (entry.repoId === repoId) this.remove(cacheKey);
    }
  }

  /** Entry count and approximate bytes held, for tests and diagnostics. */
  stats(): { entries: number; bytes: number } {
    return { entries: this.cache.size, bytes: this.totalBytes };
  }

  /** Logs a failed request once per file and message. Cancellation and an
   *  engine restart are routine and not reported. */
  private reportFailure(key: BlameKey, error: unknown): void {
    if (!this.log || error instanceof EngineRestartedError) return;
    if ((error as { code?: unknown } | undefined)?.code === ErrorCodes.Cancelled) return;
    const message = error instanceof Error ? error.message : String(error);
    const id = `${key.repoId}\0${key.path}\0${message}`;
    if (this.loggedFailures.has(id)) return;
    if (this.loggedFailures.size >= MAX_LOGGED_FAILURES) this.loggedFailures.clear();
    this.loggedFailures.add(id);
    this.log(`blame failed for ${key.path} in ${key.repoId}: ${message}`);
  }

  /** Moves an entry to the most-recently-used end. Map iterates in insertion
   *  order, so re-inserting is what makes eviction LRU rather than FIFO. */
  private touch(cacheKey: string, entry: CacheEntry): void {
    this.cache.delete(cacheKey);
    this.cache.set(cacheKey, entry);
  }

  private remove(cacheKey: string): void {
    const entry = this.cache.get(cacheKey);
    if (!entry) return;
    this.cache.delete(cacheKey);
    this.totalBytes -= entry.bytes;
  }

  /** Drops least-recently-used entries until both budgets are met, always
   *  keeping the most recently used one. */
  private evictToBudget(): void {
    while (
      this.cache.size > 1 &&
      (this.cache.size > this.maxEntries || this.totalBytes > this.maxBytes)
    ) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) return;
      this.remove(oldest);
    }
  }

  /** Drops cached versions of the same file that can never be asked for again:
   *  document versions only increase, so any buffer version below the incoming
   *  one is dead, as is every buffer version once the buffer matches disk. */
  private evictSuperseded(key: BlameKey): void {
    for (const [cacheKey, entry] of this.cache) {
      if (entry.repoId !== key.repoId || entry.path !== key.path) continue;
      if (entry.version === ON_DISK_VERSION) continue;
      if (key.version === ON_DISK_VERSION || entry.version < key.version) {
        this.remove(cacheKey);
      }
    }
  }
}
