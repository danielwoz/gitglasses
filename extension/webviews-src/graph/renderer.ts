// Canvas painter for the commit graph. Draws only the visible row window
// onto a viewport-sized canvas, translated by the scroll offset.

import type { GraphRef, GraphRow } from './ipc';
import {
  ChipBox,
  SelectionState,
  edgePath,
  graphColumnWidth,
  laneColor,
  laneX,
  visibleRange,
} from './graphLogic';

export const ROW_HEIGHT = 26;
export const LANE_WIDTH = 14;
export const LANE_PADDING = 12;
export const OVERSCAN_ROWS = 6;

const DOT_RADIUS = 4;
const CHIP_HEIGHT = 16;
const CHIP_PAD_X = 6;
const CHIP_GAP = 4;
const CHIP_RADIUS = 4;
const COLUMN_GAP = 10;
const AUTHOR_WIDTH = 140;
const DATE_WIDTH = 96;

export interface ThemeColors {
  foreground: string;
  mutedForeground: string;
  selectionBackground: string;
  chipBranch: string;
  chipRemote: string;
  chipTag: string;
  chipStash: string;
  chipHead: string;
  fontFamily: string;
  fontSize: string;
}

/** Resolves theme colors from VS Code CSS custom properties, with fallbacks
 *  for environments where the variables are absent. */
export function readThemeColors(style: { getPropertyValue(name: string): string }): ThemeColors {
  const read = (name: string, fallback: string): string =>
    style.getPropertyValue(name).trim() || fallback;
  return {
    foreground: read('--vscode-foreground', '#cccccc'),
    mutedForeground: read('--vscode-descriptionForeground', '#8b8b8b'),
    selectionBackground: read('--vscode-list-activeSelectionBackground', '#04395e'),
    chipBranch: read('--vscode-charts-blue', '#3794ff'),
    chipRemote: read('--vscode-charts-purple', '#b180d7'),
    chipTag: read('--vscode-charts-orange', '#d18616'),
    chipStash: read('--vscode-charts-lines', '#8b8b8b'),
    chipHead: read('--vscode-charts-green', '#89d185'),
    fontFamily: read('--vscode-font-family', 'sans-serif'),
    fontSize: read('--vscode-font-size', '13px'),
  };
}

