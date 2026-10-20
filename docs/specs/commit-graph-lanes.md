# Commit graph lane layout (engine-side)

The engine assigns every graph row a `lane` (column) and a set of `laneEdges`
deterministically, so the webview is a dumb painter and layouts are
golden-file testable.

## Ordering

Rows are emitted in the order `git log --topo-order` uses for a graph:

- Children always come before their parents.
- Ready commits form a stack, so a commit's parents follow it directly and
  each branch's commits stay together. A merge's later parents are pushed
  last and therefore come out first: the merged branch is shown right below
  the merge, and its lane closes before the first-parent line continues.
- Branch tips start newest first by committer time, then by sha
  (lexicographic), which makes the order fully deterministic. For tips with
  distinct times the commit order equals `git rev-list --topo-order` over the
  same refs (a golden test checks this).

Ordering by date instead interleaves every concurrently developed branch,
which on an integration-heavy repository (git/git) keeps a hundred or more
lanes open at once.

Synthetic rows precede their anchor: the WIP row (uncommitted changes, when
requested and non-empty) is row 0 attached to HEAD's lane; stash rows appear
immediately before the commit they were stashed on.

## Lane assignment (active-lanes algorithm)

Maintain an ordered list of active lanes; each lane holds the sha it is
waiting for (the next expected commit in that lane).

For each row (commit C):

1. **Find lanes waiting for C.** If none, C starts a new lane: allocate the
   lowest-index free lane (reuse freed lanes before growing). If one or more,
   C's lane = the lowest-indexed waiting lane, which emits `lineIn` (the line
   from the row top into the dot); every other lane waiting for C emits a
   `mergeIn` edge (fromLane = that lane, toLane = C.lane) and is freed.
2. **First parent.** Every lane that already waits for the first parent,
   plus C's own lane, collapses into the leftmost of them, the way
   `git log --graph` merges columns that lead to the same commit:
   - If that is C's lane, the lane now waits for the first parent and emits
     `lineOut` (dot to row bottom).
   - Otherwise C's lane ends with a `branchOut` edge into it.
   - The other lanes that waited for the first parent move into it with a
     `line` edge whose toLane differs from its fromLane, and are freed.
3. **Further parents.** If some lane already waits for the parent, emit
   `branchOut` (fromLane = C.lane, toLane = that lane); otherwise allocate the
   lowest free lane for it and emit `branchOut` to it (`lineOut` when the
   free lane is C's own, freed in step 2).
4. **Continuing lanes.** Every lane that enters the row from above and does
   not end in the dot emits a `line` edge, so the painter draws the
   pass-through. Its toLane equals fromLane unless step 2 moved it.
5. A commit with zero parents frees its lane after the row.

Edge order within a row: `lineIn`, `mergeIn` (ascending fromLane), one edge
per parent in parent order, then `line` edges (ascending fromLane).

Every line that leaves a row at the bottom (`lineOut`, `branchOut`, `line`
by toLane) enters the next row at the top in the same lane (`lineIn`,
`mergeIn`, `line` by fromLane), so the painter draws an unbroken graph from
the edges alone.

Lane indices are stable across paging: paging state (the active-lane list)
is serialized into the cursor so page N+1 continues exactly where page N
stopped. The cursor also records the fingerprint of the walk it indexes into
and whether the walk opened with the WIP row. A cursor whose fingerprint no
longer matches (a ref moved, or another `refs` filter) is refused with
InvalidParams, and the client starts again from the first page.

## Filtering

`refs` restricts the walk to the commits reachable from the named revisions.
The fingerprint of a filtered walk also covers the roots it starts from. The
WIP row is included only when HEAD is one of those roots; stash rows appear
when the commit they were stashed on is walked.

## Determinism requirements

- Same repo state + same request ⇒ byte-identical row list.
- Lane count is minimized greedily (lowest-free-index reuse and first-parent
  collapsing), not globally.
- Golden tests: fixture repos (linear, single merge, criss-cross, octopus,
  concurrent branches) with committed expected-JSON row dumps, plus property
  tests for continuity, paging and lane reuse across many merged topics.

## Refs decoration

Each row carries `refs`: branch/tag/remote/stash/HEAD pointers at that sha,
with upstream ahead/behind for local branches. Decorations are recomputed on
every change of the `refsFingerprint` without relaying out the graph (layout
depends only on the commit DAG).
