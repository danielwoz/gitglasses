// Pure geometry/selection/windowing logic for the commit graph webview.
// No DOM access: everything here is unit-testable under plain node.

import type { GraphRef, GraphRow } from '@gitglasses/protocol';

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

/** Share of the viewport width the graph column may take before lanes
 *  collapse into the overflow column. */
export const MAX_GRAPH_SHARE = 0.4;
/** Fewest columns the graph shows however narrow the panel is. */
export const MIN_SHOWN_LANES = 4;

/** How many lane columns are drawn, and whether the last one stands for every
 *  lane from it rightwards. */
export interface LaneCap {
  /** Columns drawn: lanes 0..shown-1. */
  shown: number;
  /** True when lanes past the cap fold into column shown-1. */
  overflow: boolean;
  /** Lanes folded into the overflow column (0 without overflow). */
  hidden: number;
}

/** Caps the graph column at `maxLanes` and at MAX_GRAPH_SHARE of the
 *  viewport, so commit messages stay readable on merge-heavy repositories. */
export function laneCap(
  laneCount: number,
  maxLanes: number,
  viewportW: number,
  padding: number,
  laneWidth: number,
): LaneCap {
  const byWidth = Math.floor((viewportW * MAX_GRAPH_SHARE - padding * 2) / laneWidth);
  const limit = Math.max(MIN_SHOWN_LANES, Math.min(Math.floor(maxLanes), byWidth));
  if (laneCount <= limit) return { shown: Math.max(1, laneCount), overflow: false, hidden: 0 };
  return { shown: limit, overflow: true, hidden: laneCount - (limit - 1) };
}

/** The column a lane is drawn in under `cap`. */
export function displayLane(lane: number, cap: LaneCap): number {
  return cap.overflow && lane >= cap.shown - 1 ? cap.shown - 1 : lane;
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
  /** Index of the row the chip is drawn on. */
  row?: number;
  /** Index of the ref within the row's refs. */
  refIndex?: number;
}

/** The chip containing (x, y), or undefined. Later chips win ties so the
 *  topmost-drawn chip is returned. */
