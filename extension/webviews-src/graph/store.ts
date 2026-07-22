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

  /** Appends one fetched page; the new cursor replaces the old one and the
   *  in-flight guard is released. */
  appendPage(rows: GraphRow[], nextCursor?: string): void {
    this.rows = [...this.rows, ...rows];
    this.nextCursor = nextCursor;
    this.requestInFlight = false;
  }

  /** Drops all rows, cursor, selection, and any in-flight guard. */
  reset(): void {
    this.rows = [];
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

  /** Ordered shas, for selection range math. */
  shas(): string[] {
    return this.rows.map((row) => row.sha);
  }
}
