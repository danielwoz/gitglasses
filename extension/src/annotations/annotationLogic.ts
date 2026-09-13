// Pure blame-annotation logic shared by the gutter/heatmap controllers and
// the CodeLens provider. No vscode imports so it stays unit-testable.
import { BlameCommit, BlameHunk, UNCOMMITTED_SHA } from '@gitglasses/protocol';
import { FileBlame } from '../model/blameModel';
import { relativeTime } from '../system/dates';

// --- Gutter blame labels ----------------------------------------------------

export const SHORT_SHA_LENGTH = 8;
export const AUTHOR_MAX_LENGTH = 18;
export const GUTTER_LABEL_WIDTH = 44;
export const GUTTER_CONTINUATION = '│';

export function truncateName(name: string, max: number = AUTHOR_MAX_LENGTH): string {
  return name.length > max ? `${name.slice(0, max - 1)}…` : name;
}

/** Pads/clips to GUTTER_LABEL_WIDTH so every gutter entry has equal width. */
export function padGutterLabel(text: string): string {
  const clipped =
    text.length > GUTTER_LABEL_WIDTH ? `${text.slice(0, GUTTER_LABEL_WIDTH - 1)}…` : text;
  return clipped.padEnd(GUTTER_LABEL_WIDTH, ' ');
}

/** `<short-sha> <author> <relative-date>` for a hunk's first line. */
export function formatGutterLabel(
  hunk: BlameHunk,
  commits: Record<string, BlameCommit>,
  nowUnixSeconds?: number,
): string {
  if (hunk.sha === UNCOMMITTED_SHA) return padGutterLabel('Uncommitted');
  const commit = commits[hunk.sha];
  if (!commit) return padGutterLabel(hunk.sha.slice(0, SHORT_SHA_LENGTH));
  return padGutterLabel(
    `${hunk.sha.slice(0, SHORT_SHA_LENGTH)} ${truncateName(commit.author.name)} ` +
      relativeTime(commit.author.time, nowUnixSeconds),
  );
}

/** Aligned spacer marking continuation lines of a multi-line hunk. */
export function continuationLabel(): string {
  return GUTTER_CONTINUATION.padEnd(GUTTER_LABEL_WIDTH, ' ');
}

// --- Heatmap bucketing ------------------------------------------------------

export const HEATMAP_BUCKETS = 10;

/** Cold (old) -> hot (recent) 10-step ramp; index aligns with bucket index. */
export const HEATMAP_COLORS: readonly string[] = [
  'rgba(49, 54, 149, 0.55)',
  'rgba(69, 117, 180, 0.55)',
  'rgba(116, 173, 209, 0.55)',
  'rgba(171, 217, 233, 0.55)',
  'rgba(224, 243, 248, 0.55)',
  'rgba(254, 224, 144, 0.55)',
  'rgba(253, 174, 97, 0.55)',
  'rgba(244, 109, 67, 0.55)',
  'rgba(215, 48, 39, 0.55)',
  'rgba(165, 0, 38, 0.55)',
];

export interface HeatmapRange {
  /** 1-based first line of the hunk. */
  startLine: number;
  lineCount: number;
  /** 0..HEATMAP_BUCKETS-1; higher = more recent. */
  bucket: number;
}

/**
 * Buckets each hunk by commit author time normalized across the file's
 * oldest..newest commits. Uncommitted hunks are the newest possible, so they
 * land in the hottest bucket; a single-commit file is uniformly hottest.
 */
export function computeHeatmapRanges(blame: FileBlame): HeatmapRange[] {
  const times: number[] = [];
  for (const hunk of blame.hunks) {
    if (hunk.sha === UNCOMMITTED_SHA) continue;
    const time = blame.commits[hunk.sha]?.author.time;
    if (time !== undefined) times.push(time);
  }
  // Reduce rather than spread: Math.min(...times) throws RangeError once the
  // argument count passes the engine's stack limit (~125k), and a file can
  // have that many blame hunks.
  let oldest = Number.POSITIVE_INFINITY;
  let newest = Number.NEGATIVE_INFINITY;
  for (const time of times) {
    if (time < oldest) oldest = time;
    if (time > newest) newest = time;
  }
  const span = newest - oldest;

  return blame.hunks.map((hunk) => ({
    startLine: hunk.resultLine,
    lineCount: hunk.lineCount,
    bucket: bucketForHunk(hunk, blame.commits, oldest, span),
  }));
}

