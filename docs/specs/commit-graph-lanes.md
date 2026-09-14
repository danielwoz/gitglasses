# Commit graph lane layout (engine-side)

The engine assigns every graph row a `lane` (column) and a set of `laneEdges`
deterministically, so the webview is a dumb painter and layouts are
golden-file testable.

## Ordering

Rows are emitted in topological order (children before parents), ties broken
by committer time (newest first), then by sha (lexicographic) — fully
deterministic for identical repos.

Synthetic rows precede their anchor: the WIP row (uncommitted changes, when
requested and non-empty) is row 0 attached to HEAD's lane; stash rows appear
immediately before the commit they were stashed on.

## Lane assignment (active-lanes algorithm)

Maintain an ordered list of active lanes; each lane holds the sha it is
waiting for (the next expected commit in that lane).

For each row (commit C):

1. **Find lanes waiting for C.** If none, C starts a new lane: allocate the
   lowest-index free lane (reuse freed lanes before growing). If one or more,
   C's lane = the lowest-indexed waiting lane; every other lane waiting for C
   emits a `mergeIn` edge (fromLane = that lane, toLane = C.lane) and is
   freed.
2. **Parents.** First parent replaces C in C's lane (lane now waits for
   parent1). Each additional parent: if some lane already waits for it, emit
   `branchOut` (fromLane = C.lane, toLane = that lane); otherwise allocate the
   lowest free lane for it and emit `branchOut` to it.
3. **Continuing lanes.** Every active lane not involved with C emits a `line`
   edge (fromLane == toLane) so the painter draws pass-through verticals.
4. A commit with zero parents frees its lane after the row.

Lane indices are stable across paging: paging state (the active-lane list)
is serialized into the cursor so page N+1 continues exactly where page N
stopped.

## Determinism requirements

- Same repo state + same request ⇒ byte-identical row list.
- Lane count is minimized greedily (lowest-free-index reuse), not globally.
- Golden tests: fixture repos (linear, single merge, criss-cross, octopus,
  concurrent branches) with committed expected-JSON row dumps.

## Refs decoration

Each row carries `refs`: branch/tag/remote/stash/HEAD pointers at that sha,
with upstream ahead/behind for local branches. Decorations are recomputed on
every change of the `refsFingerprint` without relaying out the graph (layout
depends only on the commit DAG).