function chipColor(kind: GraphRef['kind'], theme: ThemeColors): string {
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

/** Human "N units ago" for unix seconds (duplicated from the host side so
 *  the browser bundle has no extension imports). */
export function relativeTime(unixSeconds: number, nowUnixSeconds: number = Date.now() / 1000): string {
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

export interface RenderState {
  rows: readonly GraphRow[];
  selection: SelectionState;
  scrollTop: number;
  viewportW: number;
  viewportH: number;
  theme: ThemeColors;
}

export class GraphRenderer {
  /** Measured chip boxes from the last paint, in content coordinates,
   *  for hit-testing right-side ref chips. */
  chipBoxes: ChipBox[] = [];

  constructor(private readonly canvas: HTMLCanvasElement) {}

  render(state: RenderState): void {
    const { rows, selection, scrollTop, viewportW, viewportH, theme } = state;
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
    ctx.translate(0, -scrollTop);
    this.chipBoxes = [];

    const range = visibleRange(scrollTop, viewportH, ROW_HEIGHT, rows.length, OVERSCAN_ROWS);

    let maxLane = 0;
    for (const row of rows) {
      maxLane = Math.max(maxLane, row.lane);
      for (const edge of row.laneEdges) {
        maxLane = Math.max(maxLane, edge.fromLane, edge.toLane);
      }
    }
    const graphW = graphColumnWidth(maxLane + 1, LANE_PADDING, LANE_WIDTH);
    const dateX = viewportW - DATE_WIDTH;
    const authorX = dateX - COLUMN_GAP - AUTHOR_WIDTH;
    const textFont = `${theme.fontSize} ${theme.fontFamily}`;
    const chipFont = `${parseInt(theme.fontSize, 10) - 2 || 11}px ${theme.fontFamily}`;

    for (let i = range.start; i < range.end; i++) {
      const row = rows[i];
      const rowTop = i * ROW_HEIGHT;
      const centerY = rowTop + ROW_HEIGHT / 2;

      if (selection.selected.has(row.sha)) {
        ctx.fillStyle = theme.selectionBackground;
        ctx.fillRect(0, rowTop, viewportW, ROW_HEIGHT);
      }

      // Edges beneath the dot.
      for (const edge of row.laneEdges) {
        const path = edgePath(edge, rowTop, ROW_HEIGHT, LANE_PADDING, LANE_WIDTH);
        ctx.strokeStyle = laneColor(edge.kind === 'branchOut' ? edge.toLane : edge.fromLane);
        ctx.lineWidth = 2;
        ctx.beginPath();
        if (path.kind === 'line') {
          ctx.moveTo(path.x, path.y0);
          ctx.lineTo(path.x, path.y1);
        } else {
          ctx.moveTo(path.x0, path.y0);
          ctx.bezierCurveTo(path.cp1x, path.cp1y, path.cp2x, path.cp2y, path.x1, path.y1);
        }
        ctx.stroke();
      }

      this.drawDot(ctx, row, laneX(row.lane, LANE_PADDING, LANE_WIDTH), centerY);

      // Right-anchored columns: relative date, then author.
      ctx.font = textFont;
      ctx.textBaseline = 'middle';
      ctx.fillStyle = theme.mutedForeground;
      fillClippedText(ctx, relativeTime(row.time), dateX, centerY, DATE_WIDTH - 4);
      fillClippedText(ctx, row.author.name, authorX, centerY, AUTHOR_WIDTH);

      // Ref chips sit right-anchored against the author column; the summary
      // fills the remaining space between the graph and the chips.
      ctx.font = chipFont;
      const chipWidths = row.refs.map(
        (ref) => Math.ceil(ctx.measureText(ref.name).width) + CHIP_PAD_X * 2,
      );
      const chipsTotal =
        chipWidths.reduce((sum, w) => sum + w, 0) + Math.max(0, row.refs.length - 1) * CHIP_GAP;
      let chipX = authorX - COLUMN_GAP - chipsTotal;
      const chipsStart = row.refs.length > 0 ? chipX : authorX;
      for (let r = 0; r < row.refs.length; r++) {
        this.drawChip(ctx, row.refs[r], chipX, centerY, chipWidths[r], theme, chipFont);
        this.chipBoxes.push({
          x: chipX,
          y: centerY - CHIP_HEIGHT / 2,
          width: chipWidths[r],
          height: CHIP_HEIGHT,
          refName: row.refs[r].name,
        });
        chipX += chipWidths[r] + CHIP_GAP;
      }

      ctx.font = textFont;
      ctx.fillStyle = theme.foreground;
      const summaryX = graphW + COLUMN_GAP;
      fillClippedText(ctx, row.summary, summaryX, centerY, chipsStart - COLUMN_GAP - summaryX);
    }

    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  private drawDot(ctx: CanvasRenderingContext2D, row: GraphRow, x: number, y: number): void {
    const color = laneColor(row.lane);
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
      ctx.arc(x, y, DOT_RADIUS, 0, Math.PI * 2);
      ctx.stroke();
    } else {
      ctx.arc(x, y, DOT_RADIUS, 0, Math.PI * 2);
      ctx.fill();
    }
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
    const top = centerY - CHIP_HEIGHT / 2;
    ctx.beginPath();
    roundedRect(ctx, x, top, width, CHIP_HEIGHT, CHIP_RADIUS);
    ctx.strokeStyle = chipColor(ref.kind, theme);
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = chipColor(ref.kind, theme);
    ctx.font = ref.kind === 'head' ? `bold ${chipFont}` : chipFont;
    ctx.textBaseline = 'middle';
    ctx.fillText(ref.name, x + CHIP_PAD_X, centerY);
    ctx.font = chipFont;
  }
}

function fillClippedText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  centerY: number,
  maxWidth: number,
): void {
  if (maxWidth <= 0) return;
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, centerY - ROW_HEIGHT / 2, maxWidth, ROW_HEIGHT);
  ctx.clip();
  ctx.fillText(text, x, centerY);
  ctx.restore();
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
