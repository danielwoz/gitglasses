import { BlameCommit, BlameHunk, BlameOptions, ErrorCodes } from '@gitglasses/protocol';
import { CancellationLike, EngineClient, EngineError, EngineRestartedError } from '@gitglasses/rpc';

export interface FileBlame {
  hunks: BlameHunk[];
  commits: Record<string, BlameCommit>;
  totalLines: number;
  /** Tracked with Git LFS: the hunks describe the pointer file's lines. */
  lfs: boolean;
}

export interface BlameKey {
  repoId: string;
  path: string;
  /** Editor buffer version, as pushed through DocumentSync; -1 = the file on
   *  disk (or the revision, when `rev` is set). */
  version: number;
  /** Revision to blame; omitted blames the working tree. */
  rev?: string;
  /** Attribution options; part of the key. */
  options?: BlameOptions;
}

/** The engine answered for a different buffer than the one asked about (the
 *  pushed buffer was evicted or never arrived). Nothing is cached; the caller
 *  pushes the buffer again and retries. */
export class StaleBlameError extends Error {
  constructor(
    readonly requested: number,
    readonly answered: number,
  ) {
    super(`blame answered for buffer version ${answered}, not ${requested}`);
    this.name = 'StaleBlameError';
  }
}

/** Cache budget. One entry holds every hunk and every commit for a file, so
 *  entry count says little about memory; bytes bound it. */
export const MAX_CACHE_BYTES = 32 * 1024 * 1024;
/** Second bound, so many small files cannot grow the map without limit. */
export const MAX_CACHE_ENTRIES = 200;

/** How long a shared request outlives its last waiter. A caller that cancels
 *  and asks again for the same key (a cursor moving within one file) rejoins
 *  the running request instead of restarting git blame. */
export const ABANDON_GRACE_MS = 1000;

/** Version standing for the on-disk contents rather than a dirty buffer. */
export const ON_DISK_VERSION = -1;

/** Bound on the set of failures already logged once. */
const MAX_LOGGED_FAILURES = 200;

// Per-object allowances covering the fixed-width fields and the JS runtime's
// object headers; the variable-length strings are counted exactly.
const HUNK_OVERHEAD_BYTES = 120;
const COMMIT_OVERHEAD_BYTES = 200;

/** A cancellation source owned by the model, never by a caller. */
class InternalCancellation implements CancellationLike {
  isCancellationRequested = false;
  private listeners = new Set<() => void>();

  onCancellationRequested(listener: () => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  cancel(): void {
    if (this.isCancellationRequested) return;
    this.isCancellationRequested = true;
    for (const listener of [...this.listeners]) listener();
    this.listeners.clear();
  }
}

interface CacheEntry {
  promise: Promise<FileBlame>;
  repoId: string;
  path: string;
  version: number;
  rev?: string;
  /** Approximate retained bytes; 0 until the request resolves. */
  bytes: number;
  /** Cancels the engine request; fired only by the model. */
  cancellation: InternalCancellation;
  settled: boolean;
  /** Callers waiting with a cancellation token. */
  waiters: number;
  /** Some caller waits without a token, so the request is never abandoned. */
  pinned: boolean;
  abandonTimer?: ReturnType<typeof setTimeout>;
}

/** Stable text for a set of options, defaults filled in. */
export function optionsKey(options: BlameOptions | undefined): string {
  return [
    options?.ignoreWhitespace === true ? 'w' : '',
    options?.moves ?? 'off',
    options?.ignoreRevs === false ? 'no-ignore-revs' : 'ignore-revs',
  ].join(',');
}

/**
 * Whether a file's contents change how other files of its repository are
 * blamed, so saving it drops the repository's blame rather than its own:
 * .mailmap (and a mailmap.file named like it) maps author names, an
 * ignore-revs file lists the commits blame looks through, and a
 * .gitattributes in any directory decides which paths are Git LFS.
 */
export function affectsOtherFilesBlame(relativePath: string): boolean {
  const name = (relativePath.split('/').pop() ?? '').toLowerCase();
  return (
    name === '.gitattributes' ||
    name === '.mailmap' ||
    name === 'mailmap' ||
    name.includes('ignore-revs') ||
    name.includes('ignorerevs')
  );
}

function cacheKeyFor(key: BlameKey): string {
  return `${key.repoId}\0${key.path}\0${key.rev ?? ''}\0${key.version}\0${optionsKey(key.options)}`;
}

function cancelled(): EngineError {
  return new EngineError(ErrorCodes.Cancelled, 'cancelled');
}

/** Approximate retained size of a blame result; string payloads dominate. */
export function estimateBlameBytes(blame: Pick<FileBlame, 'hunks' | 'commits'>): number {
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

// Whole-file blame cache: the engine is asked once per (repo, path, revision,
// buffer version, options); cursor movement is a purely local hunk lookup.
// Concurrent callers share the in-flight request, which no caller's
// cancellation can stop: each caller stops waiting on its own, and the
// request is cancelled only when it is superseded or invalidated, or when
// every caller has left and none has come back for a moment. Eviction is
// least-recently-used against a byte budget, and superseded versions of a
// file are dropped on insert.
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
    private readonly abandonGraceMs: number = ABANDON_GRACE_MS,
  ) {}

