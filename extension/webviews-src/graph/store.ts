// Webview-side row store: paged rows, selection, and the infinite-scroll
// request guard. Pure state (no DOM) so it is unit-testable.

import type { GraphRow } from './ipc';
import { SelectionState, emptySelection } from './graphLogic';

/** Trigger loadMore when the visible window ends within this many rows of
 *  the last loaded row. */
export const LOAD_MORE_THRESHOLD_ROWS = 20;

export class GraphStore {
  rows: GraphRow[] = [];
  nextCursor: string | undefined;
  selection: SelectionState = emptySelection();
  requestInFlight = false;
  /** Highest lane index across all loaded rows and their edges; sizes the
   *  renderer's graph column. */
  maxLane = 0;
  /** Ordered shas, rebuilt lazily after the row list changes. */
  private shaCache: string[] | undefined;

  /** Appends one fetched page; the new cursor replaces the old one and the
   *  in-flight guard is released. */
  appendPage(rows: GraphRow[], nextCursor?: string): void {
    for (const row of rows) {
      this.rows.push(row);
      if (row.lane > this.maxLane) this.maxLane = row.lane;
      for (const edge of row.laneEdges) {
        if (edge.fromLane > this.maxLane) this.maxLane = edge.fromLane;
        if (edge.toLane > this.maxLane) this.maxLane = edge.toLane;
      }
    }
    this.shaCache = undefined;
    this.nextCursor = nextCursor;
    this.requestInFlight = false;
  }

  /** Drops all rows, cursor, selection, and any in-flight guard. */
  reset(): void {
    this.rows = [];
    this.maxLane = 0;
    this.shaCache = undefined;
    this.nextCursor = undefined;
    this.selection = emptySelection();
    this.requestInFlight = false;
  }

  /** True when the scroll position is close enough to the end that the next
   *  page should be requested (a cursor exists and no request is running). */
  shouldLoadMore(visibleEnd: number): boolean {
    if (this.nextCursor === undefined || this.requestInFlight) return false;
    return visibleEnd >= this.rows.length - LOAD_MORE_THRESHOLD_ROWS;
  }

  /** Claims the next page: returns the cursor to request and arms the
   *  in-flight guard, or undefined when no request should be made. */
  beginLoadMore(visibleEnd: number): string | undefined {
    if (!this.shouldLoadMore(visibleEnd)) return undefined;
    this.requestInFlight = true;
    return this.nextCursor;
  }

  /** Ordered shas, for selection range math. The array is cached and shared
   *  between calls; callers must not mutate it. */
  shas(): readonly string[] {
    if (this.shaCache === undefined) this.shaCache = this.rows.map((row) => row.sha);
    return this.shaCache;
  }
}
