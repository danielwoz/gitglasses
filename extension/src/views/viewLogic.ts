// Pure view logic (no vscode imports) so it stays unit-testable: paging,
// commit labels, diff pair construction, contributor stats, sha detection.

import { CommitSummaryInfo, FileHistoryEntry } from '@gitglasses/protocol';
import { relativeTime } from '../system/dates';

export const PAGE_SIZE = 50;

// --- Cursor paging ----------------------------------------------------------

export interface PageState<T> {
  items: T[];
  nextCursor?: string;
  loaded: boolean;
}

export function emptyPageState<T>(): PageState<T> {
  return { items: [], nextCursor: undefined, loaded: false };
}

/** Accumulates one fetched page; the new cursor replaces the old one. */
export function appendPage<T>(
  state: PageState<T>,
  page: { items: T[]; nextCursor?: string },
): PageState<T> {
  return { items: [...state.items, ...page.items], nextCursor: page.nextCursor, loaded: true };
}

// --- Commit rendering -------------------------------------------------------

export function shortSha(sha: string): string {
  return sha.slice(0, 8);
}

export function commitDescription(
  commit: Pick<CommitSummaryInfo, 'sha' | 'author'>,
  nowUnixSeconds?: number,
): string {
  return `${shortSha(commit.sha)} ${commit.author.name} ${relativeTime(commit.author.time, nowUnixSeconds)}`;
}

/** Plain-text commit summary shown in an untitled document. */
export function formatCommitDoc(commit: CommitSummaryInfo): string {
  const lines = [
    `commit  ${commit.sha}`,
    `parents ${commit.parents.length > 0 ? commit.parents.join(' ') : '(none)'}`,
    `author  ${commit.author.name} <${commit.author.email}>`,
    `date    ${new Date(commit.author.time * 1000).toUTCString()}`,
    '',
    commit.summary,
    '',
  ];
  return lines.join('\n');
}

// --- History entry -> diff pair ---------------------------------------------

export interface RevisionRef {
  repoId: string;
  path: string;
  rev: string;
}

export interface DiffSpec {
  left: RevisionRef;
  right: RevisionRef;
  title: string;
}

// Both sides use the entry's own path (the path at that commit), which keeps
// diffs correct across renames; sha~1 resolving to nothing yields an empty
// left side, which is the desired first-commit rendering.
export function historyEntryDiffSpec(
  repoId: string,
  entry: Pick<FileHistoryEntry, 'sha' | 'path'>,
): DiffSpec {
  return {
    left: { repoId, path: entry.path, rev: `${entry.sha}~1` },
    right: { repoId, path: entry.path, rev: entry.sha },
    title: `${entry.path} (${shortSha(entry.sha)}~1 ↔ ${shortSha(entry.sha)})`,
  };
}

// --- Contributor aggregation ------------------------------------------------

export interface ContributorStat {
  name: string;
  email: string;
  count: number;
  lastTime: number;
}

/** Groups commits by author email (case-insensitive); the display name comes
 *  from that author's most recent commit. Sorted by commit count descending. */
export function aggregateContributors(
  commits: readonly Pick<CommitSummaryInfo, 'author'>[],
): ContributorStat[] {
  const byEmail = new Map<string, ContributorStat>();
  for (const commit of commits) {
    const key = commit.author.email.toLowerCase();
    const existing = byEmail.get(key);
    if (!existing) {
      byEmail.set(key, {
        name: commit.author.name,
        email: key,
        count: 1,
        lastTime: commit.author.time,
      });
    } else {
      existing.count += 1;
      if (commit.author.time > existing.lastTime) {
        existing.lastTime = commit.author.time;
        existing.name = commit.author.name;
      }
    }
  }
  return [...byEmail.values()].sort(
    (a, b) => b.count - a.count || a.name.localeCompare(b.name),
  );
}

// --- Terminal sha detection -------------------------------------------------

const SHA_PATTERN = /\b[0-9a-f]{7,40}\b/g;

export interface ShaMatch {
  sha: string;
  startIndex: number;
  length: number;
}

/** All plausible commit shas (7-40 lowercase hex, word-bounded) in a line. */
export function findShaMatches(line: string): ShaMatch[] {
  const matches: ShaMatch[] = [];
  for (const match of line.matchAll(SHA_PATTERN)) {
    matches.push({ sha: match[0], startIndex: match.index ?? 0, length: match[0].length });
  }
  return matches;
}

export function isFullOrAbbreviatedSha(text: string): boolean {
  return /^[0-9a-f]{7,40}$/.test(text);
}
