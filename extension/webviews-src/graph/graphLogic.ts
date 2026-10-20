// Pure geometry/selection/windowing logic for the commit graph webview.
// No DOM access: everything here is unit-testable under plain node.

// --- Row windowing ----------------------------------------------------------

export interface VisibleRange {
  /** First row index to draw (inclusive). */
  start: number;
  /** Last row index to draw (exclusive). */
  end: number;
}

/** Rows intersecting the viewport plus `overscan` rows on each side,
 *  clamped to [0, total). */
export function visibleRange(
  scrollTop: number,
  viewportH: number,
  rowH: number,
  total: number,
  overscan: number,
): VisibleRange {
  if (total <= 0 || rowH <= 0 || viewportH <= 0) return { start: 0, end: 0 };
  const first = Math.floor(scrollTop / rowH);
  const last = Math.ceil((scrollTop + viewportH) / rowH);
  return {
    start: Math.max(0, first - overscan),
    end: Math.min(total, last + overscan),
  };
}

// --- Lane geometry ----------------------------------------------------------

/** X coordinate of a lane's center line. */
export function laneX(lane: number, padding: number, laneWidth: number): number {
  return padding + lane * laneWidth;
}

/** Width of the graph column for `laneCount` lanes. */
export function graphColumnWidth(laneCount: number, padding: number, laneWidth: number): number {
  return padding * 2 + Math.max(0, laneCount - 1) * laneWidth + laneWidth;
}

// --- Hit testing ------------------------------------------------------------

/** Row index under a viewport-relative y, or undefined outside content. */
export function rowAtY(
  viewportY: number,
  scrollTop: number,
  rowH: number,
  total: number,
): number | undefined {
  if (rowH <= 0) return undefined;
  const index = Math.floor((scrollTop + viewportY) / rowH);
  return index >= 0 && index < total ? index : undefined;
}

/** A measured ref-chip rectangle in content coordinates. */
export interface ChipBox {
  x: number;
  y: number;
  width: number;
  height: number;
  refName: string;
}

/** The chip containing (x, y), or undefined. Later chips win ties so the
 *  topmost-drawn chip is returned. */
export function refChipAtPoint(x: number, y: number, chips: readonly ChipBox[]): ChipBox | undefined {
  for (let i = chips.length - 1; i >= 0; i--) {
    const chip = chips[i];
    if (x >= chip.x && x < chip.x + chip.width && y >= chip.y && y < chip.y + chip.height) {
      return chip;
    }
  }
  return undefined;
}

// --- Edge path geometry -----------------------------------------------------

export interface LaneEdge {
  fromLane: number;
  toLane: number;
  kind: 'line' | 'lineIn' | 'lineOut' | 'mergeIn' | 'branchOut';
}

export type EdgePath =
  | { kind: 'line'; x: number; y0: number; y1: number }
  | {
      kind: 'curve';
      x0: number;
      y0: number;
      cp1x: number;
      cp1y: number;
      cp2x: number;
      cp2y: number;
      x1: number;
      y1: number;
    };

function curve(x0: number, y0: number, x1: number, y1: number): EdgePath {
  const midY = (y0 + y1) / 2;
  return { kind: 'curve', x0, y0, cp1x: x0, cp1y: midY, cp2x: x1, cp2y: midY, x1, y1 };
}

/** Geometry for one edge drawn through the row whose top edge is `rowTop`.
 *
 * - line: a lane passing through, top to bottom; when toLane differs it moves
 *   into that lane by the row bottom.
 * - lineIn: the row's own lane from the row top into the dot.
 * - lineOut: the row's own lane from the dot to the row bottom.
 * - mergeIn: another lane curves from the row top into the dot.
 * - branchOut: a curve leaves the dot for another lane at the row bottom.
 *
 * Curves are cubic with vertically-eased control points (each control point
 * sits at the midpoint y, keeping tangents vertical at both endpoints).
 * `column` maps a lane to the column it is drawn in (identity by default). */
export function edgePath(
  edge: LaneEdge,
  rowTop: number,
  rowH: number,
  padding: number,
  laneWidth: number,
  column: (lane: number) => number = (lane) => lane,
): EdgePath {
  const fromX = laneX(column(edge.fromLane), padding, laneWidth);
  const toX = laneX(column(edge.toLane), padding, laneWidth);
  const centerY = rowTop + rowH / 2;
  const bottom = rowTop + rowH;
  switch (edge.kind) {
    case 'line':
      return fromX === toX
        ? { kind: 'line', x: fromX, y0: rowTop, y1: bottom }
        : curve(fromX, rowTop, toX, bottom);
    case 'lineIn':
      return { kind: 'line', x: fromX, y0: rowTop, y1: centerY };
    case 'lineOut':
      return fromX === toX
        ? { kind: 'line', x: fromX, y0: centerY, y1: bottom }
        : curve(fromX, centerY, toX, bottom);
    case 'mergeIn':
      return curve(fromX, rowTop, toX, centerY);
    case 'branchOut':
      return curve(fromX, centerY, toX, bottom);
  }
}

/** The lane whose color an edge is drawn in. Straight segments keep their
 *  lane's color; a curve between two lanes takes the color of the one further
 *  right, the side branch it starts or ends, so a branch keeps one color from
 *  its fork to its merge. */
export function edgeColorLane(edge: LaneEdge): number {
  return Math.max(edge.fromLane, edge.toLane);
}

// --- Selection reducer ------------------------------------------------------

export interface SelectionState {
  /** Selected row shas. */
  selected: ReadonlySet<string>;
  /** Row index of the last plain/ctrl click; shift-click ranges pivot here. */
  anchor: number;
}

export function emptySelection(): SelectionState {
  return { selected: new Set(), anchor: -1 };
}

export interface ClickModifiers {
  ctrl: boolean;
  shift: boolean;
}

/** Click semantics over the ordered row list:
 *  - plain click: select only the clicked row, move the anchor.
 *  - ctrl-click: toggle the clicked row, move the anchor.
 *  - shift-click: select the contiguous range anchor..index (anchor kept);
 *    with no anchor yet it acts like a plain click. */
export function reduceSelection(
  state: SelectionState,
  index: number,
  modifiers: ClickModifiers,
  orderedShas: readonly string[],
): SelectionState {
  if (index < 0 || index >= orderedShas.length) return state;
  const sha = orderedShas[index];

  if (modifiers.shift && state.anchor >= 0 && state.anchor < orderedShas.length) {
    const lo = Math.min(state.anchor, index);
    const hi = Math.max(state.anchor, index);
    return { selected: new Set(orderedShas.slice(lo, hi + 1)), anchor: state.anchor };
  }
  if (modifiers.ctrl) {
    const selected = new Set(state.selected);
    if (selected.has(sha)) selected.delete(sha);
    else selected.add(sha);
    return { selected, anchor: index };
  }
  return { selected: new Set([sha]), anchor: index };
}

// --- Lane colors ------------------------------------------------------------

/** 10-color lane palette; readable on both light and dark themes. */
export const LANE_PALETTE: readonly string[] = [
  '#3794ff',
  '#e5589b',
  '#28a745',
  '#d9822b',
  '#9d7cd8',
  '#17a2b8',
  '#cca700',
  '#e05252',
  '#3fbf9f',
  '#8a9955',
];

/** Palette color for a lane, cycling past the palette length. */
export function laneColor(lane: number, palette: readonly string[] = LANE_PALETTE): string {
  const n = palette.length;
  return palette[((lane % n) + n) % n];
}
