// Canvas painter for the file history timeline: author lanes with labels on
// the left, a time axis along the bottom, and one churn-sized bubble per
// commit. Draws DPR-aware onto a viewport-sized canvas.

import type { FileHistoryEntry } from './ipc';
import {
  LaneAssignment,
  Rgb,
  TimeDomain,
  TimeScale,
  bubbleRadius,
  generateTicks,
  laneForEntry,
  mixBubbleColor,
  parseColor,
  timeToX,
} from './timelineLogic';

export const LANE_LABEL_WIDTH = 120;
export const AXIS_HEIGHT = 28;
export const TOP_MARGIN = 10;
export const RIGHT_MARGIN = 12;

const FALLBACK_GREEN: Rgb = { r: 137, g: 209, b: 133 }; // #89d185
const FALLBACK_RED: Rgb = { r: 241, g: 76, b: 76 }; // #f14c4c

export interface ThemeColors {
  foreground: string;
  mutedForeground: string;
  grid: string;
  addColor: Rgb;
  deleteColor: Rgb;
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
    grid: read('--vscode-editorRuler-foreground', '#5a5a5a'),
    addColor: parseColor(read('--vscode-charts-green', '#89d185'), FALLBACK_GREEN),
    deleteColor: parseColor(read('--vscode-charts-red', '#f14c4c'), FALLBACK_RED),
    fontFamily: read('--vscode-font-family', 'sans-serif'),
    fontSize: read('--vscode-font-size', '13px'),
  };
}

/** A drawn bubble in CSS pixels, kept for hover/click hit-testing. */
export interface BubblePoint {
  x: number;
  y: number;
  r: number;
  entryIndex: number;
}

export interface TimelineRenderState {
  entries: readonly FileHistoryEntry[];
  assignment: LaneAssignment;
  domain: TimeDomain;
  hoverIndex?: number;
  viewportW: number;
  viewportH: number;
  theme: ThemeColors;
}

export function plotScale(domain: TimeDomain, viewportW: number): TimeScale {
  return {
    domain,
    rangeStart: LANE_LABEL_WIDTH,
    rangeEnd: Math.max(LANE_LABEL_WIDTH + 1, viewportW - RIGHT_MARGIN),
  };
}

export class TimelineRenderer {
  /** Bubbles from the last paint, in CSS-pixel viewport coordinates. */
  bubbles: BubblePoint[] = [];

  constructor(private readonly canvas: HTMLCanvasElement) {}

  render(state: TimelineRenderState): void {
    const { entries, assignment, domain, hoverIndex, viewportW, viewportH, theme } = state;
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
    this.bubbles = [];

    const scale = plotScale(domain, viewportW);
    const plotLeft = scale.rangeStart;
    const plotRight = scale.rangeEnd;
    const plotTop = TOP_MARGIN;
    const plotBottom = Math.max(plotTop + 1, viewportH - AXIS_HEIGHT);
    const laneCount = Math.max(1, assignment.lanes.length);
    const laneHeight = (plotBottom - plotTop) / laneCount;
    const textFont = `${theme.fontSize} ${theme.fontFamily}`;

    // Lane separators and author labels.
    ctx.font = textFont;
    ctx.textBaseline = 'middle';
    for (let i = 0; i < assignment.lanes.length; i++) {
      const laneTop = plotTop + i * laneHeight;
      const centerY = laneTop + laneHeight / 2;
      ctx.strokeStyle = theme.grid;
      ctx.globalAlpha = 0.25;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(plotLeft, laneTop);
      ctx.lineTo(plotRight, laneTop);
      ctx.stroke();
      ctx.globalAlpha = 1;

      ctx.fillStyle = assignment.lanes[i].others ? theme.mutedForeground : theme.foreground;
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, laneTop, LANE_LABEL_WIDTH - 8, laneHeight);
      ctx.clip();
      ctx.fillText(assignment.lanes[i].label, 8, centerY);
      ctx.restore();
    }

    // Time axis: baseline, tick gridlines, tick labels.
    ctx.strokeStyle = theme.grid;
    ctx.globalAlpha = 0.6;
    ctx.beginPath();
    ctx.moveTo(plotLeft, plotBottom);
    ctx.lineTo(plotRight, plotBottom);
    ctx.stroke();
    ctx.globalAlpha = 1;

    const { ticks } = generateTicks(domain, plotRight - plotLeft);
    ctx.fillStyle = theme.mutedForeground;
    ctx.textBaseline = 'top';
    ctx.textAlign = 'center';
    for (const tick of ticks) {
      const x = timeToX(scale, tick.time);
      if (x < plotLeft || x > plotRight) continue;
      ctx.strokeStyle = theme.grid;
      ctx.globalAlpha = 0.15;
      ctx.beginPath();
      ctx.moveTo(x, plotTop);
      ctx.lineTo(x, plotBottom);
      ctx.stroke();
      ctx.globalAlpha = 0.6;
      ctx.beginPath();
      ctx.moveTo(x, plotBottom);
      ctx.lineTo(x, plotBottom + 4);
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.fillText(tick.label, x, plotBottom + 7);
    }
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';

    // Bubbles, oldest painted last so newer commits sit on top of overlaps.
    let maxChurn = 0;
    for (const entry of entries) {
      maxChurn = Math.max(maxChurn, entry.additions + entry.deletions);
    }
    ctx.save();
    ctx.beginPath();
    ctx.rect(plotLeft, plotTop, plotRight - plotLeft, plotBottom - plotTop);
    ctx.clip();
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      const x = timeToX(scale, entry.author.time * 1000);
      const r = bubbleRadius(entry.additions + entry.deletions, maxChurn);
      if (x < plotLeft - r || x > plotRight + r) continue;
      const lane = laneForEntry(assignment, entry);
      const y = plotTop + (lane + 0.5) * laneHeight;
      ctx.fillStyle = mixBubbleColor(entry.additions, entry.deletions, theme.addColor, theme.deleteColor);
      ctx.globalAlpha = 0.85;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
      this.bubbles.push({ x, y, r, entryIndex: i });
    }
    if (hoverIndex !== undefined) {
      const hovered = this.bubbles.find((bubble) => bubble.entryIndex === hoverIndex);
      if (hovered) {
        ctx.strokeStyle = theme.foreground;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(hovered.x, hovered.y, hovered.r + 2, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    ctx.restore();
  }
}
