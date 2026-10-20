// Canvas painter for the commit graph. The canvas is viewport-sized rather
// than content-sized, so the draw loop covers only the rows visibleRange
// reports and the context is translated by the scroll offset to place them.

import type { GraphRef, GraphRow, ProvenanceMark } from './ipc';
import {
  type ProvenanceFilter,
  passesProvenanceFilter,
} from '../../src/provenance/provenanceLogic';
import {
  ChipBox,
  ColumnLayout,
  LaneCap,
  SelectionState,
  WIDEST_RELATIVE_DATES,
  columnLayout,
  displayLane,
  edgeColorLane,
  edgePath,
  laneCap,
  laneColor,
  laneX,
  readableOn,
  rowDate,
  visibleRange,
} from './graphLogic';
import { shortSha } from '@gitglasses/protocol/sha';

export const ROW_HEIGHT = 26;
export const LANE_WIDTH = 14;
export const LANE_PADDING = 12;
export const OVERSCAN_ROWS = 6;
export const COLUMN_GAP = 16;

const DOT_RADIUS = 4;
const CHIP_HEIGHT = 18;
const CHIP_PAD_X = 6;
const CHIP_GAP = 4;
const CHIP_RADIUS = 4;
const AUTHOR_WIDTH = 150;
/** Chips never take more than this share of the description column. */
const MAX_CHIP_SHARE = 0.6;
/** The badge on commits that declare an AI agent. */
const AGENT_BADGE = 'AI';
/** Opacity of the rows the provenance filter leaves out. */
const FILTERED_OUT_ALPHA = 0.35;

export interface ThemeColors {
  foreground: string;
  mutedForeground: string;
  background: string;
  selectionBackground: string;
  selectionForeground: string;
  inactiveSelectionBackground: string;
  hoverBackground: string;
  focusBorder: string;
  /** Set in high-contrast themes, where selections are outlined. */
  contrastActiveBorder: string;
  findMatchBackground: string;
  findMatchHighlightBackground: string;
  chipBranch: string;
  chipRemote: string;
  chipTag: string;
  chipStash: string;
  chipHead: string;
  chipAgent: string;
  fontFamily: string;
  fontSize: string;
  monoFontFamily: string;
}

/** Resolves theme colors from VS Code CSS custom properties, with fallbacks
 *  for environments where the variables are absent. */
export function readThemeColors(style: { getPropertyValue(name: string): string }): ThemeColors {
  const read = (name: string, fallback: string): string =>
    style.getPropertyValue(name).trim() || fallback;
  const contrastActiveBorder = read('--vscode-contrastActiveBorder', '');
  return {
    foreground: read('--vscode-foreground', '#cccccc'),
    mutedForeground: read('--vscode-descriptionForeground', '#8b8b8b'),
    background: read('--vscode-editor-background', '#1e1e1e'),
    // High-contrast themes define no selection fill and outline instead.
    selectionBackground: read(
      '--vscode-list-activeSelectionBackground',
      contrastActiveBorder ? '' : '#04395e',
    ),
    selectionForeground: read('--vscode-list-activeSelectionForeground', ''),
    inactiveSelectionBackground: read('--vscode-list-inactiveSelectionBackground', ''),
    hoverBackground: read('--vscode-list-hoverBackground', ''),
    focusBorder: read('--vscode-focusBorder', '#007fd4'),
    contrastActiveBorder,
    findMatchBackground: read('--vscode-editor-findMatchBackground', '#515c6a'),
    findMatchHighlightBackground: read(
      '--vscode-editor-findMatchHighlightBackground',
      'rgba(234, 92, 0, 0.33)',
    ),
    chipBranch: read('--vscode-charts-blue', '#3794ff'),
    chipRemote: read('--vscode-charts-purple', '#b180d7'),
    chipTag: read('--vscode-charts-orange', '#d18616'),
    chipStash: read('--vscode-descriptionForeground', '#8b8b8b'),
    chipHead: read('--vscode-charts-green', '#89d185'),
    chipAgent: read('--vscode-charts-yellow', '#cca700'),
    fontFamily: read('--vscode-font-family', 'sans-serif'),
    fontSize: read('--vscode-font-size', '13px'),
    monoFontFamily: read('--vscode-editor-font-family', 'monospace'),
  };
}

