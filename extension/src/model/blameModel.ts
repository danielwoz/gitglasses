import { BlameCommit, BlameHunk } from '@gitglasses/protocol';
import { CancellationLike, EngineClient } from '../engine/engineClient';

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

// Whole-file blame cache: the engine is asked once per (repo, path, version);
// cursor movement is a purely local hunk lookup. Concurrent callers coalesce
// onto the in-flight request.
export class BlameModel {
  private cache = new Map<string, Promise<FileBlame>>();
  private streamCounter = 0;

  constructor(private readonly engine: EngineClient) {}

  getBlame(key: BlameKey, token?: CancellationLike): Promise<FileBlame> {
    const cacheKey = `${key.repoId}\0${key.path}\0${key.version}`;
    const existing = this.cache.get(cacheKey);
    if (existing) return existing;

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

    this.cache.set(cacheKey, promise);
    // A failed/cancelled request must not poison the cache.
    promise.catch(() => this.cache.delete(cacheKey));
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
      return;
    }
    for (const key of [...this.cache.keys()]) {
      if (key.startsWith(`${repoId}\0`)) this.cache.delete(key);
    }
  }
}
