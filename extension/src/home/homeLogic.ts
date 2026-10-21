// Pure home-view logic (no vscode imports): branch card formatting, launchpad
// glimpse selection, and get-started visibility.

/** Subset of status/summary the branch card renders. */
export interface BranchStatus {
  branch: string;
  upstream?: string;
  ahead: number;
  behind: number;
  staged: readonly unknown[];
  unstaged: readonly unknown[];
  untracked: readonly string[];
  conflicted: readonly string[];
}

/** "↑n ↓m" arrows; empty string when in sync with the upstream. */
export function formatAheadBehind(ahead: number, behind: number): string {
  const parts: string[] = [];
  if (ahead > 0) parts.push(`↑${ahead}`);
  if (behind > 0) parts.push(`↓${behind}`);
  return parts.join(' ');
}

/** "n conflicted, n staged, n unstaged, n untracked" listing only non-zero
 *  counts. Conflicts come first: nothing else can proceed until they are
 *  resolved. */
export function formatDirtySummary(status: BranchStatus): string {
  const parts: string[] = [];
  if (status.conflicted.length > 0) parts.push(`${status.conflicted.length} conflicted`);
  if (status.staged.length > 0) parts.push(`${status.staged.length} staged`);
  if (status.unstaged.length > 0) parts.push(`${status.unstaged.length} unstaged`);
  if (status.untracked.length > 0) parts.push(`${status.untracked.length} untracked`);
  return parts.length > 0 ? parts.join(', ') : 'clean';
}

/** Branch card description: arrows, upstream, and dirty-state summary. */
export function branchCardDescription(status: BranchStatus): string {
  const parts: string[] = [];
  const arrows = formatAheadBehind(status.ahead, status.behind);
  if (arrows) parts.push(arrows);
  parts.push(status.upstream ?? 'no upstream');
  parts.push(formatDirtySummary(status));
  return parts.join(' · ');
}

export const GLIMPSE_LIMIT = 3;

/** Buckets surfaced first in the glimpse (most actionable). */
const GLIMPSE_PRIORITY: readonly string[] = ['blocked', 'needs-your-review'];

export interface GlimpseGroup<T> {
  bucket: string;
  items: readonly T[];
}

export interface GlimpseEntry<T> {
  bucket: string;
  item: T;
}

/**
 * Picks the most-actionable PRs for the home glimpse: blocked first, then
 * needs-your-review, then the remaining buckets in the given order. Snoozed
 * items never appear; the result is capped at `limit`.
 */
export function glimpsePrs<T>(
  groups: readonly GlimpseGroup<T>[],
  limit: number = GLIMPSE_LIMIT,
): GlimpseEntry<T>[] {
  const picked: GlimpseEntry<T>[] = [];
  for (const bucket of GLIMPSE_PRIORITY) {
    for (const group of groups) {
      if (group.bucket !== bucket) continue;
      for (const item of group.items) picked.push({ bucket, item });
    }
  }
  for (const group of groups) {
    if (GLIMPSE_PRIORITY.includes(group.bucket) || group.bucket === 'snoozed') continue;
    for (const item of group.items) picked.push({ bucket: group.bucket, item });
  }
  return picked.slice(0, limit);
}

/** The get-started section shows until the user dismisses it. */
export function showGetStarted(dismissed: boolean | undefined): boolean {
  return dismissed !== true;
}
