import { describe, expect, it } from 'vitest';
import {
  ChipBox,
  LANE_PALETTE,
  MIN_DESCRIPTION_WIDTH,
  MIN_SHOWN_LANES,
  MUTATING_ROW_ACTIONS,
  WIDEST_RELATIVE_DATES,
  anchoredScrollTop,
  columnLayout,
  contrastRatio,
  displayLane,
  edgeColorLane,
  edgePath,
  emptySelection,
  filterLabel,
  laneCap,
  laneColor,
  laneX,
  navigateIndex,
  nextMatch,
  parseColor,
  readableOn,
  reduceSelection,
  refChipAtPoint,
  refMenu,
  relativeTime,
  remapSelection,
  rowAtY,
  rowDate,
  rowMatchesQuery,
  rowMenu,
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
    const path = edgePath(
      { fromLane: 2, toLane: 2, kind: 'line' },
      rowTop,
      rowH,
      padding,
      laneWidth,
    );
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

describe('edgePath for own-lane segments', () => {
  const padding = 12;
  const laneWidth = 14;
  const rowTop = 100;
  const rowH = 26;
  const x = (lane: number): number => laneX(lane, padding, laneWidth);

  it('draws lineIn from the row top down to the dot', () => {
    expect(
      edgePath({ fromLane: 1, toLane: 1, kind: 'lineIn' }, rowTop, rowH, padding, laneWidth),
    ).toEqual({ kind: 'line', x: x(1), y0: 100, y1: 113 });
  });

  it('draws lineOut from the dot down to the row bottom', () => {
    expect(
      edgePath({ fromLane: 1, toLane: 1, kind: 'lineOut' }, rowTop, rowH, padding, laneWidth),
    ).toEqual({ kind: 'line', x: x(1), y0: 113, y1: 126 });
  });

  it('curves a line that moves to another lane from the row top to the row bottom', () => {
    const path = edgePath(
      { fromLane: 3, toLane: 1, kind: 'line' },
      rowTop,
      rowH,
      padding,
      laneWidth,
    );
    expect(path).toMatchObject({ kind: 'curve', x0: x(3), y0: 100, x1: x(1), y1: 126 });
  });

  it('draws lanes in the column the cap maps them to', () => {
    const cap = laneCap(30, 6, 2000, padding, laneWidth);
    const path = edgePath(
      { fromLane: 12, toLane: 12, kind: 'line' },
      rowTop,
      rowH,
      padding,
      laneWidth,
      (lane) => displayLane(lane, cap),
    );
    expect(path).toEqual({ kind: 'line', x: x(5), y0: 100, y1: 126 });
  });
});

describe('edgeColorLane', () => {
  it('keeps a straight segment in its own lane color', () => {
    expect(edgeColorLane({ fromLane: 2, toLane: 2, kind: 'line' })).toBe(2);
    expect(edgeColorLane({ fromLane: 0, toLane: 0, kind: 'lineOut' })).toBe(0);
  });

  it('colors a curve by the side branch, whichever end it is on', () => {
    expect(edgeColorLane({ fromLane: 0, toLane: 3, kind: 'branchOut' })).toBe(3);
    expect(edgeColorLane({ fromLane: 3, toLane: 0, kind: 'mergeIn' })).toBe(3);
    expect(edgeColorLane({ fromLane: 4, toLane: 1, kind: 'branchOut' })).toBe(4);
  });
});

describe('laneCap', () => {
  it('shows every lane when they fit', () => {
    expect(laneCap(3, 20, 1200, 12, 14)).toEqual({ shown: 3, overflow: false, hidden: 0 });
  });

  it('folds lanes past the configured maximum into the last column', () => {
    const cap = laneCap(100, 20, 4000, 12, 14);
    expect(cap).toEqual({ shown: 20, overflow: true, hidden: 81 });
    expect(displayLane(5, cap)).toBe(5);
    expect(displayLane(19, cap)).toBe(19);
    expect(displayLane(80, cap)).toBe(19);
  });

  it('never lets the graph take more than its share of a narrow panel', () => {
    // 40% of 600px leaves (240 - 24) / 14 = 15 columns.
    expect(laneCap(100, 50, 600, 12, 14).shown).toBe(15);
    // However narrow, a few lanes stay visible.
    expect(laneCap(100, 50, 100, 12, 14).shown).toBe(MIN_SHOWN_LANES);
  });
});

describe('columnLayout', () => {
  const widths = { date: 90, sha: 60, author: 150 };

  it('places date, sha and author from the right edge', () => {
    const layout = columnLayout(1200, laneCap(3, 20, 1200, 12, 14), widths, 12, 14, 16);
    expect(layout.dateX + layout.dateW).toBe(1200 - 8);
    expect(layout.shaX + layout.shaW).toBe(layout.dateX - 16);
    expect(layout.authorX + layout.authorW).toBe(layout.shaX - 16);
    expect(layout.descriptionX).toBe(layout.graphW + 8);
    expect(layout.descriptionW).toBeGreaterThan(MIN_DESCRIPTION_WIDTH);
  });

  it('drops the sha, then the author, before squeezing the description', () => {
    const narrow = columnLayout(640, laneCap(3, 20, 640, 12, 14), widths, 12, 14, 16);
    expect(narrow.shaW).toBe(0);
    expect(narrow.authorW).toBe(150);
    const narrower = columnLayout(400, laneCap(3, 20, 400, 12, 14), widths, 12, 14, 16);
    expect(narrower.shaW).toBe(0);
    expect(narrower.authorW).toBe(0);
    expect(narrower.dateW).toBe(90);
  });
});

describe('remapSelection', () => {
  it('keeps selected shas that still exist and moves the anchor with its sha', () => {
    const state = { selected: new Set(['b', 'x']), anchor: 1 };
    const next = remapSelection(state, ['a', 'b', 'x'], ['new', 'a', 'b']);
    expect([...next.selected]).toEqual(['b']);
    expect(next.anchor).toBe(2);
  });

  it('keeps the anchor index when its commit is gone', () => {
    const next = remapSelection(
      { selected: new Set(['c']), anchor: 2 },
      ['a', 'b', 'c'],
      ['a', 'b'],
    );
    expect(next.selected.size).toBe(0);
    expect(next.anchor).toBe(1);
  });
});

describe('navigateIndex', () => {
  it('moves one row with the arrows, clamped', () => {
    expect(navigateIndex('ArrowDown', 3, 10, 5)).toBe(4);
    expect(navigateIndex('ArrowUp', 0, 10, 5)).toBe(0);
    expect(navigateIndex('ArrowDown', 9, 10, 5)).toBe(9);
  });

  it('starts at the first row when nothing is selected', () => {
    expect(navigateIndex('ArrowDown', -1, 10, 5)).toBe(0);
    expect(navigateIndex('PageDown', -1, 10, 5)).toBe(4);
  });

  it('pages by the visible rows less one, and jumps with Home and End', () => {
    expect(navigateIndex('PageDown', 2, 100, 11)).toBe(12);
    expect(navigateIndex('PageUp', 12, 100, 11)).toBe(2);
    expect(navigateIndex('Home', 50, 100, 11)).toBe(0);
    expect(navigateIndex('End', 5, 100, 11)).toBe(99);
  });

  it('ignores other keys and empty lists', () => {
    expect(navigateIndex('a', 1, 10, 5)).toBeUndefined();
    expect(navigateIndex('ArrowDown', -1, 0, 5)).toBeUndefined();
  });
});

describe('anchoredScrollTop', () => {
  it('keeps the commit at the top of the viewport in place after a refresh', () => {
    // 'c' was the top row, 5px scrolled into it; two new commits arrive above.
    const top = anchoredScrollTop(
      2 * 26 + 5,
      26,
      ['a', 'b', 'c', 'd'],
      ['n1', 'n2', 'a', 'b', 'c', 'd'],
    );
    expect(top).toBe(4 * 26 + 5);
  });

  it('stays put when the top commit is gone', () => {
    expect(anchoredScrollTop(52, 26, ['a', 'b', 'c'], ['x', 'y', 'z'])).toBe(52);
  });
});

describe('rowDate', () => {
  const now = 1_700_000_000;
  it('shows nothing for the uncommitted-changes row', () => {
    expect(rowDate({ kind: 'wip', author: { name: '', email: '', time: 0 } }, now)).toBe('');
  });

  it('uses the author date, as the other views do', () => {
    expect(
      rowDate({ kind: 'commit', author: { name: 'a', email: 'a', time: now - 3 * 3600 } }, now),
    ).toBe('3 hours ago');
  });

  it('fits the widest relative dates in the measured column', () => {
    for (const seconds of [59 * 60, 11 * 30 * 86400, 23 * 3600]) {
      const text = relativeTime(now - seconds - 1, now);
      expect(text.length).toBeLessThanOrEqual(
        Math.max(...WIDEST_RELATIVE_DATES.map((t) => t.length)),
      );
    }
  });
});

describe('readableOn', () => {
  it('measures WCAG contrast', () => {
    expect(contrastRatio(parseColor('#000')!, parseColor('#fff')!)).toBeCloseTo(21, 0);
    expect(contrastRatio(parseColor('#777777')!, parseColor('#777777')!)).toBeCloseTo(1, 5);
  });

  it('parses hex and rgb() colors, with their opacity', () => {
    expect(parseColor('#d18616')).toEqual({ r: 0xd1, g: 0x86, b: 0x16 });
    expect(parseColor('#d1861680')).toEqual({ r: 0xd1, g: 0x86, b: 0x16, a: 0x80 / 255 });
    expect(parseColor('rgb(1, 2, 3)')).toEqual({ r: 1, g: 2, b: 3 });
    expect(parseColor('rgba(234, 92, 0, 0.33)')).toEqual({ r: 234, g: 92, b: 0, a: 0.33 });
    expect(parseColor('var(--x)')).toBeUndefined();
  });

  it('makes a translucent theme color opaque and readable', () => {
    // VS Code's themes define charts.orange with 33% opacity, meant for fills.
    expect(readableOn('rgba(234, 92, 0, 0.33)', '#1f1f1f')).toBe('#ea5c00');
    const light = readableOn('rgba(234, 92, 0, 0.33)', '#ffffff');
    expect(light).toMatch(/^#[0-9a-f]{6}$/);
    expect(contrastRatio(parseColor(light)!, parseColor('#ffffff')!)).toBeGreaterThanOrEqual(4.5);
  });

  it('darkens the orange tag color until it reads on a light background', () => {
    const fixed = readableOn('#d18616', '#ffffff');
    expect(fixed).not.toBe('#d18616');
    expect(contrastRatio(parseColor(fixed)!, parseColor('#ffffff')!)).toBeGreaterThanOrEqual(4.5);
  });

  it('leaves colors that already read, and colors it cannot parse, alone', () => {
    expect(readableOn('#d18616', '#1f1f1f')).toBe('#d18616');
    expect(readableOn('var(--x)', '#ffffff')).toBe('var(--x)');
  });
});

describe('find helpers', () => {
  const row = {
    sha: 'abcdef1234',
    parents: [],
    lane: 0,
    laneEdges: [],
    author: { name: 'Ada Lovelace', email: 'ada@example.invalid', time: 1 },
    time: 1,
    summary: 'Fix the Frame parser',
    refs: [{ name: 'feature/parser', kind: 'branch' as const }],
    kind: 'commit' as const,
  };

  it('matches summary, author, email, refs and sha prefixes, ignoring case', () => {
    expect(rowMatchesQuery(row, 'frame')).toBe(true);
    expect(rowMatchesQuery(row, 'LOVELACE')).toBe(true);
    expect(rowMatchesQuery(row, 'example.invalid')).toBe(true);
    expect(rowMatchesQuery(row, 'feature/')).toBe(true);
    expect(rowMatchesQuery(row, 'abcdef')).toBe(true);
    expect(rowMatchesQuery(row, 'cdef')).toBe(false);
    expect(rowMatchesQuery(row, '   ')).toBe(false);
  });

  it('never matches the uncommitted-changes row', () => {
    expect(rowMatchesQuery({ ...row, kind: 'wip' }, 'frame')).toBe(false);
  });

  it('steps through matches in both directions, wrapping around', () => {
    const matches = [2, 5, 9];
    expect(nextMatch(matches, 2, false)).toBe(5);
    expect(nextMatch(matches, 9, false)).toBe(2);
    expect(nextMatch(matches, -1, false)).toBe(2);
    expect(nextMatch(matches, 5, true)).toBe(2);
    expect(nextMatch(matches, 2, true)).toBe(9);
    expect(nextMatch([], 0, false)).toBeUndefined();
  });
});

describe('rowMenu', () => {
  const actions = (items: { action: string }[]): string[] => items.map((item) => item.action);

  it('offers no commit actions on the uncommitted-changes row', () => {
    const items = actions(rowMenu('wip', 0, true));
    expect(items).toEqual(['showDetails', 'openScm', 'stashChanges']);
  });

  it('offers stash actions, not reset, merge or cherry-pick, on a stash row', () => {
    const items = actions(rowMenu('stash', 0, true));
    expect(items).toContain('stashApply');
    expect(items).toContain('stashPop');
    expect(items).toContain('stashDrop');
    for (const action of ['reset', 'merge', 'cherryPick', 'revert', 'rebase', 'switchDetached']) {
      expect(items).not.toContain(action);
    }
  });

  it('offers a comparison when two commits are selected', () => {
    expect(actions(rowMenu('commit', 2, true))).toContain('compare');
    expect(actions(rowMenu('commit', 1, true))).not.toContain('compare');
  });

  it('leaves out everything that changes the repository in Restricted Mode', () => {
    const items = rowMenu('commit', 1, false);
    for (const item of items) expect(MUTATING_ROW_ACTIONS.has(item.action)).toBe(false);
    expect(actions(items)).toEqual(['showDetails', 'openChanges', 'copySha', 'copyMessage']);
    expect(items[0].group).toBeFalsy();
  });
});

describe('refMenu', () => {
  const actions = (items: { action: string }[]): string[] => items.map((item) => item.action);

  it('offers the branch actions on another branch', () => {
    expect(actions(refMenu({ kind: 'branch', name: 'feature' }, false, true))).toEqual([
      'checkout',
      'merge',
      'rebase',
      'createBranch',
      'rename',
      'delete',
      'push',
      'copyName',
    ]);
  });

  it('does not offer to check out, merge, rebase onto or delete the current branch', () => {
    const items = actions(refMenu({ kind: 'branch', name: 'main' }, true, true));
    for (const action of ['checkout', 'merge', 'rebase', 'delete'])
      expect(items).not.toContain(action);
    expect(items).toContain('push');
    expect(items).toContain('rename');
  });

  it('offers push and delete on tags', () => {
    expect(actions(refMenu({ kind: 'tag', name: 'v1.0' }, false, true))).toEqual(
      expect.arrayContaining(['pushTag', 'deleteTag', 'checkout']),
    );
  });

  it('keeps only copying in Restricted Mode', () => {
    expect(actions(refMenu({ kind: 'tag', name: 'v1.0' }, false, false))).toEqual(['copyName']);
    expect(actions(refMenu({ kind: 'remote', name: 'origin/main' }, false, false))).toEqual([
      'copyName',
    ]);
  });
});

describe('filterLabel', () => {
  const options = [
    { name: 'main', ref: 'refs/heads/main', kind: 'branch' as const, current: true },
  ];
  it('names every branch, one branch, or how many', () => {
    expect(filterLabel(undefined, options)).toBe('All Branches');
    expect(filterLabel([], options)).toBe('All Branches');
    expect(filterLabel(['refs/heads/main'], options)).toBe('main');
    expect(filterLabel(['refs/remotes/origin/x'], options)).toBe('origin/x');
    expect(filterLabel(['refs/heads/main', 'refs/heads/b'], options)).toBe('2 Branches');
  });
});