function chipBaseColor(kind: GraphRef['kind'], theme: ThemeColors): string {
  switch (kind) {
    case 'head':
      return theme.chipHead;
    case 'branch':
      return theme.chipBranch;
    case 'remote':
      return theme.chipRemote;
    case 'tag':
      return theme.chipTag;
    case 'stash':
      return theme.chipStash;
  }
}

export interface RenderState {
  rows: readonly GraphRow[];
  /** Highest lane index across all loaded rows and their edges, accumulated
   *  by GraphStore as pages arrive; sizes the graph column. It covers every
   *  loaded row, not just the drawn window, so the column stays put while
   *  scrolling. */
  maxLane: number;
  /** Most lane columns to draw before lanes fold into an overflow column. */
  maxLanes: number;
  selection: SelectionState;
  scrollTop: number;
  viewportW: number;
  viewportH: number;
  theme: ThemeColors;
  /** Row under the pointer, or -1. */
  hoverIndex: number;
  /** Whether the list has keyboard focus: the anchor row gets a focus outline. */
  focused: boolean;
  /** Find matches, and the one Enter last moved to. */
  matches: ReadonlySet<string>;
  currentMatch: string | undefined;
  /** The commit HEAD points to, drawn with a ring. */
  headSha: string | undefined;
  /** Declared provenance of loaded commits and the filter that dims the
   *  rows it leaves out; absent while provenance is turned off. */
  provenance?: { marks: ReadonlyMap<string, ProvenanceMark>; filter: ProvenanceFilter };
}

export class GraphRenderer {
  /** Measured chip boxes from the last paint, in content coordinates,
   *  for hit-testing ref chips. */
  chipBoxes: ChipBox[] = [];
  /** Column positions of the last paint, for the header and hit-testing. */
  layout: ColumnLayout | undefined;
  private chipColors = new Map<string, string>();
  private measuredFor = '';
  private widths = { date: 90, sha: 60, author: AUTHOR_WIDTH };

  constructor(private readonly canvas: HTMLCanvasElement) {}

  /** Forgets colors derived from the previous theme. */
  themeChanged(): void {
    this.chipColors.clear();
    this.measuredFor = '';
  }

  render(state: RenderState): void {
    const { rows, maxLane, selection, scrollTop, viewportW, viewportH, theme } = state;
    const dpr = window.devicePixelRatio || 1;
    const pixelW = Math.max(1, Math.round(viewportW * dpr));
    const pixelH = Math.max(1, Math.round(viewportH * dpr));
    if (this.canvas.width !== pixelW) this.canvas.width = pixelW;
    if (this.canvas.height !== pixelH) this.canvas.height = pixelH;
    this.canvas.style.width = `${viewportW}px`;
    this.canvas.style.height = `${viewportH}px`;

    const ctx = this.canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, viewportW, viewportH);
    const textFont = `${theme.fontSize} ${theme.fontFamily}`;
    const chipFont = `${Math.max(10, (parseInt(theme.fontSize, 10) || 13) - 1)}px ${theme.fontFamily}`;
    const monoFont = `${Math.max(10, (parseInt(theme.fontSize, 10) || 13) - 1)}px ${theme.monoFontFamily}`;
    this.measure(ctx, textFont, monoFont);

    const cap = laneCap(maxLane + 1, state.maxLanes, viewportW, LANE_PADDING, LANE_WIDTH);
    const layout = columnLayout(viewportW, cap, this.widths, LANE_PADDING, LANE_WIDTH, COLUMN_GAP);
    this.layout = layout;
    this.chipBoxes = [];

    ctx.translate(0, -scrollTop);
    const range = visibleRange(scrollTop, viewportH, ROW_HEIGHT, rows.length, OVERSCAN_ROWS);

