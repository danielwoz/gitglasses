// Webview-side row store: paged rows, selection, and the infinite-scroll
// request guard. Pure state (no DOM) so it is unit-testable.

import type { GraphRow } from './ipc';
import { SelectionState, emptySelection, remapSelection } from './graphLogic';

/** Trigger loadMore when the visible window ends within this many rows of
 *  the last loaded row. */
export const LOAD_MORE_THRESHOLD_ROWS = 20;

export class GraphStore {
  rows: GraphRow[] = [];
  nextCursor: string | undefined;
  selection: SelectionState = emptySelection();
  requestInFlight = false;
  /** The host's generation the loaded rows belong to. Pages and replies of
   *  any other generation describe another snapshot and are dropped. */
  generation = 0;
  /** Highest lane index across all loaded rows and their edges; sizes the
   *  renderer's graph column. */
  maxLane = 0;
  /** Ordered shas, rebuilt lazily after the row list changes. */
  private shaCache: string[] | undefined;
  /** sha -> row index, rebuilt lazily after the row list changes. */
  private indexCache: Map<string, number> | undefined;

  /** Whether rows of `generation` belong in the store, adopting the
   *  generation of a refresh. A refresh starts a newer generation of the same
   *  graph and replaces every row; a page belongs to exactly one generation.
   *  Anything older is a superseded answer. */
  acceptRows(generation: number, replace: boolean): boolean {
    if (replace ? generation < this.generation : generation !== this.generation) return false;
    this.generation = generation;
    return true;
  }

  /** Appends one fetched page; the new cursor replaces the old one and the
   *  in-flight guard is released. */
  appendPage(rows: GraphRow[], nextCursor?: string): void {
    for (const row of rows) {
      this.rows.push(row);
      this.widen(row);
    }
    this.invalidate();
    this.nextCursor = nextCursor;
    this.requestInFlight = false;
  }

  /** Replaces every loaded row with a fresh snapshot of the same graph, keeping
   *  the selection on the commits that are still there. */
  replaceAll(rows: GraphRow[], nextCursor?: string): void {
    const previous = this.shas();
    this.rows = [...rows];
    this.maxLane = 0;
    for (const row of this.rows) this.widen(row);
    this.invalidate();
    this.selection = remapSelection(this.selection, previous, this.shas());
    this.nextCursor = nextCursor;
    this.requestInFlight = false;
  }

  /** Drops all rows, cursor, selection, and any in-flight guard. */
  reset(): void {
    this.rows = [];
    this.maxLane = 0;
    this.invalidate();
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

  /** Row index of a sha, or -1 when it is not loaded. */
  indexOf(sha: string): number {
    if (this.indexCache === undefined) {
      this.indexCache = new Map();
      this.rows.forEach((row, i) => this.indexCache!.set(row.sha, i));
    }
    return this.indexCache.get(sha) ?? -1;
  }

  /** Selected rows in row order (newest first). */
  selectedRows(): GraphRow[] {
    const selected = this.selection.selected;
    return this.rows.filter((row) => selected.has(row.sha));
  }

  /** The row keyboard actions apply to: the selection anchor. */
  anchorRow(): GraphRow | undefined {
    const anchor = this.selection.anchor;
    return anchor >= 0 && anchor < this.rows.length ? this.rows[anchor] : undefined;
  }

  private widen(row: GraphRow): void {
    if (row.lane > this.maxLane) this.maxLane = row.lane;
    for (const edge of row.laneEdges) {
      if (edge.fromLane > this.maxLane) this.maxLane = edge.fromLane;
      if (edge.toLane > this.maxLane) this.maxLane = edge.toLane;
    }
  }

  private invalidate(): void {
    this.shaCache = undefined;
    this.indexCache = undefined;
  }
}