function bucketForHunk(
  hunk: BlameHunk,
  commits: Record<string, BlameCommit>,
  oldest: number,
  span: number,
): number {
  if (hunk.sha === UNCOMMITTED_SHA) return HEATMAP_BUCKETS - 1;
  const time = commits[hunk.sha]?.author.time;
  if (time === undefined) return 0;
  if (span <= 0) return HEATMAP_BUCKETS - 1;
  return Math.min(HEATMAP_BUCKETS - 1, Math.floor(((time - oldest) / span) * HEATMAP_BUCKETS));
}

// --- Changes annotation -----------------------------------------------------

export interface ChangedRange {
  /** 1-based first line of the run. */
  startLine: number;
  lineCount: number;
}

/**
 * Runs of lines not yet committed, derived from the blame the file already
 * carries rather than a separate diff request. Adjacent uncommitted hunks are
 * merged so the editor gets one decoration per visual run.
 */
export function computeChangedRanges(blame: FileBlame): ChangedRange[] {
  const uncommitted = blame.hunks
    .filter((hunk) => hunk.sha === UNCOMMITTED_SHA && hunk.lineCount > 0)
    .sort((a, b) => a.resultLine - b.resultLine);

  const ranges: ChangedRange[] = [];
  for (const hunk of uncommitted) {
    const previous = ranges[ranges.length - 1];
    if (previous && hunk.resultLine <= previous.startLine + previous.lineCount) {
      // Overlapping or touching: extend to cover the union.
      const end = Math.max(
        previous.startLine + previous.lineCount,
        hunk.resultLine + hunk.lineCount,
      );
      previous.lineCount = end - previous.startLine;
      continue;
    }
    ranges.push({ startLine: hunk.resultLine, lineCount: hunk.lineCount });
  }
  return ranges;
}

// --- CodeLens aggregation ---------------------------------------------------

export interface RangeSummary {
  /** Distinct committed authors within the range. */
  authorCount: number;
  mostRecent?: { author: string; time: number };
  hasUncommitted: boolean;
}

/** Aggregates committed authors over an inclusive 1-based line range. */
export function summarizeRange(
  blame: FileBlame,
  startLine: number,
  endLine: number,
): RangeSummary {
  const authors = new Set<string>();
  let mostRecent: { author: string; time: number } | undefined;
  let hasUncommitted = false;

  for (const hunk of blame.hunks) {
    const hunkEnd = hunk.resultLine + hunk.lineCount - 1;
    if (hunkEnd < startLine || hunk.resultLine > endLine) continue;
    if (hunk.sha === UNCOMMITTED_SHA) {
      hasUncommitted = true;
      continue;
    }
    const commit = blame.commits[hunk.sha];
    if (!commit) continue;
    authors.add(commit.author.name);
    if (!mostRecent || commit.author.time > mostRecent.time) {
      mostRecent = { author: commit.author.name, time: commit.author.time };
    }
  }
  return { authorCount: authors.size, mostRecent, hasUncommitted };
}

export function formatFileLensTitle(summary: RangeSummary, nowUnixSeconds?: number): string {
  if (!summary.mostRecent) {
    return summary.hasUncommitted ? 'Uncommitted changes' : 'Blame unavailable';
  }
  const plural = summary.authorCount === 1 ? 'author' : 'authors';
  const when = relativeTime(summary.mostRecent.time, nowUnixSeconds);
  return `${summary.authorCount} ${plural} (${summary.mostRecent.author}, ${when})`;
}

export function formatSymbolLensTitle(summary: RangeSummary, nowUnixSeconds?: number): string {
  if (!summary.mostRecent) {
    return summary.hasUncommitted ? 'Uncommitted changes' : 'Blame unavailable';
  }
  return `${summary.mostRecent.author}, ${relativeTime(summary.mostRecent.time, nowUnixSeconds)}`;
}
