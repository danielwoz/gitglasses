import { describe, expect, it } from 'vitest';
import { BlameCommit, BlameHunk, UNCOMMITTED_SHA } from '@gitglasses/protocol';
import { FileBlame } from '../src/model/blameModel';
import {
  computeHeatmapRanges,
  continuationLabel,
  formatFileLensTitle,
  formatGutterLabel,
  formatSymbolLensTitle,
  GUTTER_LABEL_WIDTH,
  HEATMAP_BUCKETS,
  HEATMAP_COLORS,
  summarizeRange,
  truncateName,
} from '../src/annotations/annotationLogic';

const NOW = 1_700_000_000;
const DAY = 86_400;

function commit(name: string, time: number, summary = 'change'): BlameCommit {
  return {
    author: { name, email: `${name}@example.com`, time },
    committer: { name, email: `${name}@example.com`, time },
    summary,
    boundary: false,
  };
}

function hunk(sha: string, resultLine: number, lineCount: number): BlameHunk {
  return { sha, resultLine, originalLine: resultLine, lineCount, path: 'file.ts' };
}

function blame(hunks: BlameHunk[], commits: Record<string, BlameCommit>): FileBlame {
  const totalLines = hunks.reduce((max, h) => Math.max(max, h.resultLine + h.lineCount - 1), 0);
  return { hunks, commits, totalLines };
}

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const SHA_C = 'c'.repeat(40);

describe('formatGutterLabel', () => {
  it('renders short sha, author, and relative date at fixed width', () => {
    const label = formatGutterLabel(
      hunk(SHA_A, 1, 3),
      { [SHA_A]: commit('Ada Lovelace', NOW - 2 * DAY) },
      NOW,
    );
    expect(label.trimEnd()).toBe('aaaaaaaa Ada Lovelace 2 days ago');
    expect(label).toHaveLength(GUTTER_LABEL_WIDTH);
  });

  it('truncates long author names', () => {
    expect(truncateName('Bartholomew Archibald Featherstonehaugh')).toBe('Bartholomew Archi…');
    const label = formatGutterLabel(
      hunk(SHA_B, 1, 1),
      { [SHA_B]: commit('Bartholomew Archibald Featherstonehaugh', NOW - DAY) },
      NOW,
    );
    expect(label).toContain('Bartholomew Archi…');
    expect(label).toHaveLength(GUTTER_LABEL_WIDTH);
  });

  it('labels uncommitted hunks', () => {
    const label = formatGutterLabel(hunk(UNCOMMITTED_SHA, 1, 2), {}, NOW);
    expect(label.trimEnd()).toBe('Uncommitted');
    expect(label).toHaveLength(GUTTER_LABEL_WIDTH);
  });

  it('falls back to the short sha when the commit is missing', () => {
    expect(formatGutterLabel(hunk(SHA_C, 1, 1), {}, NOW).trimEnd()).toBe('cccccccc');
  });

  it('keeps continuation markers aligned with labels', () => {
    const marker = continuationLabel();
    expect(marker.trimEnd()).toBe('│');
    expect(marker).toHaveLength(GUTTER_LABEL_WIDTH);
  });
});

