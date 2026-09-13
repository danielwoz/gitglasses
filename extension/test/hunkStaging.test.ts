import { describe, expect, it } from 'vitest';
import {
  describeHunk,
  describeHunkCount,
  hunksIntersectingSelection,
  selectionLineRange,
  toHunkRange,
  type HunkRange,
} from '../src/scm/hunkStaging';

function hunk(newStart: number, newLines: number, oldStart = newStart): HunkRange {
  return { oldStart, oldLines: newLines, newStart, newLines };
}

describe('hunksIntersectingSelection', () => {
  const hunks = [hunk(1, 3), hunk(10, 2), hunk(20, 5)];

  it('selects the hunk containing a caret', () => {
    expect(hunksIntersectingSelection(hunks, 11, 11)).toEqual([hunk(10, 2)]);
  });

  it('returns nothing when the caret is between hunks', () => {
    expect(hunksIntersectingSelection(hunks, 7, 7)).toEqual([]);
  });

  it('selects every hunk a range spans', () => {
    expect(hunksIntersectingSelection(hunks, 2, 21)).toHaveLength(3);
  });

  it('includes a hunk touched only at its first line', () => {
    expect(hunksIntersectingSelection(hunks, 10, 10)).toEqual([hunk(10, 2)]);
  });

  it('includes a hunk touched only at its last line', () => {
    expect(hunksIntersectingSelection(hunks, 11, 11)).toEqual([hunk(10, 2)]);
    expect(hunksIntersectingSelection(hunks, 12, 12)).toEqual([]);
  });

  it('treats a pure deletion as occupying its anchor line', () => {
    const deletion = [{ oldStart: 5, oldLines: 3, newStart: 4, newLines: 0 }];
    expect(hunksIntersectingSelection(deletion, 4, 4)).toHaveLength(1);
    expect(hunksIntersectingSelection(deletion, 5, 5)).toHaveLength(0);
  });

  // Git emits "@@ -1,8 +0,0 @@" when the new side is empty. newStart 0 is
  // unreachable from a 1-based cursor unless the footprint is clamped.
  it('lets a whole-file deletion be selected from line 1', () => {
    const wholeFile = [{ oldStart: 1, oldLines: 8, newStart: 0, newLines: 0 }];
    expect(hunksIntersectingSelection(wholeFile, 1, 1)).toHaveLength(1);
    expect(hunksIntersectingSelection(wholeFile, 1, 5)).toHaveLength(1);
    expect(hunksIntersectingSelection(wholeFile, 2, 2)).toHaveLength(0);
  });

  it('normalises an inverted selection', () => {
    expect(hunksIntersectingSelection(hunks, 21, 2)).toHaveLength(3);
  });

  it('returns hunks in file order regardless of input order', () => {
    const shuffled = [hunk(20, 5), hunk(1, 3), hunk(10, 2)];
    expect(hunksIntersectingSelection(shuffled, 1, 30).map((h) => h.newStart)).toEqual([
      1, 10, 20,
    ]);
  });

  it('handles an empty hunk list', () => {
    expect(hunksIntersectingSelection([], 1, 5)).toEqual([]);
  });
});

describe('toHunkRange', () => {
  it('keeps only the fields the engine accepts', () => {
    const withExtra = { ...hunk(3, 2), header: '@@ -3,2 +3,2 @@', lines: [' a'] };
    expect(toHunkRange(withExtra)).toEqual({
      oldStart: 3,
      oldLines: 2,
      newStart: 3,
      newLines: 2,
    });
  });
});

describe('describeHunkCount', () => {
  it('agrees in number and uses the right verb', () => {
    expect(describeHunkCount(1, 'stage')).toBe('Staged 1 hunk.');
    expect(describeHunkCount(3, 'stage')).toBe('Staged 3 hunks.');
    expect(describeHunkCount(1, 'unstage')).toBe('Unstaged 1 hunk.');
  });
});

describe('selectionLineRange', () => {
  it('converts a caret to a single 1-based line', () => {
    expect(selectionLineRange(4, 4, 7)).toEqual({ startLine: 5, endLine: 5 });
  });

  // Ctrl+L / triple-click ends at the next line, column 0, with nothing on it
  // selected; counting it would pull in an adjacent hunk.
  it('excludes the trailing line of a whole-line selection', () => {
    expect(selectionLineRange(1, 2, 0)).toEqual({ startLine: 2, endLine: 2 });
    expect(selectionLineRange(1, 3, 0)).toEqual({ startLine: 2, endLine: 3 });
  });

  it('keeps the last line when the selection ends mid-line', () => {
    expect(selectionLineRange(1, 2, 5)).toEqual({ startLine: 2, endLine: 3 });
  });

  it('does not collapse a caret sitting at column 0', () => {
    expect(selectionLineRange(3, 3, 0)).toEqual({ startLine: 4, endLine: 4 });
  });

  it('normalises an inverted selection', () => {
    expect(selectionLineRange(5, 2, 3)).toEqual({ startLine: 3, endLine: 6 });
  });
});

describe('describeHunk', () => {
  it('summarises counts and previews the first changed line', () => {
    const described = describeHunk({
      oldStart: 3,
      oldLines: 2,
      newStart: 3,
      newLines: 3,
      header: '@@ -3,2 +3,3 @@',
      lines: [' context', '-gone', '+added one', '+added two'],
    });
    expect(described.label).toBe('@@ -3,2 +3,3 @@  +2 \u22121');
    expect(described.detail).toBe('-gone');
  });

  it('falls back to the header when a hunk has no +/- lines', () => {
    const described = describeHunk({
      oldStart: 1, oldLines: 1, newStart: 1, newLines: 1,
      header: '@@ -1 +1 @@', lines: [' only context'],
    });
    expect(described.detail).toBe('@@ -1 +1 @@');
  });
});
