// Pure chart math for the visual file history timeline: time scale and tick
// generation, author lane assignment, bubble sizing and coloring, hit
// testing, and zoom/pan domain arithmetic. No DOM or vscode imports so the
// unit tests run without a browser.

export const DAY_MS = 24 * 60 * 60 * 1000;
/** Zooming in stops once the visible domain covers a single day. */
export const MIN_ZOOM_SPAN_MS = DAY_MS;
export const MIN_BUBBLE_RADIUS = 3;
export const MAX_BUBBLE_RADIUS = 18;
export const MAX_AUTHOR_LANES = 8;
/** Extra pixels around a bubble that still count as hovering it. */
export const HIT_SLOP_PX = 4;
/** Minimum horizontal room per axis tick label. */
export const MIN_TICK_SPACING_PX = 70;

/** Minimal entry shape the chart math needs (subset of FileHistoryEntry). */
export interface TimelineEntryLike {
  author: { name: string; email: string };
  additions: number;
  deletions: number;
}

// --- Time domain and scale --------------------------------------------------

/** Visible time window, epoch milliseconds. */
export interface TimeDomain {
  start: number;
  end: number;
}

/** Domain covering all entry times with a little padding; a one-day window
 *  ending now when there are no entries, a one-day window centered on the
 *  single time when all times coincide. */
export function timeDomain(timesMs: readonly number[], nowMs: number): TimeDomain {
  if (timesMs.length === 0) return { start: nowMs - DAY_MS, end: nowMs };
  let min = Infinity;
  let max = -Infinity;
  for (const time of timesMs) {
    if (time < min) min = time;
    if (time > max) max = time;
  }
  if (min === max) return { start: min - DAY_MS / 2, end: min + DAY_MS / 2 };
  const pad = (max - min) * 0.03;
  return { start: min - pad, end: max + pad };
}

export interface TimeScale {
  domain: TimeDomain;
  rangeStart: number;
  rangeEnd: number;
}

export function timeToX(scale: TimeScale, timeMs: number): number {
  const span = scale.domain.end - scale.domain.start;
  if (span <= 0) return scale.rangeStart;
  return scale.rangeStart + ((timeMs - scale.domain.start) / span) * (scale.rangeEnd - scale.rangeStart);
}

export function xToTime(scale: TimeScale, x: number): number {
  const range = scale.rangeEnd - scale.rangeStart;
  if (range <= 0) return scale.domain.start;
  return scale.domain.start + ((x - scale.rangeStart) / range) * (scale.domain.end - scale.domain.start);
}

// --- Axis ticks -------------------------------------------------------------

export type TickGranularity = 'day' | 'week' | 'month' | 'year';

const GRANULARITIES: readonly TickGranularity[] = ['day', 'week', 'month', 'year'];