    for (let i = range.start; i < range.end; i++) {
      this.drawRowBackground(ctx, state, i, viewportW);
    }
    // Lines first, across all rows, so dots and text always sit on top.
    for (let i = range.start; i < range.end; i++) {
      this.drawEdges(ctx, rows[i], i * ROW_HEIGHT, cap, theme);
    }
    for (let i = range.start; i < range.end; i++) {
      const row = rows[i];
      const rowTop = i * ROW_HEIGHT;
      const centerY = rowTop + ROW_HEIGHT / 2;
      const selected = selection.selected.has(row.sha);
      const x = laneX(displayLane(row.lane, cap), LANE_PADDING, LANE_WIDTH);
      const mark = state.provenance?.marks.get(row.sha);
      const filteredOut =
        state.provenance !== undefined &&
        !passesProvenanceFilter(state.provenance.filter, row.kind === 'commit', mark?.agent);
      ctx.save();
      if (filteredOut) ctx.globalAlpha = FILTERED_OUT_ALPHA;
      this.drawDot(ctx, row, x, centerY, row.sha === state.headSha, theme);
      this.drawText(ctx, row, i, centerY, layout, theme, selected, textFont, chipFont, monoFont, {
        agentBadge: mark?.agent === true,
      });
      ctx.restore();
    }

    if (cap.overflow) this.drawOverflowMarker(ctx, cap, scrollTop, theme, chipFont);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  /** Measures the date and sha columns once per font. */
  private measure(ctx: CanvasRenderingContext2D, textFont: string, monoFont: string): void {
    const key = `${textFont}|${monoFont}`;
    if (this.measuredFor === key) return;
    ctx.font = textFont;
    const date = Math.max(...WIDEST_RELATIVE_DATES.map((text) => ctx.measureText(text).width));
    ctx.font = monoFont;
    const sha = ctx.measureText('0000000').width;
    this.widths = { date: date + 4, sha: sha + 4, author: AUTHOR_WIDTH };
    this.measuredFor = key;
  }

  private drawRowBackground(
    ctx: CanvasRenderingContext2D,
    state: RenderState,
    index: number,
    viewportW: number,
  ): void {
    const { theme } = state;
    const row = state.rows[index];
    const top = index * ROW_HEIGHT;
    const selected = state.selection.selected.has(row.sha);
    const fill = (color: string): void => {
      if (!color) return;
      ctx.fillStyle = color;
      ctx.fillRect(0, top, viewportW, ROW_HEIGHT);
    };
    if (selected) {
      fill(
        state.focused
          ? theme.selectionBackground
          : theme.inactiveSelectionBackground || theme.selectionBackground,
      );
    } else if (index === state.hoverIndex) {
      fill(theme.hoverBackground);
    }
    if (state.matches.has(row.sha)) {
      fill(
        row.sha === state.currentMatch
          ? theme.findMatchBackground
          : theme.findMatchHighlightBackground,
      );
    }
    const outline = (color: string, dashed: boolean): void => {
      ctx.save();
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      if (dashed) ctx.setLineDash([2, 2]);
      ctx.strokeRect(0.5, top + 0.5, viewportW - 1, ROW_HEIGHT - 1);
      ctx.restore();
    };
    // High-contrast themes outline the selection instead of filling it.
    if (selected && theme.contrastActiveBorder) outline(theme.contrastActiveBorder, false);
    if (state.focused && index === state.selection.anchor) {
      outline(theme.contrastActiveBorder || theme.focusBorder, Boolean(theme.contrastActiveBorder));
    }
  }

  private drawEdges(
    ctx: CanvasRenderingContext2D,
    row: GraphRow,
    rowTop: number,
    cap: LaneCap,
    theme: ThemeColors,
  ): void {
    const column = (lane: number): number => displayLane(lane, cap);
    const overflowColumn = cap.shown - 1;
    // Lanes folded into the overflow column all draw the same segment; draw
    // it once, muted and dashed, instead of a pile of colored ones.
    const drawn = new Set<string>();
    ctx.lineWidth = 2;
    for (const edge of row.laneEdges) {
      const folded =
        cap.overflow &&
        column(edge.fromLane) === overflowColumn &&
        column(edge.toLane) === overflowColumn;
      const path = edgePath(edge, rowTop, ROW_HEIGHT, LANE_PADDING, LANE_WIDTH, column);
      if (folded) {
        const key = path.kind === 'line' ? `${path.y0}:${path.y1}` : 'curve';
        if (path.kind === 'curve' || drawn.has(key)) continue;
        drawn.add(key);
        ctx.save();
        ctx.setLineDash([3, 3]);
        ctx.strokeStyle = theme.mutedForeground;
      } else {
        ctx.strokeStyle = laneColor(edgeColorLane(edge));
      }
      ctx.beginPath();
      if (path.kind === 'line') {
        ctx.moveTo(path.x, path.y0);
        ctx.lineTo(path.x, path.y1);
      } else {
        ctx.moveTo(path.x0, path.y0);
        ctx.bezierCurveTo(path.cp1x, path.cp1y, path.cp2x, path.cp2y, path.x1, path.y1);
      }
      ctx.stroke();
      if (folded) ctx.restore();
    }
  }

