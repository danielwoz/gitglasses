// Pure text formatting for tool output: compact, line-oriented renderings of
// engine results. No I/O so everything here is unit-testable.

import {
  UNCOMMITTED_SHA,
  type BlameCommit,
  type BlameHunk,
  type CommitSummaryInfo,
  type FileChange,
  type FileHistoryEntry,
  type GraphRow,
  type PatchEnvelope,
  type RequestResult,
} from '@gitglasses/protocol';
import { shortSha } from '@gitglasses/protocol/sha';
import type { LaunchpadGroup } from '@gitglasses/integrations';

/** Trailing marker a truncated result carries. */
const TRUNCATION_FOOTER = /\n\n\(truncated to \d+ characters; [^\n]*\)$/;

/**
 * `text` cut to `limit` characters on a line boundary, with a footer naming
 * the limit and `hint` when anything was dropped.
 */
export function truncateText(text: string, limit: number, hint: string): string {
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit);
  const lastNewline = cut.lastIndexOf('\n');
  return `${lastNewline > 0 ? cut.slice(0, lastNewline) : cut}\n\n(truncated to ${limit} characters; ${hint})`;
}

export function isoDate(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().slice(0, 10);
}

function changeLine(change: FileChange): string {
  const rename = change.origPath ? `${change.origPath} -> ` : '';
  return `${change.status}  ${rename}${change.path} (+${change.additions} -${change.deletions})`;
}

// --- blame -------------------------------------------------------------------

/**
 * One line per blame hunk: line range, sha, author, date, summary. With `line`
 * set, only the hunk covering that line is rendered.
 */
export function formatBlame(
  file: string,
  hunks: readonly BlameHunk[],
  commits: Record<string, BlameCommit>,
  line?: number,
): string {
  const selected =
    line === undefined
      ? hunks
      : hunks.filter((h) => line >= h.resultLine && line < h.resultLine + h.lineCount);
  if (selected.length === 0) {
    return line === undefined
      ? `No blame hunks for ${file}`
      : `No blame hunk covers ${file}:${line}`;
  }
  const lines = selected.map((hunk) => {
    const last = hunk.resultLine + hunk.lineCount - 1;
    const range =
      hunk.lineCount === 1 ? `L${hunk.resultLine}` : `L${hunk.resultLine}-${last}`;
    if (hunk.sha === UNCOMMITTED_SHA) {
      return `${range} uncommitted`;
    }
    const commit = commits[hunk.sha];
    const author = commit ? commit.author.name : 'unknown';
    const date = commit ? isoDate(commit.author.time) : '';
    const summary = commit ? commit.summary : '';
    return `${range} ${shortSha(hunk.sha)} ${author} ${date} ${summary}`.trimEnd();
  });
  return [`blame ${file}${line === undefined ? '' : `:${line}`}`, ...lines].join('\n');
}

// --- commits / history -------------------------------------------------------

export function formatCommits(commits: readonly CommitSummaryInfo[]): string {
  if (commits.length === 0) return 'No matching commits';
  return commits
    .map((c) => `${shortSha(c.sha)} ${c.author.name} ${isoDate(c.author.time)} ${c.summary}`)
    .join('\n');
}

/** History lines; a differing path marks where the file lived before a rename. */
export function formatHistory(file: string, entries: readonly FileHistoryEntry[]): string {
  if (entries.length === 0) return `No history for ${file}`;
  const lines = entries.map((entry) => {
    const rename = entry.path !== file ? ` (as ${entry.path})` : '';
    return `${shortSha(entry.sha)} ${entry.author.name} ${isoDate(entry.author.time)} ${entry.summary} (+${entry.additions} -${entry.deletions})${rename}`;
  });
  return [`history ${file}`, ...lines].join('\n');
}

export function formatCommitShow(
  commit: CommitSummaryInfo,
  files: readonly FileChange[],
): string {
  const lines = [
    `commit ${commit.sha}`,
    `author: ${commit.author.name} <${commit.author.email}> ${isoDate(commit.author.time)}`,
    `parents: ${commit.parents.map(shortSha).join(' ') || '(none)'}`,
    `summary: ${commit.summary}`,
    '',
    `files (${files.length}):`,
    ...files.map((f) => `  ${changeLine(f)}`),
  ];
  return lines.join('\n');
}

// --- graph -------------------------------------------------------------------

function refLabel(ref: GraphRow['refs'][number]): string {
  const upstream = ref.upstream
    ? ` -> ${ref.upstream.name}${
        ref.upstream.ahead || ref.upstream.behind
          ? ` +${ref.upstream.ahead}/-${ref.upstream.behind}`
          : ''
      }`
    : '';
  return `${ref.kind === 'head' ? 'HEAD:' : ''}${ref.name}${upstream}`;
}

/** Lane-indented one-line-per-row rendering of the commit graph. */
export function formatGraph(rows: readonly GraphRow[]): string {
  if (rows.length === 0) return 'No graph rows';
  return rows
    .map((row) => {
      const indent = '  '.repeat(row.lane);
      const marker = row.kind === 'commit' ? '*' : row.kind === 'stash' ? 's' : 'w';
      const refs = row.refs.length > 0 ? ` (${row.refs.map(refLabel).join(', ')})` : '';
      return `${indent}${marker} ${shortSha(row.sha)} ${row.summary}${refs}`;
    })
    .join('\n');
}