describe('computeHeatmapRanges', () => {
  it('exposes one color per bucket', () => {
    expect(HEATMAP_COLORS).toHaveLength(HEATMAP_BUCKETS);
  });

  it('maps oldest to coldest and newest to hottest', () => {
    const fb = blame(
      [hunk(SHA_A, 1, 2), hunk(SHA_B, 3, 2), hunk(SHA_C, 5, 1)],
      {
        [SHA_A]: commit('old', NOW - 100 * DAY),
        [SHA_B]: commit('mid', NOW - 50 * DAY),
        [SHA_C]: commit('new', NOW),
      },
    );
    const ranges = computeHeatmapRanges(fb);
    expect(ranges[0]).toEqual({ startLine: 1, lineCount: 2, bucket: 0 });
    expect(ranges[1]?.bucket).toBe(5);
    expect(ranges[2]).toEqual({ startLine: 5, lineCount: 1, bucket: HEATMAP_BUCKETS - 1 });
  });

  it('treats a single-commit file as uniformly hottest', () => {
    const fb = blame([hunk(SHA_A, 1, 10)], { [SHA_A]: commit('solo', NOW - 30 * DAY) });
    for (const range of computeHeatmapRanges(fb)) {
      expect(range.bucket).toBe(HEATMAP_BUCKETS - 1);
    }
  });

  it('puts uncommitted lines in the hottest bucket', () => {
    const fb = blame(
      [hunk(SHA_A, 1, 2), hunk(UNCOMMITTED_SHA, 3, 1), hunk(SHA_B, 4, 2)],
      {
        [SHA_A]: commit('old', NOW - 100 * DAY),
        [SHA_B]: commit('new', NOW),
      },
    );
    const ranges = computeHeatmapRanges(fb);
    expect(ranges[1]?.bucket).toBe(HEATMAP_BUCKETS - 1);
    expect(ranges[0]?.bucket).toBe(0);
  });

  it('handles a file with only uncommitted lines', () => {
    const fb = blame([hunk(UNCOMMITTED_SHA, 1, 5)], {});
    expect(computeHeatmapRanges(fb)).toEqual([
      { startLine: 1, lineCount: 5, bucket: HEATMAP_BUCKETS - 1 },
    ]);
  });
});

describe('CodeLens aggregation', () => {
  const fb = blame(
    [
      hunk(SHA_A, 1, 4), // Ada
      hunk(SHA_B, 5, 3), // Grace (most recent)
      hunk(UNCOMMITTED_SHA, 8, 2),
      hunk(SHA_A, 10, 5), // Ada again: still one distinct author
    ],
    {
      [SHA_A]: commit('Ada', NOW - 10 * DAY),
      [SHA_B]: commit('Grace', NOW - DAY),
    },
  );

  it('counts distinct authors and finds the most recent for the whole file', () => {
    const summary = summarizeRange(fb, 1, fb.totalLines);
    expect(summary.authorCount).toBe(2);
    expect(summary.mostRecent).toEqual({ author: 'Grace', time: NOW - DAY });
    expect(summary.hasUncommitted).toBe(true);
    expect(formatFileLensTitle(summary, NOW)).toBe('2 authors (Grace, 1 day ago)');
  });

  it('uses singular author wording', () => {
    const summary = summarizeRange(fb, 1, 4);
    expect(formatFileLensTitle(summary, NOW)).toBe('1 author (Ada, 1 week ago)');
  });

  it('summarizes only hunks overlapping a symbol range', () => {
    const summary = summarizeRange(fb, 10, 14);
    expect(summary.authorCount).toBe(1);
    expect(formatSymbolLensTitle(summary, NOW)).toBe('Ada, 1 week ago');
  });

  it('includes partially overlapping hunks', () => {
    // Lines 4..5 straddle the Ada and Grace hunks.
    const summary = summarizeRange(fb, 4, 5);
    expect(summary.authorCount).toBe(2);
    expect(formatSymbolLensTitle(summary, NOW)).toBe('Grace, 1 day ago');
  });

  it('reports uncommitted-only ranges', () => {
    const summary = summarizeRange(fb, 8, 9);
    expect(summary.authorCount).toBe(0);
    expect(formatFileLensTitle(summary, NOW)).toBe('Uncommitted changes');
    expect(formatSymbolLensTitle(summary, NOW)).toBe('Uncommitted changes');
  });

  it('reports empty ranges as unavailable', () => {
    const summary = summarizeRange(fb, 100, 120);
    expect(formatFileLensTitle(summary, NOW)).toBe('Blame unavailable');
    expect(formatSymbolLensTitle(summary, NOW)).toBe('Blame unavailable');
  });
});
