import { beforeAll, describe, expect, it } from 'vitest';
import type { GraphRow } from '@gitglasses/protocol';
import { emptySelection, laneX } from '../webviews-src/graph/graphLogic';
import {
  GraphRenderer,
  LANE_PADDING,
  LANE_WIDTH,
  ROW_HEIGHT,
  RenderState,
  readThemeColors,
} from '../webviews-src/graph/renderer';

interface Segment {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** A 2D context that records the segments it strokes and the text it fills. */
function recordingCanvas(): { canvas: HTMLCanvasElement; segments: Segment[]; texts: string[] } {
  const segments: Segment[] = [];
  const texts: string[] = [];
  let path: Segment[] = [];
  let at = { x: 0, y: 0 };
  let translateY = 0;
  const ctx = {
    set fillStyle(_: string) {},
    set strokeStyle(_: string) {},
    set lineWidth(_: number) {},
    set font(_: string) {},
    set textBaseline(_: string) {},
    set textAlign(_: string) {},
    set globalAlpha(_: number) {},
    setTransform: () => {
      translateY = 0;
    },
    translate: (_x: number, y: number) => {
      translateY += y;
    },
    clearRect: () => {},
    fillRect: () => {},
    strokeRect: () => {},
    save: () => {},
    restore: () => {},
    clip: () => {},
    rect: () => {},
    setLineDash: () => {},
    arc: () => {},
    arcTo: () => {},
    closePath: () => {},
    fill: () => {},
    beginPath: () => {
      path = [];
    },
    moveTo: (x: number, y: number) => {
      at = { x, y: y + translateY };
    },
    lineTo: (x: number, y: number) => {
      path.push({ x0: at.x, y0: at.y, x1: x, y1: y + translateY });
      at = { x, y: y + translateY };
    },
    bezierCurveTo: (_a: number, _b: number, _c: number, _d: number, x: number, y: number) => {
      path.push({ x0: at.x, y0: at.y, x1: x, y1: y + translateY });
      at = { x, y: y + translateY };
    },
    stroke: () => {
      segments.push(...path);
    },
    fillText: (text: string) => {
      texts.push(text);
    },
    measureText: (text: string) => ({ width: text.length * 7 }),
  };
  const canvas = {
    width: 0,
    height: 0,
    style: {} as Record<string, string>,
    getContext: () => ctx,
  } as unknown as HTMLCanvasElement;
  return { canvas, segments, texts };
}

function row(sha: string, overrides: Partial<GraphRow> = {}): GraphRow {
  return {
    sha,
    parents: [],
    lane: 0,
    laneEdges: [],
    author: { name: 'Ada', email: 'ada@example.invalid', time: 1_700_000_000 },
    time: 1_700_000_000,
    summary: `commit ${sha}`,
    refs: [],
    kind: 'commit',
    ...overrides,
  };
}

function state(rows: GraphRow[], overrides: Partial<RenderState> = {}): RenderState {
  return {
    rows,
    maxLane: 0,
    maxLanes: 20,
    selection: emptySelection(),
    scrollTop: 0,
    viewportW: 1000,
    viewportH: 400,
    theme: readThemeColors({ getPropertyValue: () => '' }),
    hoverIndex: -1,
    focused: false,
    matches: new Set(),
    currentMatch: undefined,
    headSha: undefined,
    ...overrides,
  };
}

/** Whether vertical strokes at x cover [from, to] without a gap. */
function covered(segments: Segment[], x: number, from: number, to: number): boolean {
  const spans = segments
    .filter((s) => s.x0 === x && s.x1 === x)
    .map((s) => [Math.min(s.y0, s.y1), Math.max(s.y0, s.y1)])
    .sort((a, b) => a[0] - b[0]);
  let reach = from;
  for (const [start, end] of spans) {
    if (start > reach) break;
    reach = Math.max(reach, end);
  }
  return reach >= to;
}

beforeAll(() => {
  (globalThis as { window?: unknown }).window = { devicePixelRatio: 1 };
});

describe('GraphRenderer', () => {
  it('draws the line between consecutive commits on the same lane', () => {
    const { canvas, segments } = recordingCanvas();
    // c2 -> c1 -> c0, as the engine lays out a linear history.
    const rows = [
      row('c2', { laneEdges: [{ fromLane: 0, toLane: 0, kind: 'lineOut' }] }),
      row('c1', {
        laneEdges: [
          { fromLane: 0, toLane: 0, kind: 'lineIn' },
          { fromLane: 0, toLane: 0, kind: 'lineOut' },
        ],
      }),
      row('c0', { laneEdges: [{ fromLane: 0, toLane: 0, kind: 'lineIn' }] }),
    ];
    new GraphRenderer(canvas).render(state(rows));
    const x = laneX(0, LANE_PADDING, LANE_WIDTH);
    const firstDot = ROW_HEIGHT / 2;
    const lastDot = 2 * ROW_HEIGHT + ROW_HEIGHT / 2;
    expect(covered(segments, x, firstDot, lastDot)).toBe(true);
    // Nothing above the first dot or below the last one.
    expect(covered(segments, x, 0, firstDot)).toBe(false);
    expect(segments.every((s) => Math.max(s.y0, s.y1) <= lastDot)).toBe(true);
  });

  it('shows no date for the uncommitted-changes row', () => {
    const { canvas, texts } = recordingCanvas();
    const wip = row('0'.repeat(40), {
      kind: 'wip',
      summary: 'Uncommitted changes',
      author: { name: '', email: '', time: 0 },
      time: 0,
    });
    new GraphRenderer(canvas).render(state([wip]));
    expect(texts).toContain('Uncommitted changes');
    expect(texts.some((text) => text.includes('years ago'))).toBe(false);
  });

  it('folds lanes past the cap into one column and says how many', () => {
    const { canvas, segments, texts } = recordingCanvas();
    const wide = row('w', {
      lane: 40,
      laneEdges: Array.from({ length: 41 }, (_, lane) => ({
        fromLane: lane,
        toLane: lane,
        kind: lane === 40 ? ('lineOut' as const) : ('line' as const),
      })),
    });
    const renderer = new GraphRenderer(canvas);
    renderer.render(state([wide], { maxLane: 40, maxLanes: 8 }));
    const lastColumn = laneX(7, LANE_PADDING, LANE_WIDTH);
    expect(Math.max(...segments.map((s) => Math.max(s.x0, s.x1)))).toBe(lastColumn);
    expect(texts).toContain('+34');
    expect(renderer.layout?.cap).toEqual({ shown: 8, overflow: true, hidden: 34 });
  });
});
