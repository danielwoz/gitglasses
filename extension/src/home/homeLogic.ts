// Pure home-view logic (no vscode imports): branch card formatting and
// actions, launchpad glimpse selection, get-started visibility and the
// walkthrough's tab check.

import { shortSha } from '@gitglasses/protocol/sha';

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

/** Where HEAD points, as repo/state reports it. */
export interface HeadInfo {
  /** The branch HEAD names; for an unborn HEAD, the branch the first commit
   *  creates (empty from engines that do not report it). */
  branch: string;
  oid: string;
  detached: boolean;
  unborn: boolean;
}

/** Branch card title: the branch, or what HEAD is when it names none. */
export function branchCardTitle(status: BranchStatus, head?: HeadInfo): string {
  if (head?.unborn) return head.branch || status.branch || 'No commits yet';
  if (head?.detached) return head.oid ? `HEAD detached at ${shortSha(head.oid)}` : 'HEAD detached';
  return status.branch || head?.branch || 'HEAD detached';
}

/** Branch card description: arrows, upstream, and dirty-state summary. An
 *  unborn branch has no upstream to compare with, only its first commit to
 *  make; a detached HEAD tracks nothing. */
export function branchCardDescription(status: BranchStatus, head?: HeadInfo): string {
  const parts: string[] = [];
  if (head?.unborn) {
    parts.push('no commits yet');
  } else if (head?.detached) {
    parts.push('no branch');
  } else {
    const arrows = formatAheadBehind(status.ahead, status.behind);
    if (arrows) parts.push(arrows);
    parts.push(status.upstream ?? 'no upstream');
  }
  parts.push(formatDirtySummary(status));
  return parts.join(' · ');
}

export type BranchAction = 'commit' | 'push' | 'publish' | 'pull' | 'switchBranch' | 'createBranch';

/**
 * The quick actions the branch card offers. Push appears only with commits
 * to push and Pull only with an upstream to pull from; a branch with no
 * upstream is published instead, when there is a remote to publish to. An
 * unborn branch has nothing to push, switch from or branch off yet, so it
 * offers the commit that makes it real.
 */
export function branchCardActions(
  status: BranchStatus,
  head: HeadInfo | undefined,
  hasRemote: boolean,
): BranchAction[] {
  if (head?.unborn) return ['commit'];
  const actions: BranchAction[] = ['commit'];
  if (!head?.detached) {
    if (status.upstream) {
      if (status.ahead > 0) actions.push('push');
      actions.push('pull');
    } else if (hasRemote) {
      actions.push('publish');
    }
  }
  actions.push('switchBranch', 'createBranch');
  return actions;
}

/** The label of a branch card action, with the commit counts that apply. */
export function branchActionLabel(action: BranchAction, status: BranchStatus): string {
  const commits = (count: number): string => `${count} commit${count === 1 ? '' : 's'}`;
  switch (action) {
    case 'commit':
      return 'Commit…';
    case 'push':
      return `Push ${commits(status.ahead)}`;
    case 'publish':
      return 'Publish Branch';
    case 'pull':
      return status.behind > 0 ? `Pull ${commits(status.behind)}` : 'Pull';
    case 'switchBranch':
      return 'Switch Branch…';
    case 'createBranch':
      return 'Create Branch…';
  }
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

/** The walkthrough contributed in package.json, as openWalkthrough names it. */
export const WALKTHROUGH_ID = 'gitglasses.gitglasses#gitglasses.getStarted';
export const WALKTHROUGH_TITLE = 'Get Started with GitGlasses';

/**
 * What the active tab says about an attempt to open the walkthrough: 'shown'
 * when its title names ours, 'welcome' for the Welcome editor showing a
 * walkthrough it does not name (recent VS Code releases title every
 * walkthrough tab "Welcome"; browser hosts fall back to their own setup
 * walkthrough when asked for one that has not registered yet), and
 * 'elsewhere' for any other tab, which means the user has moved on.
 */
export function walkthroughTabState(label: string | undefined): 'shown' | 'welcome' | 'elsewhere' {
  if (label === `Walkthrough: ${WALKTHROUGH_TITLE}`) return 'shown';
  if (label === 'Welcome' || label?.startsWith('Walkthrough: ')) return 'welcome';
  return 'elsewhere';
}

/** On browser hosts, extension walkthroughs register about five seconds
 *  after the Welcome editor first starts in a window; this allows for a
 *  busy page. */
export const WALKTHROUGHS_REGISTERED_AFTER_MS = 7000;

/**
 * When to ask a browser host for the walkthrough again: once the extension
 * walkthroughs have registered, and only if the request came before that,
 * when the host showed its own walkthrough instead. A later request finds
 * ours registered, and asking again would rebuild the walkthrough page and
 * drop the step the user picked.
 */
export function walkthroughRetryAt(
  requestedAt: number,
  welcomeStartedAt: number,
): number | undefined {
  const registeredAt = welcomeStartedAt + WALKTHROUGHS_REGISTERED_AFTER_MS;
  return requestedAt < registeredAt ? registeredAt : undefined;
}