  getBlame(key: BlameKey, token?: CancellationLike): Promise<FileBlame> {
    const cacheKey = cacheKeyFor(key);
    let entry = this.cache.get(cacheKey);
    if (entry) {
      this.touch(cacheKey, entry);
    } else {
      entry = this.request(key, cacheKey);
    }
    return this.join(entry, token);
  }

  hunkForLine(blame: FileBlame, line1Based: number): BlameHunk | undefined {
    return blame.hunks.find(
      (h) => line1Based >= h.resultLine && line1Based < h.resultLine + h.lineCount,
    );
  }

  /** Drop cached blame for a repo (on HEAD/index change) or everything. */
  invalidate(repoId?: string): void {
    for (const [cacheKey, entry] of this.cache) {
      if (repoId === undefined || entry.repoId === repoId) this.remove(cacheKey, true);
    }
  }

  /** Drop cached blame for one file of a repo, every version and revision. */
  invalidatePath(repoId: string, path: string): void {
    for (const [cacheKey, entry] of this.cache) {
      if (entry.repoId === repoId && entry.path === path) this.remove(cacheKey, true);
    }
  }

  /** Drop what a saved file invalidates: its own blame on disk, or the
   *  repository's when the file changes how other files are blamed. */
  invalidateSaved(repoId: string, path: string): void {
    if (affectsOtherFilesBlame(path)) this.invalidate(repoId);
    else this.invalidatePath(repoId, path);
  }

  /** Entry count and approximate bytes held, for tests and diagnostics. */
  stats(): { entries: number; bytes: number } {
    return { entries: this.cache.size, bytes: this.totalBytes };
  }

  private request(key: BlameKey, cacheKey: string): CacheEntry {
    this.evictSuperseded(key);

    const streamId = `b${this.streamCounter++}`;
    const hunks: BlameHunk[] = [];
    const sub = this.engine.onNotification('blame/hunks', (params) => {
      if (params.streamId === streamId) hunks.push(...params.hunks);
    });
    const cancellation = new InternalCancellation();
    const workingTree = key.rev === undefined;

    const promise = this.engine
      .request(
        'blame/file',
        {
          repoId: key.repoId,
          path: key.path,
          streamId,
          ...(workingTree ? { docVersion: key.version } : { rev: key.rev }),
          ...(key.options ? { options: key.options } : {}),
        },
        cancellation,
      )
      .then((result) => {
        // An engine that predates docVersion leaves it out.
        if (workingTree && result.docVersion !== undefined && result.docVersion !== key.version) {
          throw new StaleBlameError(key.version, result.docVersion);
        }
        return {
          hunks,
          commits: result.commits,
          totalLines: result.totalLines,
          lfs: result.lfs === true,
        };
      })
      .finally(() => sub.dispose());

    const entry: CacheEntry = {
      promise,
      repoId: key.repoId,
      path: key.path,
      version: key.version,
      rev: key.rev,
      bytes: 0,
      cancellation,
      settled: false,
      waiters: 0,
      pinned: false,
    };
    this.cache.set(cacheKey, entry);
    this.evictToBudget();

    promise.then(
      (blame) => {
        entry.settled = true;
        clearTimeout(entry.abandonTimer);
        // Invalidation or eviction may have dropped the entry while the
        // request was in flight.
        if (this.cache.get(cacheKey) !== entry) return;
        entry.bytes = estimateBlameBytes(blame);
        this.totalBytes += entry.bytes;
        this.evictToBudget();
      },
      // A failed/cancelled request must not poison the cache.
      (error: unknown) => {
        entry.settled = true;
        clearTimeout(entry.abandonTimer);
        if (this.cache.get(cacheKey) === entry) this.remove(cacheKey, false);
        this.reportFailure(key, error);
      },
    );
    return entry;
  }

