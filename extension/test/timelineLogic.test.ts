import { describe, expect, it } from 'vitest';
import {
  DAY_MS,
  HIT_SLOP_PX,
  MAX_AUTHOR_LANES,
  MAX_BUBBLE_RADIUS,
  MIN_BUBBLE_RADIUS,
  MIN_ZOOM_SPAN_MS,
  TimelineEntryLike,
  additionsFraction,
  assignAuthorLanes,
  bubbleRadius,
  chooseGranularity,
  generateTicks,
  hitTestBubbles,
  laneForEntry,
  mixBubbleColor,
  panDomain,
  parseColor,
  timeDomain,
  timeToX,
  xToTime,
  zoomDomain,
} from '../webviews-src/timeline/timelineLogic';

function entry(name: string, email: string, additions: number, deletions: number): TimelineEntryLike {
  return { author: { name, email }, additions, deletions };
}

describe('timeDomain', () => {
  it('falls back to a one-day window ending now when empty', () => {
    const now = Date.UTC(2024, 0, 15);
    expect(timeDomain([], now)).toEqual({ start: now - DAY_MS, end: now });
  });

  it('centers a one-day window on a single time', () => {
    const t = Date.UTC(2024, 0, 15, 12);
    expect(timeDomain([t], now())).toEqual({ start: t - DAY_MS / 2, end: t + DAY_MS / 2 });
  });

  it('pads a multi-entry domain by 3% of the span on both sides', () => {
    const a = Date.UTC(2024, 0, 1);
    const b = a + 100 * DAY_MS;
    const pad = (b - a) * 0.03;
    expect(timeDomain([b, a], now())).toEqual({ start: a - pad, end: b + pad });
  });

  function now(): number {
    return Date.UTC(2024, 5, 1);
  }
});

describe('time scale', () => {
  const scale = { domain: { start: 1000, end: 2000 }, rangeStart: 100, rangeEnd: 600 };

  it('maps domain endpoints to range endpoints', () => {
    expect(timeToX(scale, 1000)).toBe(100);
    expect(timeToX(scale, 2000)).toBe(600);
    expect(timeToX(scale, 1500)).toBe(350);
  });

  it('inverts x back to time', () => {
    expect(xToTime(scale, 350)).toBe(1500);
    expect(xToTime(scale, timeToX(scale, 1730))).toBeCloseTo(1730, 6);
  });

  it('degrades gracefully on an empty domain', () => {
    const flat = { domain: { start: 500, end: 500 }, rangeStart: 0, rangeEnd: 100 };
    expect(timeToX(flat, 500)).toBe(0);
  });
});

describe('chooseGranularity', () => {
  it('picks days for short spans with room', () => {
    expect(chooseGranularity(3 * DAY_MS, 800)).toBe('day');
  });

  it('escalates to weeks and months as the span grows', () => {
    expect(chooseGranularity(60 * DAY_MS, 800)).toBe('week');
    expect(chooseGranularity(300 * DAY_MS, 800)).toBe('month');
  });

  it('picks years for multi-year spans', () => {
    expect(chooseGranularity(4 * 365 * DAY_MS, 400)).toBe('year');
  });
});

