// Pure hunk selection for staging (no vscode imports).
//
// The engine's stage/hunks takes the hunk headers to apply; this module picks
// which of a file's hunks a cursor or selection covers. Line numbers here are
// 1-based, matching both the unified-diff header and the engine's shape.

/** The subset of DiffHunk that identifies a hunk to the engine. */
export interface HunkRange {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
}

/**
 * A hunk's footprint in the file being edited. Pure deletions have newLines 0
 * and would otherwise cover nothing, so they are treated as occupying the
 * single line they sit against — a cursor there can still stage them.
 */
function footprint(hunk: HunkRange): { first: number; last: number } {
  if (hunk.newLines <= 0) return { first: hunk.newStart, last: hunk.newStart };
  return { first: hunk.newStart, last: hunk.newStart + hunk.newLines - 1 };
}

/**
 * Hunks overlapping the 1-based inclusive selection, in file order. A caret
 * (startLine === endLine) selects the hunk containing that line.
 */
export function hunksIntersectingSelection<T extends HunkRange>(
  hunks: readonly T[],
  startLine: number,
  endLine: number,
): T[] {
  const first = Math.min(startLine, endLine);
  const last = Math.max(startLine, endLine);
  return hunks
    .filter((hunk) => {
      const { first: hunkFirst, last: hunkLast } = footprint(hunk);
      return hunkFirst <= last && hunkLast >= first;
    })
    .sort((a, b) => a.newStart - b.newStart);
}

/** Strips a hunk down to the fields stage/hunks accepts. */
export function toHunkRange(hunk: HunkRange): HunkRange {
  return {
    oldStart: hunk.oldStart,
    oldLines: hunk.oldLines,
    newStart: hunk.newStart,
    newLines: hunk.newLines,
  };
}

/** Human summary for the confirmation/notification message. */
export function describeHunkCount(count: number, action: 'stage' | 'unstage'): string {
  const verb = action === 'stage' ? 'Staged' : 'Unstaged';
  return `${verb} ${count} hunk${count === 1 ? '' : 's'}.`;
}