  /** The entry's result for one caller, who may stop waiting through its own
   *  token without affecting anyone else. */
  private join(entry: CacheEntry, token?: CancellationLike): Promise<FileBlame> {
    if (!token) {
      entry.pinned = true;
      clearTimeout(entry.abandonTimer);
      return entry.promise;
    }
    if (token.isCancellationRequested) return Promise.reject(cancelled());
    entry.waiters++;
    clearTimeout(entry.abandonTimer);
    return new Promise<FileBlame>((resolve, reject) => {
      let left = false;
      const leave = (): void => {
        if (left) return;
        left = true;
        subscription.dispose();
        entry.waiters--;
        if (entry.waiters === 0 && !entry.pinned && !entry.settled) this.scheduleAbandon(entry);
      };
      const subscription = token.onCancellationRequested(() => {
        leave();
        reject(cancelled());
      });
      entry.promise.then(
        (blame) => {
          leave();
          resolve(blame);
        },
        (error: unknown) => {
          leave();
          reject(error);
        },
      );
    });
  }

  /** Cancels a request nobody waits for any more, unless a caller rejoins
   *  within the grace period. */
  private scheduleAbandon(entry: CacheEntry): void {
    clearTimeout(entry.abandonTimer);
    entry.abandonTimer = setTimeout(() => {
      if (entry.waiters === 0 && !entry.pinned && !entry.settled) {
        entry.cancellation.cancel();
      }
    }, this.abandonGraceMs);
  }

  /** Logs a failed request once per file and message. Cancellation, an
   *  engine restart and an answer for another buffer are routine and not
   *  reported. */
  private reportFailure(key: BlameKey, error: unknown): void {
    if (!this.log || error instanceof EngineRestartedError || error instanceof StaleBlameError) {
      return;
    }
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

  /** Forgets an entry. `stop` also cancels its request when still running:
   *  nobody can be served by an invalidated or superseded answer. */
  private remove(cacheKey: string, stop: boolean): void {
    const entry = this.cache.get(cacheKey);
    if (!entry) return;
    this.cache.delete(cacheKey);
    this.totalBytes -= entry.bytes;
    if (stop && !entry.settled) entry.cancellation.cancel();
  }

  /** Drops least-recently-used entries until both budgets are met, always
   *  keeping the most recently used one. A running request dropped here
   *  still answers the callers waiting for it. */
  private evictToBudget(): void {
    while (
      this.cache.size > 1 &&
      (this.cache.size > this.maxEntries || this.totalBytes > this.maxBytes)
    ) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) return;
      this.remove(oldest, false);
    }
  }

  /** Drops cached versions of the same file that can never be asked for again:
   *  document versions only increase, so any buffer version below the incoming
   *  one is dead, as is every buffer version once the buffer matches disk. */
  private evictSuperseded(key: BlameKey): void {
    if (key.rev !== undefined) return;
    for (const [cacheKey, entry] of this.cache) {
      if (entry.repoId !== key.repoId || entry.path !== key.path) continue;
      if (entry.rev !== undefined || entry.version === ON_DISK_VERSION) continue;
      if (key.version === ON_DISK_VERSION || entry.version < key.version) {
        this.remove(cacheKey, true);
      }
    }
  }
}