const APPROX_SPAN_MS: Record<TickGranularity, number> = {
  day: DAY_MS,
  week: 7 * DAY_MS,
  month: 30.44 * DAY_MS,
  year: 365.25 * DAY_MS,
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Coarsest-fitting granularity: the finest unit whose tick count fits the
 *  available width at MIN_TICK_SPACING_PX per label. */
export function chooseGranularity(spanMs: number, widthPx: number): TickGranularity {
  const maxTicks = Math.max(1, Math.floor(widthPx / MIN_TICK_SPACING_PX));
  for (const granularity of GRANULARITIES) {
    if (spanMs / APPROX_SPAN_MS[granularity] <= maxTicks) return granularity;
  }
  return 'year';
}

export interface TimeTick {
  /** Tick position, epoch ms, aligned to a UTC unit boundary. */
  time: number;
  label: string;
}

export function formatTickLabel(timeMs: number, granularity: TickGranularity): string {
  const date = new Date(timeMs);
  switch (granularity) {
    case 'year':
      return String(date.getUTCFullYear());
    case 'month':
      return `${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
    case 'week':
    case 'day':
      return `${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}`;
  }
}

function floorToBoundary(timeMs: number, granularity: TickGranularity): number {
  const date = new Date(timeMs);
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  const day = date.getUTCDate();
  switch (granularity) {
    case 'day':
      return Date.UTC(year, month, day);
    case 'week': {
      const sinceMonday = (date.getUTCDay() + 6) % 7;
      return Date.UTC(year, month, day - sinceMonday);
    }
    case 'month':
      return Date.UTC(year, month, 1);
    case 'year':
      return Date.UTC(year, 0, 1);
  }
}

function advanceBoundary(timeMs: number, granularity: TickGranularity, stride: number): number {
  const date = new Date(timeMs);
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  const day = date.getUTCDate();
  switch (granularity) {
    case 'day':
      return Date.UTC(year, month, day + stride);
    case 'week':
      return Date.UTC(year, month, day + 7 * stride);
    case 'month':
      return Date.UTC(year, month + stride, 1);
    case 'year':
      return Date.UTC(year + stride, 0, 1);
  }
}

/** UTC-boundary-aligned ticks covering the domain, thinned by an integer
 *  stride when even the coarsest unit would overcrowd the axis. */
export function generateTicks(
  domain: TimeDomain,
  widthPx: number,
): { granularity: TickGranularity; ticks: TimeTick[] } {
  const spanMs = domain.end - domain.start;
  if (spanMs <= 0 || widthPx <= 0) return { granularity: 'day', ticks: [] };
  const granularity = chooseGranularity(spanMs, widthPx);
  const maxTicks = Math.max(1, Math.floor(widthPx / MIN_TICK_SPACING_PX));
  const approxCount = Math.ceil(spanMs / APPROX_SPAN_MS[granularity]);
  const stride = Math.max(1, Math.ceil(approxCount / maxTicks));

  const ticks: TimeTick[] = [];
  let cursor = floorToBoundary(domain.start, granularity);
  if (cursor < domain.start) cursor = advanceBoundary(cursor, granularity, stride);
  let guard = 0;
  while (cursor <= domain.end && guard++ < 1000) {
    ticks.push({ time: cursor, label: formatTickLabel(cursor, granularity) });
    cursor = advanceBoundary(cursor, granularity, stride);
  }
  return { granularity, ticks };
}

// --- Author lanes -----------------------------------------------------------

export interface AuthorLane {
  label: string;
  /** Total additions+deletions across the lane's commits. */
  churn: number;
  /** True for the overflow lane that pools low-churn authors. */
  others: boolean;
}

export interface LaneAssignment {
  /** Lanes top to bottom: most-active author first, 'Others' last if present. */
  lanes: AuthorLane[];
  /** Author key -> lane index; overflow authors map to the 'Others' lane. */
  laneByAuthor: Map<string, number>;
}

/** Authors are identified by email (case-insensitive), name as a fallback. */
export function authorKey(author: { name: string; email: string }): string {
  const email = author.email.trim().toLowerCase();
  return email !== '' ? email : author.name.trim().toLowerCase();
}

/** One lane per author ordered by total churn descending (name as the tie
 *  break); authors beyond `maxLanes` share a trailing 'Others' lane. The
 *  display name comes from the author's first (newest) entry. */
export function assignAuthorLanes(
  entries: readonly TimelineEntryLike[],
  maxLanes: number = MAX_AUTHOR_LANES,
): LaneAssignment {
  const totals = new Map<string, { name: string; churn: number }>();
  for (const entry of entries) {
    const key = authorKey(entry.author);
    const churn = entry.additions + entry.deletions;
    const existing = totals.get(key);
    if (existing) existing.churn += churn;
    else totals.set(key, { name: entry.author.name, churn });
  }
  const sorted = [...totals.entries()].sort(
    (a, b) => b[1].churn - a[1].churn || a[1].name.localeCompare(b[1].name),
  );

  const lanes: AuthorLane[] = [];
  const laneByAuthor = new Map<string, number>();
  const overflow = sorted.length > maxLanes;
  const named = overflow ? sorted.slice(0, maxLanes) : sorted;
  for (const [key, total] of named) {
    laneByAuthor.set(key, lanes.length);
    lanes.push({ label: total.name, churn: total.churn, others: false });
  }
  if (overflow) {
    const othersIndex = lanes.length;
    let othersChurn = 0;
    for (const [key, total] of sorted.slice(maxLanes)) {
      laneByAuthor.set(key, othersIndex);
      othersChurn += total.churn;
    }
    lanes.push({ label: 'Others', churn: othersChurn, others: true });
  }
  return { lanes, laneByAuthor };
}

export function laneForEntry(assignment: LaneAssignment, entry: TimelineEntryLike): number {
  return assignment.laneByAuthor.get(authorKey(entry.author)) ?? Math.max(0, assignment.lanes.length - 1);
}

// --- Bubble radius ----------------------------------------------------------

/** Square-root scale from churn to radius, so bubble *area* tracks churn:
 *  zero churn pins to the minimum, the largest churn to the maximum. */
export function bubbleRadius(churn: number, maxChurn: number): number {
  if (churn <= 0 || maxChurn <= 0) return MIN_BUBBLE_RADIUS;
  const fraction = Math.min(1, Math.sqrt(churn) / Math.sqrt(maxChurn));
  return MIN_BUBBLE_RADIUS + fraction * (MAX_BUBBLE_RADIUS - MIN_BUBBLE_RADIUS);
}

// --- Bubble color -----------------------------------------------------------

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** Parses #rgb / #rrggbb; anything else yields the fallback. */
export function parseColor(color: string, fallback: Rgb): Rgb {
  const hex = color.trim().replace(/^#/, '');
  if (/^[0-9a-fA-F]{3}$/.test(hex)) {
    return {
      r: parseInt(hex[0] + hex[0], 16),
      g: parseInt(hex[1] + hex[1], 16),
      b: parseInt(hex[2] + hex[2], 16),
    };
  }
  if (/^[0-9a-fA-F]{6}$/.test(hex)) {
    return {
      r: parseInt(hex.slice(0, 2), 16),
      g: parseInt(hex.slice(2, 4), 16),
      b: parseInt(hex.slice(4, 6), 16),
    };
  }
  return fallback;
}

/** Share of the commit's churn that is additions; 0.5 when there is none. */
export function additionsFraction(additions: number, deletions: number): number {
  const total = additions + deletions;
  return total <= 0 ? 0.5 : additions / total;
}

/** Linear mix from the deletion color (all deletions) to the addition color
 *  (all additions), as a canvas-ready rgb() string. */
export function mixBubbleColor(
  additions: number,
  deletions: number,
  addColor: Rgb,
  deleteColor: Rgb,
): string {
  const fraction = additionsFraction(additions, deletions);
  const channel = (from: number, to: number): number => Math.round(from + (to - from) * fraction);
  return `rgb(${channel(deleteColor.r, addColor.r)}, ${channel(deleteColor.g, addColor.g)}, ${channel(deleteColor.b, addColor.b)})`;
}

// --- Hit testing ------------------------------------------------------------

export interface BubbleHit {
  x: number;
  y: number;
  r: number;
}

/** Index of the nearest bubble whose center is within radius + HIT_SLOP_PX
 *  of the point, or undefined when nothing is close enough. */
export function hitTestBubbles(bubbles: readonly BubbleHit[], x: number, y: number): number | undefined {
  let best: number | undefined;
  let bestDistance = Infinity;
  for (let i = 0; i < bubbles.length; i++) {
    const bubble = bubbles[i];
    const distance = Math.hypot(x - bubble.x, y - bubble.y);
    if (distance <= bubble.r + HIT_SLOP_PX && distance < bestDistance) {
      best = i;
      bestDistance = distance;
    }
  }
  return best;
}

// --- Zoom and pan -----------------------------------------------------------

/** Rescales the domain around an anchor time (the cursor) so the anchor keeps
 *  its on-screen position; factor < 1 zooms in. The span never shrinks below
 *  `minSpanMs`, preserving the anchor's relative position when clamping. */
export function zoomDomain(
  domain: TimeDomain,
  anchorTimeMs: number,
  factor: number,
  minSpanMs: number = MIN_ZOOM_SPAN_MS,
): TimeDomain {
  const anchor = Math.min(Math.max(anchorTimeMs, domain.start), domain.end);
  let start = anchor - (anchor - domain.start) * factor;
  let end = anchor + (domain.end - anchor) * factor;
  if (end - start < minSpanMs) {
    const span = end - start;
    const anchorFraction = span > 0 ? (anchor - start) / span : 0.5;
    start = anchor - anchorFraction * minSpanMs;
    end = start + minSpanMs;
  }
  return { start, end };
}

export function panDomain(domain: TimeDomain, deltaMs: number): TimeDomain {
  return { start: domain.start + deltaMs, end: domain.end + deltaMs };
}
