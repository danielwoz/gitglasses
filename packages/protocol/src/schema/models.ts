// TypeBox schemas for the protocol's data models. These are the source of
// truth: the public TS types in ../index.ts derive from them via Static<>,
// and the JSON Schema artifact (protocol.schema.json) is emitted from them.

import { Type } from '@sinclair/typebox';

/** All protocol objects declare their full shape; unknown keys are drift. */
export const strict = { additionalProperties: false } as const;

/** Full object id as the engine emits it: 40 lowercase hex characters. */
export const Sha = Type.String({
  pattern: '^[0-9a-f]{40}$',
  description: 'Full 40-character lowercase hex object id.',
});

/** Non-negative count. */
const Count = Type.Integer({ minimum: 0 });

/** 1-based line number. */
const Line = Type.Integer({ minimum: 1 });

/** Lane column in the graph layout, counted from 0 at the left. */
const Lane = Type.Integer({ minimum: 0 });

/** Seconds since the Unix epoch, in UTC. Git's signatures also carry the
 *  author's local zone offset; the protocol drops it, so a date rendered from
 *  this is the UTC one, not the one the author saw. */
const UnixTime = Type.Integer();

export const RepoInfo = Type.Object(
  {
    repoId: Type.String(),
    rootPath: Type.String(),
    bare: Type.Boolean(),
  },
  strict,
);

export const HeadState = Type.Object(
  {
    /** Commit HEAD resolves to; empty while HEAD is unborn. */
    oid: Type.String(),
    branch: Type.String(),
    detached: Type.Boolean(),
    unborn: Type.Boolean(),
  },
  strict,
);

/** Operation the sequencer is part-way through, or 'none'. */
export const SequencerOperation = Type.Union(
  [
    Type.Literal('none'),
    Type.Literal('rebase'),
    Type.Literal('merge'),
    Type.Literal('cherry-pick'),
    Type.Literal('revert'),
  ],
  {
    description:
      'Multi-step operation the repository is stopped in the middle of, read from the sequencer state in the gitdir.',
  },
);

export const SequencerState = Type.Object(
  {
    operation: SequencerOperation,
    /** Index holds unmerged entries: the working tree needs resolving. */
    conflicted: Type.Boolean(),
    /** 1-based position of the step git stopped on; rebase only. */
    step: Type.Optional(Type.Integer({ minimum: 1 })),
    /** Number of steps in the running rebase; rebase only. */
    total: Type.Optional(Type.Integer({ minimum: 1 })),
  },
  {
    ...strict,
    description:
      "What the repository is in the middle of. Complements `head`: a repository stopped mid-rebase reports a detached HEAD, and only this tells a client why.",
  },
);

export const BlameSignature = Type.Object(
  {
    name: Type.String(),
    email: Type.String(),
    time: UnixTime,
  },
  strict,
);

export const BlameCommit = Type.Object(
  {
    author: BlameSignature,
    committer: BlameSignature,
    summary: Type.String(),
    boundary: Type.Boolean(),
  },
  strict,
);

export const BlameHunk = Type.Object(
  {
    /** All-zero for lines that are not committed yet. */
    sha: Sha,
    /** 1-based first line in the blamed file version. */
    resultLine: Line,
    /** 1-based first line of the same hunk in `path` as it stands in commit
     *  `sha`, which is where these lines were written. */
    originalLine: Line,
    lineCount: Type.Integer({ minimum: 1 }),
    /** Path in the blamed commit (differs across renames). */
    path: Type.String(),
    previous: Type.Optional(Type.Object({ sha: Sha, path: Type.String() }, strict)),
  },
  strict,
);

export const CommitSummaryInfo = Type.Object(
  {
    sha: Sha,
    parents: Type.Array(Sha),
    author: BlameSignature,
    committer: BlameSignature,
    summary: Type.String(),
  },
  strict,
);

export const FileHistoryEntry = Type.Object(
  {
    sha: Sha,
    author: BlameSignature,
    summary: Type.String(),
    /** Path of the file at this commit (differs across renames). */
    path: Type.String(),
    additions: Count,
    deletions: Count,
  },
  strict,
);

export const FileChangeStatus = Type.Union([
  Type.Literal('M'),
  Type.Literal('A'),
  Type.Literal('D'),
  Type.Literal('R'),
  Type.Literal('C'),
  Type.Literal('T'),
  Type.Literal('U'),
]);

export const FileChange = Type.Object(
  {
    path: Type.String(),
    status: FileChangeStatus,
    origPath: Type.Optional(Type.String()),
    /** 0 for binary files, whose lines are not counted. */
    additions: Count,
    deletions: Count,
  },
  strict,
);

export const GraphRef = Type.Object(
  {
    name: Type.String(),
    kind: Type.Union([
      Type.Literal('head'),
      Type.Literal('branch'),
      Type.Literal('remote'),
      Type.Literal('tag'),
      Type.Literal('stash'),
    ]),
    upstream: Type.Optional(
      Type.Object({ name: Type.String(), ahead: Count, behind: Count }, strict),
    ),
  },
  strict,
);

export const LaneEdge = Type.Object(
  {
    fromLane: Lane,
    toLane: Lane,
    kind: Type.Union([
      Type.Literal('line'),
      Type.Literal('mergeIn'),
      Type.Literal('branchOut'),
    ]),
  },
  strict,
);

export const GraphRow = Type.Object(
  {
    /** All-zero on the synthetic uncommitted-changes row. */
    sha: Sha,
    parents: Type.Array(Sha),
    /** Column assigned by the engine's deterministic lane layout. */
    lane: Lane,
    /** Edges drawn through this row: continuing lanes and merge/branch turns. */
    laneEdges: Type.Array(LaneEdge),
    author: BlameSignature,
    time: UnixTime,
    summary: Type.String(),
    refs: Type.Array(GraphRef),
    kind: Type.Union([Type.Literal('commit'), Type.Literal('stash'), Type.Literal('wip')]),
  },
  strict,
);

export const DiffHunk = Type.Object(
  {
    header: Type.String(),
    /** 0 when the hunk adds a file: there is no old side. */
    oldStart: Count,
    oldLines: Count,
    newStart: Count,
    newLines: Count,
    /** Unified diff lines including leading ' ', '+', '-'. */
    lines: Type.Array(Type.String()),
  },
  strict,
);

export const RebaseEntry = Type.Object(
  {
    action: Type.Union([
      Type.Literal('pick'),
      Type.Literal('reword'),
      Type.Literal('squash'),
      Type.Literal('fixup'),
      Type.Literal('drop'),
      Type.Literal('edit'),
    ]),
    /** Commit to act on, as rebase/preview reported it. */
    sha: Type.String({ minLength: 1 }),
    summary: Type.String(),
    /** Replacement message for reword/squash. */
    message: Type.Optional(Type.String()),
  },
  strict,
);

export const PatchEnvelope = Type.Object(
  {
    format: Type.Literal('gitglasses-patch'),
    version: Type.Literal(1),
    /** Commit the diff applies onto. */
    baseSha: Type.String(),
    branch: Type.Optional(Type.String()),
    summary: Type.String(),
    /** Unified diff text (git diff/format-patch output). */
    patch: Type.String({ minLength: 1 }),
    /** Fingerprint of origin remote URL (sha256 hex, first 16) for repo matching. */
    remoteFingerprint: Type.Optional(Type.String()),
    createdAtIso: Type.String(),
  },
  strict,
);
