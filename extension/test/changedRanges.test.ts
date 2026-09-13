import { describe, expect, it } from 'vitest';
import { BlameCommit, BlameHunk, UNCOMMITTED_SHA } from '@gitglasses/protocol';
import { FileBlame } from '../src/model/blameModel';
import { computeChangedRanges } from '../src/annotations/annotationLogic';

function commit(name: string, time: number): BlameCommit {
  return {
    author: { name, email: `${name}@example.com`, time },
    committer: { name, email: `${name}@example.com`, time },
    summary: 'change',
    boundary: false,
  };
}

function hunk(sha: string, resultLine: number, lineCount: number): BlameHunk {
  return { sha, resultLine, originalLine: resultLine, lineCount, path: 'a.ts' };
}

function blameOf(hunks: BlameHunk[]): FileBlame {
  return {
    hunks,
    commits: { abc: commit('ada', 1_700_000_000) },
    totalLines: hunks.reduce((n, h) => n + h.lineCount, 0),
  };
}

describe('computeChangedRanges', () => {
  it('returns nothing when every hunk is committed', () => {
    expect(computeChangedRanges(blameOf([hunk('abc', 1, 5)]))).toEqual([]);
  });

  it('picks out only the uncommitted hunks', () => {
    const blame = blameOf([
      hunk('abc', 1, 3),
      hunk(UNCOMMITTED_SHA, 4, 2),
      hunk('abc', 6, 4),
    ]);
    expect(computeChangedRanges(blame)).toEqual([{ startLine: 4, lineCount: 2 }]);
  });

  it('merges adjacent uncommitted hunks into one run', () => {
    const blame = blameOf([
      hunk(UNCOMMITTED_SHA, 1, 2),
      hunk(UNCOMMITTED_SHA, 3, 3),
    ]);
    expect(computeChangedRanges(blame)).toEqual([{ startLine: 1, lineCount: 5 }]);
  });

  it('keeps separated runs apart', () => {
    const blame = blameOf([
      hunk(UNCOMMITTED_SHA, 1, 2),
      hunk('abc', 3, 4),
      hunk(UNCOMMITTED_SHA, 7, 1),
    ]);
    expect(computeChangedRanges(blame)).toEqual([
      { startLine: 1, lineCount: 2 },
      { startLine: 7, lineCount: 1 },
    ]);
  });

  it('merges overlapping hunks to their union rather than double counting', () => {
    const blame = blameOf([
      hunk(UNCOMMITTED_SHA, 1, 5),
      hunk(UNCOMMITTED_SHA, 3, 2),
    ]);
    expect(computeChangedRanges(blame)).toEqual([{ startLine: 1, lineCount: 5 }]);
  });

  it('sorts out-of-order hunks before merging', () => {
    const blame = blameOf([
      hunk(UNCOMMITTED_SHA, 5, 2),
      hunk(UNCOMMITTED_SHA, 1, 4),
    ]);
    expect(computeChangedRanges(blame)).toEqual([{ startLine: 1, lineCount: 6 }]);
  });

  it('ignores zero-length hunks', () => {
    expect(computeChangedRanges(blameOf([hunk(UNCOMMITTED_SHA, 3, 0)]))).toEqual([]);
  });

  it('handles an entirely uncommitted file', () => {
    expect(computeChangedRanges(blameOf([hunk(UNCOMMITTED_SHA, 1, 9)]))).toEqual([
      { startLine: 1, lineCount: 9 },
    ]);
  });
});
