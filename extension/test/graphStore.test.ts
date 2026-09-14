import { describe, expect, it } from 'vitest';
import type { GraphRow } from '@gitglasses/protocol';
import { GraphStore, LOAD_MORE_THRESHOLD_ROWS } from '../webviews-src/graph/store';

function makeRows(count: number, offset = 0): GraphRow[] {
  return Array.from({ length: count }, (_, i) => ({
    sha: `sha-${offset + i}`,
    parents: [],
    lane: 0,
    laneEdges: [],
    author: { name: 'a', email: 'a@example.com', time: 1000 + i },
    time: 1000 + i,
    summary: `commit ${offset + i}`,
    refs: [],
    kind: 'commit' as const,
  }));
}

/** Rows carrying explicit lane numbers and a single edge each. */
function makeLanedRows(lanes: number[], edges: [number, number][] = []): GraphRow[] {
  return lanes.map((lane, i) => ({
    ...makeRows(1, i)[0],
    lane,
    laneEdges: edges[i]
      ? [{ fromLane: edges[i][0], toLane: edges[i][1], kind: 'line' as const }]
      : [],
  }));
}

describe('GraphStore paging', () => {
  it('appends pages and tracks the latest cursor', () => {
    const store = new GraphStore();
    store.appendPage(makeRows(3), 'c1');
    store.appendPage(makeRows(2, 3), 'c2');
    expect(store.rows).toHaveLength(5);
    expect(store.rows[3].sha).toBe('sha-3');
    expect(store.nextCursor).toBe('c2');
  });

  it('reset clears rows, cursor, selection, and the in-flight guard', () => {
    const store = new GraphStore();
    store.appendPage(makeRows(3), 'c1');
    store.beginLoadMore(3);
    store.selection = { selected: new Set(['sha-1']), anchor: 1 };
    store.reset();
    expect(store.rows).toHaveLength(0);
    expect(store.nextCursor).toBeUndefined();
    expect(store.requestInFlight).toBe(false);
    expect(store.selection.selected.size).toBe(0);
  });
});

describe('GraphStore infinite-scroll trigger', () => {
  it('triggers when the visible end is within the threshold of the end', () => {
    const store = new GraphStore();
    store.appendPage(makeRows(100), 'c1');
    expect(store.shouldLoadMore(100 - LOAD_MORE_THRESHOLD_ROWS)).toBe(true);
    expect(store.shouldLoadMore(100)).toBe(true);
  });

  it('does not trigger while far from the end', () => {
    const store = new GraphStore();
    store.appendPage(makeRows(100), 'c1');
    expect(store.shouldLoadMore(100 - LOAD_MORE_THRESHOLD_ROWS - 1)).toBe(false);
  });

  it('never triggers without a next cursor', () => {
    const store = new GraphStore();
    store.appendPage(makeRows(10), undefined);
    expect(store.shouldLoadMore(10)).toBe(false);
  });

  it('beginLoadMore returns the cursor once and arms the guard', () => {
    const store = new GraphStore();
    store.appendPage(makeRows(30), 'c1');
    expect(store.beginLoadMore(30)).toBe('c1');
    expect(store.requestInFlight).toBe(true);
    // Repeated scroll events while the request runs must not double-fetch.
    expect(store.beginLoadMore(30)).toBeUndefined();
  });

  it('releases the guard when the next page arrives', () => {
    const store = new GraphStore();
    store.appendPage(makeRows(30), 'c1');
    store.beginLoadMore(30);
    store.appendPage(makeRows(30, 30), 'c2');
    expect(store.requestInFlight).toBe(false);
    expect(store.beginLoadMore(60)).toBe('c2');
  });

  it('stops triggering after the final page (no cursor)', () => {
    const store = new GraphStore();
    store.appendPage(makeRows(30), 'c1');
    store.beginLoadMore(30);
    store.appendPage(makeRows(5, 30), undefined);
    expect(store.shouldLoadMore(35)).toBe(false);
    expect(store.beginLoadMore(35)).toBeUndefined();
  });

  it('beginLoadMore leaves the guard untouched when not near the end', () => {
    const store = new GraphStore();
    store.appendPage(makeRows(100), 'c1');
    expect(store.beginLoadMore(10)).toBeUndefined();
    expect(store.requestInFlight).toBe(false);
  });
});

describe('GraphStore lane maximum', () => {
  it('tracks the highest lane across rows and their edges', () => {
    const store = new GraphStore();
    store.appendPage(makeLanedRows([0, 2, 1], [[0, 0], [0, 5], [1, 1]]), 'c1');
    expect(store.maxLane).toBe(5);
  });

  it('carries the maximum forward across pages', () => {
    const store = new GraphStore();
    store.appendPage(makeLanedRows([3]), 'c1');
    expect(store.maxLane).toBe(3);
    // A later page with only low lanes must not lower the maximum.
    store.appendPage(makeLanedRows([0, 1]), 'c2');
    expect(store.maxLane).toBe(3);
    store.appendPage(makeLanedRows([7]), undefined);
    expect(store.maxLane).toBe(7);
  });

  it('matches a full scan of the rows', () => {
    const store = new GraphStore();
    const pages = [makeLanedRows([1, 4], [[0, 2], [3, 9]]), makeLanedRows([6], [[6, 2]])];
    for (const page of pages) store.appendPage(page, 'c');
    let expected = 0;
    for (const row of store.rows) {
      expected = Math.max(expected, row.lane);
      for (const edge of row.laneEdges) {
        expected = Math.max(expected, edge.fromLane, edge.toLane);
      }
    }
    expect(store.maxLane).toBe(expected);
  });

  it('reset returns the maximum to zero', () => {
    const store = new GraphStore();
    store.appendPage(makeLanedRows([4]), 'c1');
    store.reset();
    expect(store.maxLane).toBe(0);
  });
});

describe('GraphStore.shas caching', () => {
  it('returns the ordered shas', () => {
    const store = new GraphStore();
    store.appendPage(makeRows(3), 'c1');
    expect([...store.shas()]).toEqual(['sha-0', 'sha-1', 'sha-2']);
  });

  it('reuses the same array across repeated calls', () => {
    const store = new GraphStore();
    store.appendPage(makeRows(3), 'c1');
    expect(store.shas()).toBe(store.shas());
  });

  it('rebuilds after a page arrives', () => {
    const store = new GraphStore();
    store.appendPage(makeRows(2), 'c1');
    const first = store.shas();
    store.appendPage(makeRows(2, 2), 'c2');
    const second = store.shas();
    expect(second).not.toBe(first);
    expect([...second]).toEqual(['sha-0', 'sha-1', 'sha-2', 'sha-3']);
  });

  it('rebuilds after reset', () => {
    const store = new GraphStore();
    store.appendPage(makeRows(2), 'c1');
    store.shas();
    store.reset();
    expect([...store.shas()]).toEqual([]);
  });
});