describe('generateTicks', () => {
  it('emits UTC day boundaries strictly inside the domain', () => {
    const domain = { start: Date.UTC(2024, 0, 10, 12), end: Date.UTC(2024, 0, 13, 12) };
    const { granularity, ticks } = generateTicks(domain, 800);
    expect(granularity).toBe('day');
    expect(ticks.map((tick) => tick.time)).toEqual([
      Date.UTC(2024, 0, 11),
      Date.UTC(2024, 0, 12),
      Date.UTC(2024, 0, 13),
    ]);
    expect(ticks.map((tick) => tick.label)).toEqual(['Jan 11', 'Jan 12', 'Jan 13']);
  });

  it('emits month boundaries including a boundary-aligned start', () => {
    const domain = { start: Date.UTC(2024, 0, 1), end: Date.UTC(2024, 5, 1) };
    const { granularity, ticks } = generateTicks(domain, 500);
    expect(granularity).toBe('month');
    expect(ticks).toHaveLength(6);
    expect(ticks[0]).toEqual({ time: Date.UTC(2024, 0, 1), label: 'Jan 2024' });
    expect(ticks[5]).toEqual({ time: Date.UTC(2024, 5, 1), label: 'Jun 2024' });
  });

  it('emits year boundaries with year labels', () => {
    const domain = { start: Date.UTC(2020, 0, 1), end: Date.UTC(2024, 0, 1) };
    const { granularity, ticks } = generateTicks(domain, 400);
    expect(granularity).toBe('year');
    expect(ticks.map((tick) => tick.label)).toEqual(['2020', '2021', '2022', '2023', '2024']);
  });

  it('strides year ticks when the width cannot fit them all', () => {
    const domain = { start: Date.UTC(1990, 0, 1), end: Date.UTC(2024, 0, 1) };
    const { ticks } = generateTicks(domain, 300);
    expect(ticks.length).toBeLessThanOrEqual(Math.floor(300 / 70));
    expect(ticks.length).toBeGreaterThan(0);
  });

  it('returns no ticks for an empty or inverted domain', () => {
    expect(generateTicks({ start: 100, end: 100 }, 800).ticks).toEqual([]);
    expect(generateTicks({ start: 200, end: 100 }, 800).ticks).toEqual([]);
  });
});

describe('assignAuthorLanes', () => {
  it('orders lanes by total churn descending', () => {
    const entries = [
      entry('Alice', 'alice@x.dev', 5, 5),
      entry('Bob', 'bob@x.dev', 20, 10),
      entry('Alice', 'ALICE@x.dev', 2, 3),
    ];
    const { lanes, laneByAuthor } = assignAuthorLanes(entries);
    expect(lanes.map((lane) => lane.label)).toEqual(['Bob', 'Alice']);
    expect(lanes.map((lane) => lane.churn)).toEqual([30, 15]);
    expect(laneByAuthor.get('alice@x.dev')).toBe(1);
  });

  it('pools overflow authors into a trailing Others lane', () => {
    const entries = Array.from({ length: 10 }, (_, i) =>
      entry(`Author${i}`, `a${i}@x.dev`, 10 - i, 0),
    );
    const assignment = assignAuthorLanes(entries);
    expect(assignment.lanes).toHaveLength(MAX_AUTHOR_LANES + 1);
    const others = assignment.lanes[MAX_AUTHOR_LANES];
    expect(others.others).toBe(true);
    expect(others.label).toBe('Others');
    expect(others.churn).toBe(2 + 1); // the two lowest-churn authors
    expect(laneForEntry(assignment, entries[9])).toBe(MAX_AUTHOR_LANES);
    expect(laneForEntry(assignment, entries[0])).toBe(0);
  });

  it('does not create an Others lane when authors fit', () => {
    const entries = [entry('A', 'a@x.dev', 1, 0), entry('B', 'b@x.dev', 2, 0)];
    const { lanes } = assignAuthorLanes(entries);
    expect(lanes.every((lane) => !lane.others)).toBe(true);
  });
});

describe('bubbleRadius', () => {
  it('pins zero churn to the minimum and max churn to the maximum', () => {
    expect(bubbleRadius(0, 100)).toBe(MIN_BUBBLE_RADIUS);
    expect(bubbleRadius(100, 100)).toBe(MAX_BUBBLE_RADIUS);
    expect(bubbleRadius(5, 0)).toBe(MIN_BUBBLE_RADIUS);
  });

  it('scales with the square root of churn', () => {
    // sqrt(25)/sqrt(100) = 0.5 -> midway between the bounds.
    expect(bubbleRadius(25, 100)).toBe(
      MIN_BUBBLE_RADIUS + 0.5 * (MAX_BUBBLE_RADIUS - MIN_BUBBLE_RADIUS),
    );
  });

  it('never exceeds the maximum even for out-of-range churn', () => {
    expect(bubbleRadius(400, 100)).toBe(MAX_BUBBLE_RADIUS);
  });
});

