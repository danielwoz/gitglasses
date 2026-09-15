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
 * A hunk's footprint in the file being edited. A pure deletion has newLines 0
 * and occupies the single line it sits against, so a cursor there selects it.
 *
 * Git reports newStart 0 when the new side is empty (`@@ -1,8 +0,0 @@`, a hunk
 * deleting a file's entire contents); editor lines are 1-based, so the
 * footprint is clamped to line 1.
 */
function footprint(hunk: HunkRange): { first: number; last: number } {
  const start = Math.max(1, hunk.newStart);
  if (hunk.newLines <= 0) return { first: start, last: start };
  return { first: start, last: start + hunk.newLines - 1 };
}

/**
 * The 1-based inclusive line range a selection covers.
 *
 * A whole-line selection (Ctrl+L, triple-click, Shift+Down from column 0) ends
 * at the *next* line, column 0, with nothing on that line selected, so that
 * line is excluded.
 */
export function selectionLineRange(
  startLine: number,
  endLine: number,
  endCharacter: number,
): { startLine: number; endLine: number } {
  const first = Math.min(startLine, endLine);
  let last = Math.max(startLine, endLine);
  if (endCharacter === 0 && last > first) last -= 1;
  return { startLine: first + 1, endLine: last + 1 };
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

/** A hunk as the engine reports it, including its unified-diff body. */
export interface DiffHunkLike extends HunkRange {
  header: string;
  lines: readonly string[];
}

/**
 * Label and preview for picking a hunk out of a list, describing it by its
 * content rather than its position.
 */
export function describeHunk(hunk: DiffHunkLike): { label: string; detail: string } {
  const added = hunk.lines.filter((line) => line.startsWith('+')).length;
  const removed = hunk.lines.filter((line) => line.startsWith('-')).length;
  const firstChange = hunk.lines.find((line) => line.startsWith('+') || line.startsWith('-'));
  const preview = firstChange ? firstChange.slice(0, 80) : hunk.header;
  return {
    label: `${hunk.header}  +${added} −${removed}`,
    detail: preview.trim(),
  };
}
