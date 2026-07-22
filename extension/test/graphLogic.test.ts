import { describe, expect, it } from 'vitest';
import {
  ChipBox,
  LANE_PALETTE,
  edgePath,
  emptySelection,
  laneColor,
  laneX,
  reduceSelection,
  refChipAtPoint,
  rowAtY,
  visibleRange,
} from '../webviews-src/graph/graphLogic';

describe('visibleRange', () => {
  it('computes the window at scroll top zero', () => {
    expect(visibleRange(0, 100, 20, 100, 0)).toEqual({ start: 0, end: 5 });
  });

  it('includes partially visible rows at both edges', () => {
    // Rows 0 (partially above) through 5 (partially below) intersect.
    expect(visibleRange(10, 100, 20, 100, 0)).toEqual({ start: 0, end: 6 });
  });

  it('applies overscan on both sides', () => {
    expect(visibleRange(200, 100, 20, 100, 3)).toEqual({ start: 7, end: 18 });
  });

  it('clamps overscan at the start of the list', () => {
    expect(visibleRange(0, 100, 20, 100, 5)).toEqual({ start: 0, end: 10 });
  });

  it('clamps at the end of the list', () => {
    expect(visibleRange(1900, 100, 20, 100, 5)).toEqual({ start: 90, end: 100 });
  });

  it('returns an empty window for zero rows', () => {
    expect(visibleRange(0, 100, 20, 0, 5)).toEqual({ start: 0, end: 0 });
  });

  it('handles an exact row-aligned viewport without an extra row', () => {
    expect(visibleRange(40, 60, 20, 100, 0)).toEqual({ start: 2, end: 5 });
  });
});

describe('laneX / laneColor', () => {
  it('maps lanes to x with padding and lane width', () => {
    expect(laneX(0, 12, 14)).toBe(12);
    expect(laneX(3, 12, 14)).toBe(12 + 3 * 14);
  });

  it('cycles the 10-color palette', () => {
    expect(LANE_PALETTE).toHaveLength(10);
    expect(laneColor(0)).toBe(LANE_PALETTE[0]);
    expect(laneColor(9)).toBe(LANE_PALETTE[9]);
    expect(laneColor(10)).toBe(LANE_PALETTE[0]);
    expect(laneColor(23)).toBe(LANE_PALETTE[3]);
  });
});

describe('rowAtY', () => {
  it('maps a viewport y through the scroll offset', () => {
    expect(rowAtY(5, 0, 20, 10)).toBe(0);
    expect(rowAtY(5, 40, 20, 10)).toBe(2);
    expect(rowAtY(39, 40, 20, 10)).toBe(3);
  });

  it('returns undefined past the last row', () => {
    expect(rowAtY(10, 190, 20, 10)).toBeUndefined();
  });
});

describe('refChipAtPoint', () => {
  const chips: ChipBox[] = [
    { x: 100, y: 5, width: 40, height: 16, refName: 'main' },
    { x: 144, y: 5, width: 30, height: 16, refName: 'v1.0' },
  ];

  it('finds the chip containing the point', () => {
    expect(refChipAtPoint(110, 10, chips)?.refName).toBe('main');
    expect(refChipAtPoint(150, 20, chips)?.refName).toBe('v1.0');
  });

  it('misses points outside every chip', () => {
    expect(refChipAtPoint(99, 10, chips)).toBeUndefined();
    expect(refChipAtPoint(110, 30, chips)).toBeUndefined();
    // Right edge is exclusive.
    expect(refChipAtPoint(174, 10, chips)).toBeUndefined();
  });
});

