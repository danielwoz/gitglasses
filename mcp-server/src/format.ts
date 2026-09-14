// Pure text formatting for tool output: compact, line-oriented renderings of
// engine results. No I/O so everything here is unit-testable.

import {
  UNCOMMITTED_SHA,
  type BlameCommit,
  type BlameHunk,
  type CommitSummaryInfo,
  type DiffHunk,
  type FileChange,
  type FileHistoryEntry,
  type GraphRow,
  type HeadState,
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

interface ChangeLineOptions {
  /** Render "(binary)" in place of counts git reports as +0 -0 for binaries. */
  binary?: boolean;
  /** Drop "(+0 -0)" where the source does not compute counts at all. */
  omitZeroCounts?: boolean;
}

/**
 * One changed file: status, path (with the pre-rename path when there is one)
 * and line counts.
 */
function changeLine(change: FileChange, options: ChangeLineOptions = {}): string {
  const rename = change.origPath ? `${change.origPath} -> ` : '';
  const path = `${change.status}  ${rename}${change.path}`;
  if (options.binary) return `${path} (binary)`;
  if (options.omitZeroCounts && change.additions === 0 && change.deletions === 0) return path;
  return `${path} (+${change.additions} -${change.deletions})`;
}

/** True when `contents` holds a NUL byte, the marker git treats as binary. */
export function looksBinary(contents: string): boolean {
  return contents.includes('\0');
}

/** Paths a unified diff reports as binary rather than as text hunks. */
export function binaryPathsInPatch(patch: string): Set<string> {
  const paths = new Set<string>();
  for (const match of patch.matchAll(/^Binary files (?:a\/(.+?)|\/dev\/null) and (?:b\/(.+?)|\/dev\/null) differ$/gm)) {
    const path = match[2] ?? match[1];
    if (path) paths.add(path);
  }
  return paths;
}

// --- blame -------------------------------------------------------------------

/**
 * One line per blame hunk: line range, sha, author, date, summary. With `line`
 * set, only the hunk covering that line is rendered. A binary file is labelled
 * on the header line: git attributes the whole file to one "line", which reads
 * as ordinary line authorship otherwise.
 */
export function formatBlame(
  file: string,
  hunks: readonly BlameHunk[],
  commits: Record<string, BlameCommit>,
  line?: number,
  binary = false,
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
  const marker = binary ? ' (binary; the whole file is one hunk, not line authorship)' : '';
  return [`blame ${file}${line === undefined ? '' : `:${line}`}${marker}`, ...lines].join('\n');
}

// --- commits / history -------------------------------------------------------

export function formatCommits(
  commits: readonly CommitSummaryInfo[],
  emptyMessage = 'No matching commits',
): string {
  if (commits.length === 0) return emptyMessage;
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

export interface CommitShowOptions {
  /** Paths whose change is binary, so +/- counts would read as "unchanged". */
  binaryPaths?: ReadonlySet<string>;
  /** Unified diff text appended below the file list. */
  diff?: string;
}

export function formatCommitShow(
  commit: CommitSummaryInfo,
  files: readonly FileChange[],
  options: CommitShowOptions = {},
): string {
  const binaryPaths = options.binaryPaths ?? new Set<string>();
  const lines = [
    `commit ${commit.sha}`,
    `author: ${commit.author.name} <${commit.author.email}> ${isoDate(commit.author.time)}`,
    `parents: ${commit.parents.map(shortSha).join(' ') || '(none)'}`,
    `summary: ${commit.summary}`,
    '',
    `files (${files.length}):`,
    ...files.map((f) => `  ${changeLine(f, { binary: binaryPaths.has(f.path) })}`),
  ];
  if (options.diff !== undefined) {
    lines.push('', 'diff:', options.diff.replace(/\n$/, ''));
  }
  return lines.join('\n');
}

// --- working-tree diff -------------------------------------------------------

export interface DiffFileEntry {
  path: string;
  /** FileChange status, or "?" for an untracked file. */
  status: string;
  origPath?: string;
  hunks: readonly DiffHunk[];
  /** Set when the file holds binary content, which produces no text hunks. */
  binary?: boolean;
}

/** Added and removed line counts of a hunk list. */
function hunkCounts(hunks: readonly DiffHunk[]): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.startsWith('+')) additions += 1;
      else if (line.startsWith('-')) deletions += 1;
    }
  }
  return { additions, deletions };
}

