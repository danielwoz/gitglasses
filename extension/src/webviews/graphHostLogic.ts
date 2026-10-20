// Pure decisions behind the commit graph host (no vscode imports), so they
// are unit-testable: what a repository change refreshes, how many rows a
// refresh reloads, the branch filter's options and the find queries.

import type { RequestResult } from '@gitglasses/protocol';
import type { BranchOption } from '../../webviews-src/graph/ipc';

/** What a repo/didChange notification asks the graph to do. */
export type RefreshKind = 'replace' | 'wip' | 'none';

/** Ref, HEAD and stash moves change rows and lanes, so every loaded row is
 *  fetched again; an index-only change can only add or drop the WIP row. */
export function refreshFor(changed: readonly string[]): RefreshKind {
  if (changed.some((kind) => kind === 'HEAD' || kind === 'refs' || kind === 'stash')) {
    return 'replace';
  }
  return changed.includes('index') ? 'wip' : 'none';
}

/** Most rows one refresh reloads. Deeper pages load again on scroll. */
export const MAX_REPLACE_ROWS = 10000;

/** Rows a refresh asks for: as many as are loaded, so the view keeps its
 *  place, at least one page and at most MAX_REPLACE_ROWS. */
export function replaceLimit(loadedRows: number, pageSize: number): number {
  return Math.min(MAX_REPLACE_ROWS, Math.max(pageSize, loadedRows));
}

/** The engine's refusal of a cursor taken before the refs moved. */
export function isStaleCursorError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /stale cursor/i.test(message);
}

/** The branch filter's entries: local branches (the current one first), then
 *  remote-tracking branches, skipping each remote's symbolic HEAD. */
export function branchOptions(refs: RequestResult<'refs/list'>): BranchOption[] {
  const local = refs.branches
    .map((branch) => ({
      name: branch.name,
      ref: `refs/heads/${branch.name}`,
      kind: 'branch' as const,
      current: branch.current,
    }))
    .sort((a, b) => Number(b.current) - Number(a.current) || a.name.localeCompare(b.name));
  const remote = refs.remotes.flatMap((remote) =>
    remote.branches
      .filter((branch) => branch.name !== 'HEAD')
      .map((branch) => {
        const name = `${remote.name}/${branch.name}`;
        return { name, ref: `refs/remotes/${name}`, kind: 'remote' as const, current: false };
      }),
  );
  remote.sort((a, b) => a.name.localeCompare(b.name));
  return [...local, ...remote];
}

/** The filter that still applies once the branches are known: names that no
 *  longer exist are dropped, and an empty result means every branch. */
export function liveFilter(
  filter: readonly string[] | undefined,
  options: readonly BranchOption[],
): string[] | undefined {
  if (!filter) return undefined;
  const known = new Set(options.map((option) => option.ref));
  const kept = filter.filter((ref) => known.has(ref));
  return kept.length > 0 ? kept : undefined;
}

export type SearchQuery = { text?: string; author?: string; sha?: string };

/** search/commits ANDs its criteria, so the find box runs one search per
 *  field and joins the matches: message, author, and sha when the text could
 *  be one. */
export function findQueries(query: string): SearchQuery[] {
  const text = query.trim();
  if (!text) return [];
  const queries: SearchQuery[] = [{ text }, { author: text }];
  if (/^[0-9a-f]{4,40}$/i.test(text)) queries.push({ sha: text.toLowerCase() });
  return queries;
}

/** stash@{n} of a stash row's refs, or undefined. */
export function stashIndexOf(refs: readonly { name: string; kind: string }[]): number | undefined {
  for (const ref of refs) {
    const match = ref.kind === 'stash' ? /^stash@\{(\d+)\}$/.exec(ref.name) : null;
    if (match) return Number(match[1]);
  }
  return undefined;
}

/** The local branch a remote-tracking branch checks out as: origin/feature/x
 *  becomes feature/x. The remote is matched by the longest configured name, so
 *  remote names containing '/' split correctly. */
export function localNameFor(remoteBranch: string, remotes: readonly string[] = []): string {
  const remote = remotes
    .filter((name) => remoteBranch.startsWith(`${name}/`))
    .sort((a, b) => b.length - a.length)[0];
  if (remote) return remoteBranch.slice(remote.length + 1);
  const slash = remoteBranch.indexOf('/');
  return slash < 0 ? remoteBranch : remoteBranch.slice(slash + 1);
}

/** Lane cap the setting asks for, falling back for anything out of range. */
export function maxLanesSetting(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_MAX_LANES;
  return Math.min(200, Math.max(4, Math.round(value)));
}

export const DEFAULT_MAX_LANES = 20;