// --- status ------------------------------------------------------------------

export function formatStatus(status: RequestResult<'status/summary'>): string {
  const lines: string[] = [];
  const tracking =
    status.upstream === undefined
      ? ''
      : ` -> ${status.upstream} (ahead ${status.ahead}, behind ${status.behind})`;
  lines.push(`branch: ${status.branch}${tracking}`);
  if (
    status.staged.length === 0 &&
    status.unstaged.length === 0 &&
    status.untracked.length === 0 &&
    status.conflicted.length === 0
  ) {
    lines.push('working tree clean');
    return lines.join('\n');
  }
  if (status.staged.length > 0) {
    lines.push(`staged (${status.staged.length}):`);
    lines.push(...status.staged.map((f) => `  ${changeLine(f)}`));
  }
  if (status.unstaged.length > 0) {
    lines.push(`unstaged (${status.unstaged.length}):`);
    lines.push(...status.unstaged.map((f) => `  ${changeLine(f)}`));
  }
  if (status.untracked.length > 0) {
    lines.push(`untracked (${status.untracked.length}):`);
    lines.push(...status.untracked.map((p) => `  ${p}`));
  }
  if (status.conflicted.length > 0) {
    lines.push(`conflicted (${status.conflicted.length}):`);
    lines.push(...status.conflicted.map((p) => `  ${p}`));
  }
  return lines.join('\n');
}

// --- patches -----------------------------------------------------------------

export type PatchSourceParam =
  | { kind: 'wip'; includeUntracked?: boolean }
  | { kind: 'stash'; index: number }
  | { kind: 'commit'; sha: string };

/** Parse the tool-facing source string: 'wip' | 'stash:<n>' | 'commit:<sha>'. */
export function parsePatchSource(source: string): PatchSourceParam {
  if (source === 'wip') {
    return { kind: 'wip', includeUntracked: true };
  }
  const stash = /^stash:(\d+)$/.exec(source);
  if (stash) {
    return { kind: 'stash', index: Number(stash[1]) };
  }
  const commit = /^commit:([0-9a-fA-F]{4,40})$/.exec(source);
  if (commit) {
    return { kind: 'commit', sha: commit[1] };
  }
  throw new Error(`Invalid patch source "${source}"; expected 'wip', 'stash:<n>' or 'commit:<sha>'`);
}

/** Line separating envelope metadata from the raw patch text. */
export const PATCH_BODY_DELIMITER = '--- patch ---';

/** Envelope fields rendered as metadata, in order. `patch` follows the delimiter. */
const ENVELOPE_METADATA_FIELDS = [
  'format',
  'version',
  'baseSha',
  'branch',
  'summary',
  'remoteFingerprint',
  'createdAtIso',
] as const;

/**
 * An envelope as metadata lines followed by the raw patch. Metadata values are
 * JSON so each occupies exactly one line; the patch keeps its real newlines.
 */
export function formatPatchEnvelope(envelope: PatchEnvelope): string {
  const lines = ENVELOPE_METADATA_FIELDS.filter(
    (field) => envelope[field] !== undefined,
  ).map((field) => `${field}: ${JSON.stringify(envelope[field])}`);
  return [...lines, PATCH_BODY_DELIMITER, envelope.patch].join('\n');
}

/** Read back the rendering `formatPatchEnvelope` produces. */
export function parsePatchEnvelopeText(text: string): PatchEnvelope {
  if (TRUNCATION_FOOTER.test(text)) {
    throw new Error('the patch is truncated; re-run create_patch with a higher "maxChars"');
  }
  const marker = `\n${PATCH_BODY_DELIMITER}\n`;
  const split = text.indexOf(marker);
  if (split < 0) {
    throw new Error(`no "${PATCH_BODY_DELIMITER}" line`);
  }
  const envelope: Record<string, unknown> = {};
  for (const line of text.slice(0, split).split('\n')) {
    const field = /^([A-Za-z]+): (.*)$/.exec(line);
    if (!field) {
      throw new Error(`not a "field: value" line: ${JSON.stringify(line)}`);
    }
    try {
      envelope[field[1]] = JSON.parse(field[2]);
    } catch {
      throw new Error(`field "${field[1]}" is not a JSON value`);
    }
  }
  envelope.patch = text.slice(split + marker.length);
  return envelope as PatchEnvelope;
}

// --- launchpad ---------------------------------------------------------------

export function formatLaunchpad(groups: readonly LaunchpadGroup[]): string {
  if (groups.length === 0) return 'No open pull requests involve you';
  const lines: string[] = [];
  for (const group of groups) {
    lines.push(`${group.bucket} (${group.items.length}):`);
    for (const pr of group.items) {
      lines.push(
        `  #${pr.number} ${pr.title} [${pr.repo.owner}/${pr.repo.name}] by ${pr.author.username} ${pr.url}`,
      );
    }
  }
  return lines.join('\n');
}