/**
 * Uncommitted changes: a file header line per file followed by its unified
 * hunks. Header lines start with a status letter and body lines with ' ', '+'
 * or '-', so the two never collide.
 *
 * A file with no hunks is binary or a mode-only change; it is labelled rather
 * than rendered as an empty diff.
 */
export function formatDiff(
  scope: 'staged' | 'unstaged',
  entries: readonly DiffFileEntry[],
  file?: string,
  totalChanged = entries.length,
): string {
  if (entries.length === 0) {
    return file === undefined
      ? `No ${scope} changes`
      : `No ${scope} changes in ${file}`;
  }
  // The count of files left out belongs on the first line: a footer is the
  // first thing a character limit drops.
  const header =
    entries.length < totalChanged
      ? `diff ${scope} (showing ${entries.length} of ${totalChanged} changed files; pass "file" to diff one of them):`
      : `diff ${scope} (${entries.length} file${entries.length === 1 ? '' : 's'}):`;
  const lines = [header];
  for (const entry of entries) {
    const rename = entry.origPath ? `${entry.origPath} -> ` : '';
    const counts = entry.binary
      ? 'binary'
      : entry.hunks.length === 0
        ? 'no text diff; binary or mode change'
        : (({ additions, deletions }) => `+${additions} -${deletions}`)(hunkCounts(entry.hunks));
    lines.push(`${entry.status}  ${rename}${entry.path} (${counts})`);
    for (const hunk of entry.hunks) {
      lines.push(hunk.header, ...hunk.lines);
    }
  }
  return lines.join('\n');
}

// --- refs --------------------------------------------------------------------

