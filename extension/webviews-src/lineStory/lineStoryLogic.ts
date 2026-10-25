// Pure helpers behind the Line Story panel (no DOM), so they are
// unit-testable: what each part of a story says when it has nothing to list,
// the rows of a version's diff, and the facts lines of the blame and the
// pull requests.

import type {
  LineStory,
  StoryBlame,
  StoryPullRequest,
  StoryPullRequests,
  StorySection,
} from '@gitglasses/integrations';
import { relativeTime } from '../graph/graphLogic';

/** A message for a part of the story, with the action it offers. */
export interface Notice {
  text: string;
  action?: { label: string; message: 'connect' | 'manageTrust' | 'openWorkingChanges' };
}

/** One row of a version's diff. */
export interface DiffRow {
  kind: 'hunk' | 'add' | 'del' | 'context' | 'note';
  text: string;
}

/**
 * The rows of a `git log -L` diff the panel shows: the hunks, without the
 * diff --git/---/+++ headers that only repeat the file's name.
 */
export function diffRows(patch: string): DiffRow[] {
  const rows: DiffRow[] = [];
  let inHunk = false;
  for (const line of patch.replace(/\n$/, '').split('\n')) {
    if (line.startsWith('diff --git ')) {
      inHunk = false;
      continue;
    }
    if (line.startsWith('@@')) {
      inHunk = true;
      rows.push({ kind: 'hunk', text: line });
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith('+')) rows.push({ kind: 'add', text: line });
    else if (line.startsWith('-')) rows.push({ kind: 'del', text: line });
    else if (line.startsWith('\\')) rows.push({ kind: 'note', text: line });
    else rows.push({ kind: 'context', text: line });
  }
  return rows;
}

/**
 * The file's path before a version's change, from its diff's "--- a/<path>"
 * header: undefined when the change created the file, and `path` itself when
 * the header cannot be read.
 */
export function previousPathOf(patch: string | undefined, path: string): string | undefined {
  for (const line of (patch ?? '').split('\n')) {
    if (line === '--- /dev/null') return undefined;
    if (line.startsWith('--- a/')) return line.slice('--- a/'.length);
    if (line.startsWith('@@')) break;
  }
  return path;
}

/** Seconds since the epoch of an ISO date, or undefined. */
export function isoSeconds(iso: string | undefined): number | undefined {
  if (!iso) return undefined;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? undefined : Math.floor(ms / 1000);
}

/** "1 review comment", "3 comments". */
export function countText(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? '' : 's'}`;
}

export function pullRequestStateLabel(pr: Pick<StoryPullRequest, 'state' | 'draft'>): string {
  if (pr.state === 'merged') return 'Merged';
  if (pr.state === 'closed') return 'Closed';
  return pr.draft ? 'Draft' : 'Open';
}

/** The facts under a pull request's title. */
export function pullRequestFacts(pr: StoryPullRequest, nowSeconds?: number): string[] {
  const facts = [`by ${pr.author}`];
  const merged = isoSeconds(pr.mergedAt);
  if (merged !== undefined) facts.push(`merged ${relativeTime(merged, nowSeconds)}`);
  else {
    const opened = isoSeconds(pr.createdAt);
    if (opened !== undefined) facts.push(`opened ${relativeTime(opened, nowSeconds)}`);
  }
  if (pr.baseRef) facts.push(`into ${pr.baseRef}`);
  if (pr.reviewCommentCount !== undefined) {
    facts.push(countText(pr.reviewCommentCount, 'review comment'));
  }
  if (pr.commentCount !== undefined) facts.push(countText(pr.commentCount, 'comment'));
  return facts;
}

/** What the blame says about the line, after the author. */
export function blameFacts(blame: StoryBlame, file: string, nowSeconds?: number): string[] {
  const facts = [relativeTime(blame.author.time, nowSeconds)];
  const last = blame.hunkStart + blame.hunkLines - 1;
  facts.push(
    blame.hunkLines === 1
      ? `line ${blame.hunkStart} last changed here`
      : `lines ${blame.hunkStart}–${last} last changed together`,
  );
  if (blame.path !== file) facts.push(`then ${blame.path}:${blame.originalLine}`);
  else if (blame.originalLine !== blame.line) facts.push(`then line ${blame.originalLine}`);
  if (blame.boundary) facts.push('at the edge of this shallow clone');
  return facts;
}

/** What the pull request part says when it lists none, with its action. */
export function pullRequestNotice(section: StoryPullRequests): Notice | undefined {
  switch (section.state) {
    case 'loading':
      return { text: 'Looking for the pull request…' };
    case 'noForge':
      return { text: 'No remote of this repository is on a forge GitGlasses knows.' };
    case 'notConnected':
      return {
        text: `Connect ${section.forge.name} to see the pull request that merged this commit.`,
        action: { label: `Connect ${section.forge.name}`, message: 'connect' },
      };
    case 'unsupported':
      return {
        text: `GitGlasses cannot look up ${section.forge.name} pull requests by commit yet.`,
      };
    case 'unavailable':
      if (section.reason === 'restricted') {
        return {
          text: 'Pull requests are looked up once you trust this folder.',
          action: { label: 'Manage Workspace Trust', message: 'manageTrust' },
        };
      }
      return undefined;
    case 'failed':
      if (section.reason === 'auth') {
        return {
          text: `${section.forge.name} rejected the saved credential.`,
          action: { label: `Reconnect ${section.forge.name}`, message: 'connect' },
        };
      }
      if (section.reason === 'rateLimit') {
        return { text: `${section.forge.name}'s rate limit is used up; try again later.` };
      }
      if (section.reason === 'notVisible') {
        return {
          text:
            `${section.forge.name} does not show ${section.forge.owner}/${section.forge.repo} ` +
            'to the connected account, so its pull requests cannot be looked up.',
          action: { label: `Reconnect ${section.forge.name}`, message: 'connect' },
        };
      }
      return { text: `Could not ask ${section.forge.name}: ${section.message}` };
    case 'found':
      return section.pullRequests.length > 0
        ? undefined
        : {
            text:
              `${section.forge.name} knows no pull request with this commit. It may have been ` +
              'pushed straight to the branch, or a rebase merge may have rewritten it.',
          };
  }
}

/** What the earlier-versions part says when it lists none. */
export function historyNotice(section: LineStory['history']): string | undefined {
  switch (section.state) {
    case 'loading':
      return "Reading the line's history…";
    case 'failed':
      return `Could not read the line's history: ${section.message}`;
    case 'unavailable':
      if (section.reason === 'restricted') {
        return 'Earlier versions need git, which GitGlasses runs only in trusted folders.';
      }
      if (section.reason === 'noGit') {
        return 'Earlier versions need the git CLI, which this engine build does not have.';
      }
      return undefined;
    case 'ready':
      return section.value.versions.length === 0 ? 'No earlier versions.' : undefined;
  }
}

/** What a section shows while it has no value of its own. */
export function sectionNotice<T>(section: StorySection<T>, what: string): string | undefined {
  if (section.state === 'loading') return `Loading ${what}…`;
  if (section.state === 'failed') return `Could not load ${what}: ${section.message}`;
  return undefined;
}
