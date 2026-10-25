// Runs a commit search on the engine, shared by the Search & Compare view and
// AI search: search/commits (libgit2) answers message, author and sha
// criteria, search/log (git log) adds code changes, paths and dates. Where
// the engine may not run git (Restricted Mode, no git CLI, the web), a search
// whose only git-only criterion is a date window still works: the libgit2
// search reads the message and author matches and the window is applied here.

import { CommitSummaryInfo, ErrorCodes } from '@gitglasses/protocol';
import type { CancellationLike, EngineClient } from '@gitglasses/rpc';
import { CommitSearchQuery, inDateWindow, needsGitLog } from './searchQuery';

/** How many message and author matches a date search reads when the date
 *  window is applied here; older history is not searched. */
export const DATE_SCAN_LIMIT = 5000;

export interface CommitSearchRequest {
  repoId: string;
  streamId: string;
  limit: number;
  query: CommitSearchQuery;
}

export interface CommitSearchOutcome {
  /** More matches may exist than were delivered. */
  truncated: boolean;
  /** The date window was applied here and the scan stopped before the start
   *  of history, so older commits were not searched. */
  partial: boolean;
}

/** True when the engine refused a method because it may not run git. */
export function isGitRefusal(error: unknown): boolean {
  const code = (error as { code?: unknown } | undefined)?.code;
  return code === ErrorCodes.Restricted || code === ErrorCodes.MethodNotSupported;
}

/** Runs the search, handing matches to `onMatches` as they stream in. */
export async function searchCommitHistory(
  engine: EngineClient,
  request: CommitSearchRequest,
  onMatches: (matches: CommitSummaryInfo[]) => void,
  token?: CancellationLike,
): Promise<CommitSearchOutcome> {
  const { repoId, streamId, limit, query } = request;
  const { text, author, sha } = query;
  let window: ((commit: CommitSummaryInfo) => boolean) | undefined;
  let delivered = 0;
  let overflow = false;
  const sub = engine.onNotification('search/matches', (params) => {
    if (params.streamId !== streamId || token?.isCancellationRequested) return;
    let matches = params.matches;
    if (window) {
      matches = matches.filter(window);
      if (delivered + matches.length > limit) {
        overflow = true;
        matches = matches.slice(0, limit - delivered);
      }
    }
    delivered += matches.length;
    if (matches.length > 0) onMatches(matches);
  });
  try {
    if (!needsGitLog(query)) {
      const params = { repoId, streamId, limit, query: { text, author, sha } };
      const { truncated } = await engine.request('search/commits', params, token);
      return { truncated, partial: false };
    }
    try {
      const { sha: _sha, ...logQuery } = query;
      const params = { repoId, streamId, limit, query: logQuery };
      const { truncated } = await engine.request('search/log', params, token);
      return { truncated, partial: false };
    } catch (error) {
      if (!isGitRefusal(error) || query.content !== undefined || query.path !== undefined) {
        throw error;
      }
    }
    window = (commit) => inDateWindow(query, commit.committer.time);
    const params = { repoId, streamId, limit: DATE_SCAN_LIMIT, query: { text, author } };
    const { truncated } = await engine.request('search/commits', params, token);
    return { truncated: overflow || truncated, partial: truncated };
  } finally {
    sub.dispose();
  }
}