  private drawDot(
    ctx: CanvasRenderingContext2D,
    row: GraphRow,
    x: number,
    y: number,
    isHead: boolean,
    theme: ThemeColors,
  ): void {
    const color = laneColor(row.lane);
    ctx.save();
    ctx.lineWidth = 2;
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.beginPath();
    if (row.kind === 'stash') {
      const r = DOT_RADIUS + 1;
      ctx.moveTo(x, y - r);
      ctx.lineTo(x + r, y);
      ctx.lineTo(x, y + r);
      ctx.lineTo(x - r, y);
      ctx.closePath();
      ctx.fill();
    } else if (row.kind === 'wip') {
      ctx.fillStyle = theme.background;
      ctx.setLineDash([2, 2]);
      ctx.arc(x, y, DOT_RADIUS + 1, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    } else if (isHead) {
      // The checked-out commit: a hollow ring, as git graphs mark HEAD.
      ctx.fillStyle = theme.background;
      ctx.arc(x, y, DOT_RADIUS + 1, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    } else {
      ctx.arc(x, y, DOT_RADIUS, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  private drawText(
    ctx: CanvasRenderingContext2D,
    row: GraphRow,
    index: number,
    centerY: number,
    layout: ColumnLayout,
    theme: ThemeColors,
    selected: boolean,
    textFont: string,
    chipFont: string,
    monoFont: string,
    extras: { agentBadge: boolean } = { agentBadge: false },
  ): void {
    const strong =
      selected && theme.selectionForeground ? theme.selectionForeground : theme.foreground;
    const muted =
      selected && theme.selectionForeground ? theme.selectionForeground : theme.mutedForeground;
    ctx.textBaseline = 'middle';

    // Ref chips lead the description; the summary follows them.
    ctx.font = chipFont;
    let x = layout.descriptionX;
    const chipLimit = layout.descriptionX + layout.descriptionW * MAX_CHIP_SHARE;
    for (let r = 0; r < row.refs.length; r++) {
      const ref = row.refs[r];
      ctx.font = ref.kind === 'head' ? `bold ${chipFont}` : chipFont;
      const width = Math.ceil(ctx.measureText(ref.name).width) + CHIP_PAD_X * 2;
      if (x + width > chipLimit && r > 0) {
        const more = `+${row.refs.length - r}`;
        ctx.font = chipFont;
        ctx.fillStyle = muted;
        ctx.fillText(more, x, centerY);
        x += Math.ceil(ctx.measureText(more).width) + CHIP_GAP;
        break;
      }
      const drawnWidth = Math.min(width, Math.max(0, chipLimit - x));
      this.drawChip(ctx, ref, x, centerY, drawnWidth, theme, chipFont);
      this.chipBoxes.push({
        x,
        y: centerY - CHIP_HEIGHT / 2,
        width: drawnWidth,
        height: CHIP_HEIGHT,
        refName: ref.name,
        row: index,
        refIndex: r,
      });
      x += drawnWidth + CHIP_GAP;
    }
    if (row.refs.length > 0) x += CHIP_GAP;
    if (extras.agentBadge) x = this.drawAgentBadge(ctx, x, centerY, layout, theme, chipFont);

    ctx.font = textFont;
    ctx.fillStyle = row.kind === 'commit' ? strong : muted;
    const summaryEnd = layout.descriptionX + layout.descriptionW;
    fillClippedText(ctx, row.summary, x, centerY, summaryEnd - x);

    ctx.fillStyle = muted;
    if (layout.authorW > 0 && row.kind !== 'wip') {
      fillClippedText(ctx, row.author.name, layout.authorX, centerY, layout.authorW);
    }
    if (layout.shaW > 0 && row.kind !== 'wip') {
      ctx.font = monoFont;
      fillClippedText(ctx, shortSha(row.sha), layout.shaX, centerY, layout.shaW);
      ctx.font = textFont;
    }
    fillClippedText(ctx, rowDate(row), layout.dateX, centerY, layout.dateW);
  }

  /** The badge of a commit that declares an AI agent, drawn at `x` in front
   *  of its summary. Returns where the summary starts. */
  private drawAgentBadge(
    ctx: CanvasRenderingContext2D,
    x: number,
    centerY: number,
    layout: ColumnLayout,
    theme: ThemeColors,
    chipFont: string,
  ): number {
    ctx.font = chipFont;
    const width = Math.ceil(ctx.measureText(AGENT_BADGE).width) + CHIP_PAD_X * 2;
    if (x + width > layout.descriptionX + layout.descriptionW) return x;
    const key = `agent:${theme.chipAgent}:${theme.background}`;
    let color = this.chipColors.get(key);
    if (color === undefined) {
      color = readableOn(theme.chipAgent, theme.background);
      this.chipColors.set(key, color);
    }
    const top = centerY - CHIP_HEIGHT / 2;
    const alpha = ctx.globalAlpha;
    ctx.save();
    ctx.beginPath();
    roundedRect(ctx, x + 0.5, top + 0.5, width - 1, CHIP_HEIGHT - 1, CHIP_RADIUS);
    ctx.globalAlpha = alpha * 0.14;
    ctx.fillStyle = color;
    ctx.fill();
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.textBaseline = 'middle';
    ctx.fillText(AGENT_BADGE, x + CHIP_PAD_X, centerY + 0.5);
    ctx.restore();
    return x + width + CHIP_GAP;
  }

  private chipColor(kind: GraphRef['kind'], theme: ThemeColors): string {
    const base = chipBaseColor(kind, theme);
    const key = `${kind}:${base}:${theme.background}`;
    let color = this.chipColors.get(key);
    if (color === undefined) {
      color = readableOn(base, theme.background);
      this.chipColors.set(key, color);
    }
    return color;
  }

  private drawChip(
    ctx: CanvasRenderingContext2D,
    ref: GraphRef,
    x: number,
    centerY: number,
    width: number,
    theme: ThemeColors,
    chipFont: string,
  ): void {
    if (width <= CHIP_PAD_X) return;
    const top = centerY - CHIP_HEIGHT / 2;
    const color = this.chipColor(ref.kind, theme);
    // Relative to the row's own opacity, which the provenance filter lowers.
    const alpha = ctx.globalAlpha;
    ctx.save();
    ctx.beginPath();
    roundedRect(ctx, x + 0.5, top + 0.5, width - 1, CHIP_HEIGHT - 1, CHIP_RADIUS);
    ctx.globalAlpha = alpha * 0.14;
    ctx.fillStyle = color;
    ctx.fill();
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.clip();
    ctx.fillStyle = color;
    ctx.font = ref.kind === 'head' ? `bold ${chipFont}` : chipFont;
    ctx.textBaseline = 'middle';
    ctx.fillText(ref.name, x + CHIP_PAD_X, centerY + 0.5);
    ctx.restore();
  }

  /** Marks the overflow column: lanes past the cap are folded into it. */
  private drawOverflowMarker(
    ctx: CanvasRenderingContext2D,
    cap: LaneCap,
    scrollTop: number,
    theme: ThemeColors,
    chipFont: string,
  ): void {
    const x = laneX(cap.shown - 1, LANE_PADDING, LANE_WIDTH);
    const label = `+${cap.hidden}`;
    ctx.save();
    ctx.font = chipFont;
    const width = Math.ceil(ctx.measureText(label).width) + 8;
    const top = scrollTop + 2;
    ctx.fillStyle = theme.background;
    ctx.fillRect(x - width / 2, top, width, 14);
    ctx.fillStyle = theme.mutedForeground;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, x, top + 7);
    ctx.restore();
  }
}

function fillClippedText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  centerY: number,
  maxWidth: number,
): void {
  if (maxWidth <= 0 || !text) return;
  if (ctx.measureText(text).width <= maxWidth) {
    ctx.fillText(text, x, centerY);
    return;
  }
  // Ellipsize: binary search for the longest prefix that fits with '…'.
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (ctx.measureText(text.slice(0, mid) + '…').width <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  if (lo > 0) ctx.fillText(text.slice(0, lo) + '…', x, centerY);
}

function roundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}