describe('edgePath', () => {
  const padding = 12;
  const laneWidth = 14;
  const rowTop = 100;
  const rowH = 26;

  it('draws pass-through lines as full-height verticals', () => {
    const path = edgePath({ fromLane: 2, toLane: 2, kind: 'line' }, rowTop, rowH, padding, laneWidth);
    expect(path).toEqual({ kind: 'line', x: laneX(2, padding, laneWidth), y0: 100, y1: 126 });
  });

  it('curves mergeIn from the row top into the dot at row center', () => {
    const path = edgePath(
      { fromLane: 3, toLane: 1, kind: 'mergeIn' },
      rowTop,
      rowH,
      padding,
      laneWidth,
    );
    const fromX = laneX(3, padding, laneWidth);
    const toX = laneX(1, padding, laneWidth);
    expect(path).toEqual({
      kind: 'curve',
      x0: fromX,
      y0: 100,
      cp1x: fromX,
      cp1y: 106.5,
      cp2x: toX,
      cp2y: 106.5,
      x1: toX,
      y1: 113,
    });
  });

  it('curves branchOut from the dot at row center down to the parent lane', () => {
    const path = edgePath(
      { fromLane: 0, toLane: 2, kind: 'branchOut' },
      rowTop,
      rowH,
      padding,
      laneWidth,
    );
    const fromX = laneX(0, padding, laneWidth);
    const toX = laneX(2, padding, laneWidth);
    expect(path).toEqual({
      kind: 'curve',
      x0: fromX,
      y0: 113,
      cp1x: fromX,
      cp1y: 119.5,
      cp2x: toX,
      cp2y: 119.5,
      x1: toX,
      y1: 126,
    });
  });

  it('keeps curve control points vertically eased (tangents vertical)', () => {
    const path = edgePath(
      { fromLane: 1, toLane: 4, kind: 'mergeIn' },
      rowTop,
      rowH,
      padding,
      laneWidth,
    );
    if (path.kind !== 'curve') throw new Error('expected a curve');
    expect(path.cp1x).toBe(path.x0);
    expect(path.cp2x).toBe(path.x1);
    expect(path.cp1y).toBe((path.y0 + path.y1) / 2);
    expect(path.cp2y).toBe((path.y0 + path.y1) / 2);
  });
});

describe('reduceSelection', () => {
  const shas = ['a', 'b', 'c', 'd', 'e'];

  it('plain click selects a single row and moves the anchor', () => {
    const state = reduceSelection(emptySelection(), 2, { ctrl: false, shift: false }, shas);
    expect([...state.selected]).toEqual(['c']);
    expect(state.anchor).toBe(2);
  });

  it('plain click replaces any existing selection', () => {
    let state = reduceSelection(emptySelection(), 1, { ctrl: false, shift: false }, shas);
    state = reduceSelection(state, 3, { ctrl: false, shift: false }, shas);
    expect([...state.selected]).toEqual(['d']);
  });

  it('ctrl-click toggles rows in and out of the selection', () => {
    let state = reduceSelection(emptySelection(), 0, { ctrl: false, shift: false }, shas);
    state = reduceSelection(state, 2, { ctrl: true, shift: false }, shas);
    expect([...state.selected].sort()).toEqual(['a', 'c']);
    state = reduceSelection(state, 0, { ctrl: true, shift: false }, shas);
    expect([...state.selected]).toEqual(['c']);
    expect(state.anchor).toBe(0);
  });

  it('shift-click selects the range from the anchor, keeping the anchor', () => {
    let state = reduceSelection(emptySelection(), 1, { ctrl: false, shift: false }, shas);
    state = reduceSelection(state, 3, { ctrl: false, shift: true }, shas);
    expect([...state.selected].sort()).toEqual(['b', 'c', 'd']);
    expect(state.anchor).toBe(1);
    // A second shift-click re-ranges from the same anchor.
    state = reduceSelection(state, 0, { ctrl: false, shift: true }, shas);
    expect([...state.selected].sort()).toEqual(['a', 'b']);
    expect(state.anchor).toBe(1);
  });

  it('shift-click without an anchor behaves like a plain click', () => {
    const state = reduceSelection(emptySelection(), 4, { ctrl: false, shift: true }, shas);
    expect([...state.selected]).toEqual(['e']);
    expect(state.anchor).toBe(4);
  });

  it('ignores out-of-range indices', () => {
    const initial = reduceSelection(emptySelection(), 1, { ctrl: false, shift: false }, shas);
    expect(reduceSelection(initial, -1, { ctrl: false, shift: false }, shas)).toBe(initial);
    expect(reduceSelection(initial, 5, { ctrl: false, shift: false }, shas)).toBe(initial);
  });
});