describe('bubble color mix', () => {
  const green = { r: 0, g: 255, b: 0 };
  const red = { r: 255, g: 0, b: 0 };

  it('is pure green for additions only and pure red for deletions only', () => {
    expect(mixBubbleColor(10, 0, green, red)).toBe('rgb(0, 255, 0)');
    expect(mixBubbleColor(0, 10, green, red)).toBe('rgb(255, 0, 0)');
  });

  it('is the midpoint for balanced churn and for empty commits', () => {
    expect(additionsFraction(5, 5)).toBe(0.5);
    expect(additionsFraction(0, 0)).toBe(0.5);
    expect(mixBubbleColor(5, 5, green, red)).toBe('rgb(128, 128, 0)');
  });

  it('leans toward green as additions dominate', () => {
    expect(additionsFraction(3, 1)).toBe(0.75);
    expect(mixBubbleColor(3, 1, green, red)).toBe('rgb(64, 191, 0)');
  });

  it('parses hex colors with a fallback for junk', () => {
    expect(parseColor('#89d185', red)).toEqual({ r: 137, g: 209, b: 133 });
    expect(parseColor('#f00', green)).toEqual({ r: 255, g: 0, b: 0 });
    expect(parseColor('var(--nope)', green)).toEqual(green);
  });
});

describe('hitTestBubbles', () => {
  const bubbles = [
    { x: 10, y: 10, r: 5 },
    { x: 30, y: 10, r: 5 },
  ];

  it('hits a bubble within radius plus slop', () => {
    expect(hitTestBubbles(bubbles, 16, 10)).toBe(0);
    expect(hitTestBubbles(bubbles, 10 + 5 + HIT_SLOP_PX, 10)).toBe(0);
  });

  it('misses outside the slop threshold', () => {
    expect(hitTestBubbles(bubbles, 20, 10)).toBeUndefined();
    expect(hitTestBubbles(bubbles, 10, 40)).toBeUndefined();
    expect(hitTestBubbles([], 0, 0)).toBeUndefined();
  });

  it('prefers the nearest of overlapping bubbles', () => {
    const overlapping = [
      { x: 0, y: 0, r: 10 },
      { x: 5, y: 0, r: 10 },
    ];
    expect(hitTestBubbles(overlapping, 4, 0)).toBe(1);
    expect(hitTestBubbles(overlapping, 1, 0)).toBe(0);
  });
});

describe('zoomDomain', () => {
  it('rescales around the anchor, keeping its relative position', () => {
    const domain = { start: 0, end: 10 * DAY_MS };
    const anchor = 2 * DAY_MS;
    const zoomed = zoomDomain(domain, anchor, 0.5);
    expect(zoomed.start).toBeCloseTo(1 * DAY_MS, 6);
    expect(zoomed.end).toBeCloseTo(6 * DAY_MS, 6);
    // Anchor stays at 20% of the span.
    expect((anchor - zoomed.start) / (zoomed.end - zoomed.start)).toBeCloseTo(0.2, 9);
  });

  it('clamps the span to the one-day minimum around the anchor', () => {
    const domain = { start: 0, end: 2 * DAY_MS };
    const zoomed = zoomDomain(domain, DAY_MS, 0.1);
    expect(zoomed.end - zoomed.start).toBe(MIN_ZOOM_SPAN_MS);
    expect(zoomed.start).toBeCloseTo(DAY_MS / 2, 6);
    expect(zoomed.end).toBeCloseTo(1.5 * DAY_MS, 6);
  });

  it('zooms out without clamping', () => {
    const domain = { start: 0, end: 2 * DAY_MS };
    const zoomed = zoomDomain(domain, 0, 2);
    expect(zoomed).toEqual({ start: 0, end: 4 * DAY_MS });
  });

  it('clamps an out-of-domain anchor to the domain edge', () => {
    const domain = { start: 0, end: 10 * DAY_MS };
    const zoomed = zoomDomain(domain, -5 * DAY_MS, 0.5);
    expect(zoomed.start).toBe(0);
    expect(zoomed.end).toBe(5 * DAY_MS);
  });
});

describe('panDomain', () => {
  it('shifts both edges by the delta', () => {
    expect(panDomain({ start: 100, end: 200 }, 50)).toEqual({ start: 150, end: 250 });
    expect(panDomain({ start: 100, end: 200 }, -25)).toEqual({ start: 75, end: 175 });
  });
});