/** Branches, remote-tracking branches and tags, one ref per line. */
export function formatRefs(refs: RequestResult<'refs/list'>): string {
  const lines: string[] = [];
  if (refs.branches.length > 0) {
    lines.push(`branches (${refs.branches.length}):`);
    for (const branch of refs.branches) {
      const current = branch.current ? ' (current)' : '';
      const upstream = branch.upstream ? ` -> ${branch.upstream}` : '';
      lines.push(`  ${branch.name} ${shortSha(branch.sha)}${current}${upstream}`);
    }
  }
  for (const remote of refs.remotes) {
    if (remote.branches.length === 0) continue;
    lines.push(`remote ${remote.name} (${remote.branches.length}):`);
    for (const branch of remote.branches) {
      lines.push(`  ${remote.name}/${branch.name} ${shortSha(branch.sha)}`);
    }
  }
  if (refs.tags.length > 0) {
    lines.push(`tags (${refs.tags.length}):`);
    for (const tag of refs.tags) lines.push(`  ${tag.name} ${shortSha(tag.sha)}`);
  }
  return lines.length === 0 ? 'No branches, remote branches or tags' : lines.join('\n');
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

/**
 * The branch field of `status/summary` is empty both on an unborn HEAD and on
 * a detached one, which renders identically to a healthy repository. `head`
 * names which of the two it is.
 */
export function formatBranchLine(
  status: RequestResult<'status/summary'>,
  head?: HeadState,
): string {
  if (head?.unborn) return 'branch: (no commits yet)';
  if (head?.detached) return `branch: (detached at ${shortSha(head.oid)})`;
  const tracking =
    status.upstream === undefined
      ? ''
      : ` -> ${status.upstream} (ahead ${status.ahead}, behind ${status.behind})`;
  return `branch: ${status.branch || head?.branch || '(unknown)'}${tracking}`;
}

export function formatStatus(
  status: RequestResult<'status/summary'>,
  head?: HeadState,
): string {
  const lines: string[] = [];
  lines.push(formatBranchLine(status, head));
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
    lines.push(...status.staged.map((f) => `  ${changeLine(f, { omitZeroCounts: true })}`));
  }
  if (status.unstaged.length > 0) {
    lines.push(`unstaged (${status.unstaged.length}):`);
    lines.push(...status.unstaged.map((f) => `  ${changeLine(f, { omitZeroCounts: true })}`));
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

// --- errors ------------------------------------------------------------------

/** Trailing lines of git CLI usage text, which name no recoverable action. */
const GIT_USAGE_NOISE = /^(Use '|'git <|usage: |\s*or: )/;

/** The engine's shell-out framing: command name, exit code, "fatal:" prefix. */
const GIT_PLUMBING_PREFIX = /^git [\w. -]+ failed \(\d+\): (fatal: |error: )?/;

export interface EngineErrorContext {
  /** repoPath as the caller spelled it, substituted for resolved paths. */
  repoPath?: string;
  /** Paths the caller never supplied and should not be told about. */
  resolvedPaths?: readonly string[];
}

/** Engine message with usage noise, plumbing framing and unsupplied paths removed. */
function cleanEngineMessage(message: string, context: EngineErrorContext): string {
  let text = message
    .split('\n')
    .filter((line) => line.trim() !== '' && !GIT_USAGE_NOISE.test(line))
    .join('\n')
    .replace(GIT_PLUMBING_PREFIX, '');
  if (context.repoPath) {
    for (const resolved of context.resolvedPaths ?? []) {
      if (resolved && resolved !== context.repoPath) {
        text = text.split(resolved.replace(/\/+$/, '')).join(context.repoPath);
      }
    }
  }
  return text;
}

/** Message patterns an agent can act on, and the action each one implies. */
const ENGINE_ERROR_CASES: { match: RegExp; explain: (m: RegExpExecArray, repoPath: string) => string }[] = [
  {
    match: /could not find repository at|failed to resolve path/,
    explain: (_m, repoPath) =>
      `no git repository at or above ${repoPath}; pass repoPath as a path inside a git working tree`,
  },
  {
    match: /no such path '(.+?)' in (\S+)/,
    explain: (m) =>
      `${m[1]} is not tracked at ${m[2]}; call git_status for the working tree or git_commit_show for a commit's files`,
  },
  {
    match: /the path '(.+?)' does not exist in the given tree/,
    explain: (m) => `${m[1]} does not exist at that revision; call git_commit_show to list its files`,
  },
  {
    match: /no such ref: HEAD|ambiguous argument 'HEAD'|revspec 'HEAD' not found|unborn/,
    explain: (_m, repoPath) => emptyRepositoryMessage(repoPath),
  },
  {
    match: /revspec '(.+?)' not found/,
    explain: (m) =>
      `no such revision "${m[1]}"; call git_refs for branches and tags or git_log_search for shas`,
  },
];

/** What a caller is told when the repository has no commits. */
export function emptyRepositoryMessage(repoPath: string): string {
  return `${repoPath} is a git repository with no commits yet; blame, diff, log and patch need at least one commit`;
}

/**
 * An engine failure restated as something the agent can act on. Unrecognised
 * messages fall through cleaned but otherwise intact, so real detail survives.
 */
export function explainEngineError(message: string, context: EngineErrorContext = {}): string {
  const cleaned = cleanEngineMessage(message, context);
  const repoPath = context.repoPath ?? 'the repository';
  for (const { match, explain } of ENGINE_ERROR_CASES) {
    const found = match.exec(cleaned);
    if (found) return explain(found, repoPath);
  }
  return cleaned;
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