export function refChipAtPoint(
  x: number,
  y: number,
  chips: readonly ChipBox[],
): ChipBox | undefined {
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

/** Selection after the row list was replaced: the same shas where they still
 *  exist, with the anchor following its sha (or staying at its index, clamped,
 *  when that commit is gone). */
export function remapSelection(
  state: SelectionState,
  previousShas: readonly string[],
  nextShas: readonly string[],
): SelectionState {
  const present = new Set(nextShas);
  const selected = new Set([...state.selected].filter((sha) => present.has(sha)));
  if (state.anchor < 0) return { selected, anchor: -1 };
  const anchorSha = previousShas[state.anchor];
  const moved = anchorSha === undefined ? -1 : nextShas.indexOf(anchorSha);
  const anchor =
    moved >= 0 ? moved : nextShas.length === 0 ? -1 : Math.min(state.anchor, nextShas.length - 1);
  return { selected, anchor };
}

// --- Keyboard navigation ----------------------------------------------------

/** The row a navigation key moves to from `current` (-1: nothing selected),
 *  or undefined for keys that do not navigate. */
export function navigateIndex(
  key: string,
  current: number,
  total: number,
  pageRows: number,
): number | undefined {
  if (total <= 0) return undefined;
  const last = total - 1;
  const clamp = (value: number): number => Math.min(last, Math.max(0, value));
  const page = Math.max(1, pageRows - 1);
  switch (key) {
    case 'ArrowDown':
      return current < 0 ? 0 : clamp(current + 1);
    case 'ArrowUp':
      return current < 0 ? 0 : clamp(current - 1);
    case 'PageDown':
      return clamp((current < 0 ? 0 : current) + page);
    case 'PageUp':
      return clamp((current < 0 ? 0 : current) - page);
    case 'Home':
      return 0;
    case 'End':
      return last;
    default:
      return undefined;
  }
}

/** Scroll position after the row list was replaced, keeping the commit that
 *  was at the top of the viewport at the same height. Falls back to the old
 *  position when that commit is gone. */
export function anchoredScrollTop(
  scrollTop: number,
  rowH: number,
  previousShas: readonly string[],
  nextShas: readonly string[],
): number {
  if (rowH <= 0 || previousShas.length === 0) return scrollTop;
  const topIndex = Math.min(previousShas.length - 1, Math.floor(scrollTop / rowH));
  const offset = scrollTop - topIndex * rowH;
  const moved = nextShas.indexOf(previousShas[topIndex]);
  if (moved < 0) return scrollTop;
  return moved * rowH + offset;
}

// --- Dates ------------------------------------------------------------------

/** Human "N units ago" for unix seconds (duplicated from the host side so
 *  the browser bundle has no extension imports). */
export function relativeTime(
  unixSeconds: number,
  nowUnixSeconds: number = Date.now() / 1000,
): string {
  const deltaSec = nowUnixSeconds - unixSeconds;
  const units: [number, string][] = [
    [60 * 60 * 24 * 365, 'year'],
    [60 * 60 * 24 * 30, 'month'],
    [60 * 60 * 24 * 7, 'week'],
    [60 * 60 * 24, 'day'],
    [60 * 60, 'hour'],
    [60, 'minute'],
  ];
  for (const [seconds, name] of units) {
    const value = Math.floor(deltaSec / seconds);
    if (value >= 1) return `${value} ${name}${value > 1 ? 's' : ''} ago`;
  }
  return 'just now';
}

/** Date-column text for a row: the author date, which blame, Commits and File
 *  History show too. The uncommitted-changes row has no date. */
export function rowDate(row: Pick<GraphRow, 'kind' | 'author'>, nowUnixSeconds?: number): string {
  if (row.kind === 'wip') return '';
  return relativeTime(row.author.time, nowUnixSeconds);
}

/** The longest texts relativeTime produces, which size the date column. */
export const WIDEST_RELATIVE_DATES = ['59 minutes ago', '11 months ago', '23 hours ago'];

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

// --- Color contrast ---------------------------------------------------------

export interface Rgb {
  r: number;
  g: number;
  b: number;
  /** Opacity from 0 to 1; absent means opaque. */
  a?: number;
}

/** Parses #rgb, #rgba, #rrggbb, #rrggbbaa and rgb()/rgba() colors; undefined
 *  for anything else. */
export function parseColor(text: string): Rgb | undefined {
  const value = text.trim().toLowerCase();
  const hex = /^#([0-9a-f]{3,8})$/.exec(value);
  if (hex) {
    const digits = hex[1];
    if (digits.length === 3 || digits.length === 4) {
      const [r, g, b] = [0, 1, 2].map((i) => parseInt(digits[i] + digits[i], 16));
      return digits.length === 4
        ? { r, g, b, a: parseInt(digits[3] + digits[3], 16) / 255 }
        : { r, g, b };
    }
    if (digits.length === 6 || digits.length === 8) {
      const [r, g, b] = [0, 2, 4].map((i) => parseInt(digits.slice(i, i + 2), 16));
      return digits.length === 8
        ? { r, g, b, a: parseInt(digits.slice(6, 8), 16) / 255 }
        : { r, g, b };
    }
    return undefined;
  }
  const rgb =
    /^rgba?\(\s*(\d+(?:\.\d+)?)[\s,]+(\d+(?:\.\d+)?)[\s,]+(\d+(?:\.\d+)?)(?:[\s,/]+(\d*(?:\.\d+)?)(%?))?/.exec(
      value,
    );
  if (rgb) {
    const color: Rgb = { r: Number(rgb[1]), g: Number(rgb[2]), b: Number(rgb[3]) };
    if (rgb[4]) color.a = Number(rgb[4]) / (rgb[5] ? 100 : 1);
    return color;
  }
  return undefined;
}

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance (opacity ignored). */
export function luminance(color: Rgb): number {
  return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
}

/** WCAG contrast ratio between two opaque colors (1 to 21). */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

function toHex(color: Rgb): string {
  const part = (v: number): string =>
    Math.round(Math.min(255, Math.max(0, v)))
      .toString(16)
      .padStart(2, '0');
  return `#${part(color.r)}${part(color.g)}${part(color.b)}`;
}

/** An opaque `color` that reads on `background`, for text. Opacity is
 *  dropped (some themes define chart colors with alpha for fills, which
 *  would leave text faint), then the color is darkened on a light background
 *  or lightened on a dark one until it reaches `minRatio`. Colors that cannot
 *  be parsed come back unchanged. */
export function readableOn(color: string, background: string, minRatio = 4.5): string {
  const parsed = parseColor(color);
  const bg = parseColor(background);
  if (!parsed || !bg) return color;
  const fg = { r: parsed.r, g: parsed.g, b: parsed.b };
  const opaqueBg = { r: bg.r, g: bg.g, b: bg.b };
  if (contrastRatio(fg, opaqueBg) >= minRatio) return parsed.a === undefined ? color : toHex(fg);
  const target = luminance(opaqueBg) > 0.5 ? { r: 0, g: 0, b: 0 } : { r: 255, g: 255, b: 255 };
  for (let step = 1; step <= 20; step++) {
    const t = step / 20;
    const mixed = {
      r: fg.r + (target.r - fg.r) * t,
      g: fg.g + (target.g - fg.g) * t,
      b: fg.b + (target.b - fg.b) * t,
    };
    if (contrastRatio(mixed, opaqueBg) >= minRatio) return toHex(mixed);
  }
  return toHex(target);
}

// --- Find -------------------------------------------------------------------

/** Whether a loaded row matches a find query: case-insensitive substring of
 *  the summary, author name or email, or a ref name, or a sha prefix. */
export function rowMatchesQuery(row: GraphRow, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q || row.kind === 'wip') return false;
  if (row.sha.startsWith(q)) return true;
  if (row.summary.toLowerCase().includes(q)) return true;
  if (row.author.name.toLowerCase().includes(q)) return true;
  if (row.author.email.toLowerCase().includes(q)) return true;
  return row.refs.some((ref) => ref.name.toLowerCase().includes(q));
}

/** Index of the next match after `from` (or before it, backwards), wrapping
 *  around; undefined when nothing matches. */
export function nextMatch(
  matches: readonly number[],
  from: number,
  backwards: boolean,
): number | undefined {
  if (matches.length === 0) return undefined;
  if (backwards) {
    for (let i = matches.length - 1; i >= 0; i--) if (matches[i] < from) return matches[i];
    return matches[matches.length - 1];
  }
  for (const index of matches) if (index > from) return index;
  return matches[0];
}

// --- Menus ------------------------------------------------------------------

/** Actions the row context menu offers. */
export type RowMenuAction =
  | 'showDetails'
  | 'openChanges'
  | 'compare'
  | 'copySha'
  | 'copyMessage'
  | 'createBranch'
  | 'createTag'
  | 'switchDetached'
  | 'cherryPick'
  | 'revert'
  | 'reset'
  | 'merge'
  | 'rebase'
  | 'openScm'
  | 'stashChanges'
  | 'stashApply'
  | 'stashPop'
  | 'stashDrop';

/** Actions the context menu of a ref chip offers. */
export type RefMenuAction =
  | 'checkout'
  | 'merge'
  | 'rebase'
  | 'createBranch'
  | 'rename'
  | 'delete'
  | 'push'
  | 'pushTag'
  | 'deleteTag'
  | 'copyName';

export interface MenuItem<A extends string> {
  action: A;
  label: string;
  /** Starts a new group (drawn with a separator above it). */
  group?: boolean;
}

/** What the menus may offer. */
export interface MenuOptions {
  /** False in Restricted Mode: nothing that changes the repository. */
  canMutate: boolean;
  /** Whether the engine serves branch renames, pushes of a branch that is not
   *  checked out, and tag creation, pushes and deletion. */
  refManagement: boolean;
}

/** Row actions that change the repository. */
export const MUTATING_ROW_ACTIONS: ReadonlySet<RowMenuAction> = new Set<RowMenuAction>([
  'createBranch',
  'createTag',
  'switchDetached',
  'cherryPick',
  'revert',
  'reset',
  'merge',
  'rebase',
  'stashChanges',
  'stashApply',
  'stashPop',
  'stashDrop',
]);

/** Ref actions that change the repository or contact a remote. */
export const MUTATING_REF_ACTIONS: ReadonlySet<RefMenuAction> = new Set<RefMenuAction>([
  'checkout',
  'merge',
  'rebase',
  'createBranch',
  'rename',
  'delete',
  'push',
  'pushTag',
  'deleteTag',
]);

/** The row menu for a row of `kind`. The uncommitted-changes and stash rows
 *  are not commits a branch can be reset, merged or rebased onto, so they get
 *  their own actions. */
export function rowMenu(
  kind: GraphRow['kind'],
  selectedCommits: number,
  options: MenuOptions,
): MenuItem<RowMenuAction>[] {
  let items: MenuItem<RowMenuAction>[];
  if (kind === 'wip') {
    items = [
      { action: 'showDetails', label: 'Show Changes' },
      { action: 'openScm', label: 'Open Source Control' },
      { action: 'stashChanges', label: 'Stash Changes…', group: true },
    ];
  } else if (kind === 'stash') {
    items = [
      { action: 'showDetails', label: 'Show Stash Details' },
      { action: 'openChanges', label: 'Open All Changes' },
      { action: 'stashApply', label: 'Apply Stash', group: true },
      { action: 'stashPop', label: 'Pop Stash' },
      { action: 'stashDrop', label: 'Drop Stash…' },
      { action: 'copySha', label: 'Copy SHA', group: true },
    ];
  } else {
    items = [
      { action: 'showDetails', label: 'Show Commit Details' },
      { action: 'openChanges', label: 'Open All Changes' },
      ...(selectedCommits === 2
        ? [{ action: 'compare' as const, label: 'Compare Selected Commits' }]
        : []),
      { action: 'createBranch', label: 'Create Branch Here…', group: true },
      ...(options.refManagement
        ? [{ action: 'createTag' as const, label: 'Create Tag Here…' }]
        : []),
      { action: 'switchDetached', label: 'Switch to Commit (Detached)' },
      {
        action: 'cherryPick',
        label: selectedCommits > 1 ? 'Cherry-pick Commits' : 'Cherry-pick Commit',
        group: true,
      },
      { action: 'revert', label: selectedCommits > 1 ? 'Revert Commits' : 'Revert Commit' },
      { action: 'reset', label: 'Reset Current Branch to Here…' },
      { action: 'merge', label: 'Merge into Current Branch…' },
      { action: 'rebase', label: 'Rebase Current Branch onto Here…' },
      { action: 'copySha', label: 'Copy SHA', group: true },
      { action: 'copyMessage', label: 'Copy Message' },
    ];
  }
  return options.canMutate ? items : withoutMutations(items, MUTATING_ROW_ACTIONS);
}

/** The chip menu for a ref. `current` is true for the checked-out branch
 *  (and for HEAD itself), which pushes without the branch management methods. */
export function refMenu(
  ref: Pick<GraphRef, 'kind' | 'name'>,
  current: boolean,
  options: MenuOptions,
): MenuItem<RefMenuAction>[] {
  const managed = options.refManagement;
  let items: MenuItem<RefMenuAction>[];
  switch (ref.kind) {
    case 'head':
      items = [
        { action: 'createBranch', label: 'Create Branch Here…' },
        { action: 'copyName', label: 'Copy Name', group: true },
      ];
      break;
    case 'branch':
      items = [
        ...(current
          ? []
          : [
              { action: 'checkout' as const, label: `Checkout ${ref.name}` },
              { action: 'merge' as const, label: `Merge ${ref.name} into Current Branch…` },
              { action: 'rebase' as const, label: `Rebase Current Branch onto ${ref.name}…` },
            ]),
        { action: 'createBranch', label: 'Create Branch Here…', group: true },
        ...(managed ? [{ action: 'rename' as const, label: 'Rename Branch…' }] : []),
        ...(current ? [] : [{ action: 'delete' as const, label: 'Delete Branch…' }]),
        ...(current || managed
          ? [{ action: 'push' as const, label: 'Push Branch', group: true }]
          : []),
        { action: 'copyName', label: 'Copy Branch Name', group: true },
      ];
      break;
    case 'remote':
      items = [
        { action: 'checkout', label: `Checkout ${ref.name}` },
        { action: 'merge', label: `Merge ${ref.name} into Current Branch…` },
        { action: 'rebase', label: `Rebase Current Branch onto ${ref.name}…` },
        { action: 'createBranch', label: 'Create Branch Here…', group: true },
        { action: 'copyName', label: 'Copy Branch Name', group: true },
      ];
      break;
    case 'tag':
      items = [
        { action: 'checkout', label: `Checkout ${ref.name} (Detached)` },
        { action: 'merge', label: `Merge ${ref.name} into Current Branch…` },
        { action: 'createBranch', label: 'Create Branch Here…', group: true },
        ...(managed
          ? [
              { action: 'pushTag' as const, label: 'Push Tag…', group: true },
              { action: 'deleteTag' as const, label: 'Delete Tag…' },
            ]
          : []),
        { action: 'copyName', label: 'Copy Tag Name', group: true },
      ];
      break;
    case 'stash':
      items = [{ action: 'copyName', label: 'Copy Stash Name' }];
      break;
  }
  return options.canMutate ? items : withoutMutations(items, MUTATING_REF_ACTIONS);
}

function withoutMutations<A extends string>(
  items: MenuItem<A>[],
  mutating: ReadonlySet<A>,
): MenuItem<A>[] {
  const kept = items.filter((item) => !mutating.has(item.action));
  // The first item never needs a separator above it.
  return kept.map((item, i) => (i === 0 && item.group ? { ...item, group: false } : item));
}

// --- Branch filter ----------------------------------------------------------

/** One entry of the branch filter. */
export interface BranchOption {
  /** Short name shown in the list (main, origin/main). */
  name: string;
  /** Full ref the engine walks (refs/heads/main). */
  ref: string;
  kind: 'branch' | 'remote';
  current: boolean;
}

/** Label of the filter button: every branch, one, or how many. */
export function filterLabel(
  selected: readonly string[] | undefined,
  options: readonly BranchOption[],
): string {
  if (!selected || selected.length === 0) return 'All Branches';
  if (selected.length === 1) {
    return (
      options.find((option) => option.ref === selected[0])?.name ??
      selected[0].replace(/^refs\/(heads|remotes)\//, '')
    );
  }
  return `${selected.length} Branches`;
}

// --- Columns ----------------------------------------------------------------

export interface ColumnWidths {
  /** Width of the widest relative date in the current font. */
  date: number;
  /** Width of a short sha in the monospace font. */
  sha: number;
  author: number;
}

/** Where each column starts, in CSS pixels from the left edge. Columns that do
 *  not fit are hidden (width 0), author and sha first, so the commit message
 *  keeps room. */
export interface ColumnLayout {
  cap: LaneCap;
  graphW: number;
  descriptionX: number;
  descriptionW: number;
  authorX: number;
  authorW: number;
  shaX: number;
  shaW: number;
  dateX: number;
  dateW: number;
}

/** Room the description column keeps before optional columns are dropped. */
export const MIN_DESCRIPTION_WIDTH = 240;

export function columnLayout(
  viewportW: number,
  cap: LaneCap,
  widths: ColumnWidths,
  padding: number,
  laneWidth: number,
  gap: number,
): ColumnLayout {
  const graphW = graphColumnWidth(cap.shown, padding, laneWidth);
  const descriptionX = graphW + gap / 2;
  const dateW = Math.ceil(widths.date);
  let shaW = Math.ceil(widths.sha);
  let authorW = Math.ceil(widths.author);
  const room = (): number =>
    viewportW -
    descriptionX -
    gap -
    dateW -
    (shaW ? shaW + gap : 0) -
    (authorW ? authorW + gap : 0);
  if (room() < MIN_DESCRIPTION_WIDTH) shaW = 0;
  if (room() < MIN_DESCRIPTION_WIDTH) authorW = 0;
  const dateX = viewportW - gap / 2 - dateW;
  const shaX = shaW ? dateX - gap - shaW : dateX;
  const authorX = authorW ? shaX - gap - authorW : shaX;
  return {
    cap,
    graphW,
    descriptionX,
    descriptionW: Math.max(0, authorX - gap - descriptionX),
    authorX,
    authorW,
    shaX,
    shaW,
    dateX,
    dateW,
  };
}
