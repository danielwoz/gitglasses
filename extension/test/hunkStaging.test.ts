import { describe, expect, it } from 'vitest';
import { EngineError } from '@gitglasses/rpc';
import {
  describeHunk,
  describeHunkCount,
  hunkMatchesDocument,
  hunksIntersectingSelection,
  isWholeFileOnly,
  selectionLineRange,
  toHunkRange,
  type DiffHunkLike,
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

  // Git emits "@@ -1,8 +0,0 @@" when the new side is empty; a 1-based cursor
  // reaches newStart 0 only through the footprint clamp.
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
  // selected.
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

describe('hunkMatchesDocument', () => {
  const document = (lines: string[]) => (line: number) => lines[line - 1];
  const portEdit: DiffHunkLike = {
    header: '@@ -1,2 +1,2 @@',
    oldStart: 1,
    oldLines: 2,
    newStart: 1,
    newLines: 2,
    lines: [' token=abc', '-port=1', '+port=2'],
  };

  it('accepts a hunk whose new side is the editor text at its position', () => {
    expect(hunkMatchesDocument(portEdit, document(['token=abc', 'port=2']))).toBe(true);
  });

  // A clean filter that drops lines (notebook outputs, say) leaves hunk
  // positions in the stored form, not the editor's.
  it('rejects a hunk whose position addresses other editor lines', () => {
    const reshaped = document(['token=abc', '"outputs": [1, 2]', 'port=2']);
    expect(hunkMatchesDocument(portEdit, reshaped)).toBe(false);
  });

  // The stored form of a scrubbed line differs from what the editor holds.
  it('rejects a hunk whose context the editor shows differently', () => {
    const scrubbed = { ...portEdit, lines: [' token=REDACTED', '-port=1', '+port=2'] };
    expect(hunkMatchesDocument(scrubbed, document(['token=abc', 'port=2']))).toBe(false);
  });

  it('rejects a hunk running past the end of the editor text', () => {
    expect(hunkMatchesDocument(portEdit, document(['token=abc']))).toBe(false);
  });

  it('ignores a byte-order mark on the first line', () => {
    const withBom = { ...portEdit, lines: [' \uFEFFtoken=abc', '-port=1', '+port=2'] };
    expect(hunkMatchesDocument(withBom, document(['token=abc', 'port=2']))).toBe(true);
  });

  it('accepts a pure deletion anywhere', () => {
    const deletion = { ...portEdit, newLines: 0, lines: ['-port=1'] };
    expect(hunkMatchesDocument(deletion, document([]))).toBe(true);
  });
});

describe('isWholeFileOnly', () => {
  it('recognises the engine refusing to split a file into hunks', () => {
    expect(isWholeFileOnly(new EngineError(-32011, "'sub' is a submodule"))).toBe(true);
    expect(isWholeFileOnly(new EngineError(-32001, 'stale hunk ranges'))).toBe(false);
    expect(isWholeFileOnly(new Error('plain'))).toBe(false);
    expect(isWholeFileOnly(undefined)).toBe(false);
  });
});
