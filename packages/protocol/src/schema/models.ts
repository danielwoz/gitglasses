// TypeBox schemas for the protocol's data models. These are the source of
// truth: the public TS types in ../index.ts derive from them via Static<>,
// and the JSON Schema artifact (protocol.schema.json) is emitted from them.

import { Type } from '@sinclair/typebox';

/** All protocol objects declare their full shape; unknown keys are drift. */
export const strict = { additionalProperties: false } as const;

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
    oid: Type.String(),
    branch: Type.String(),
    detached: Type.Boolean(),
    unborn: Type.Boolean(),
  },
  strict,
);

export const BlameSignature = Type.Object(
  {
    name: Type.String(),
    email: Type.String(),
    time: Type.Number(),
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
    sha: Type.String(),
    /** 1-based first line in the blamed file version. */
    resultLine: Type.Number(),
    originalLine: Type.Number(),
    lineCount: Type.Number(),
    /** Path in the blamed commit (differs across renames). */
    path: Type.String(),
    previous: Type.Optional(
      Type.Object({ sha: Type.String(), path: Type.String() }, strict),
    ),
  },
  strict,
);

export const CommitSummaryInfo = Type.Object(
  {
    sha: Type.String(),
    parents: Type.Array(Type.String()),
    author: BlameSignature,
    committer: BlameSignature,
    summary: Type.String(),
  },
  strict,
);

export const FileHistoryEntry = Type.Object(
  {
    sha: Type.String(),
    author: BlameSignature,
    summary: Type.String(),
    /** Path of the file at this commit (differs across renames). */
    path: Type.String(),
    additions: Type.Number(),
    deletions: Type.Number(),
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
    additions: Type.Number(),
    deletions: Type.Number(),
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
      Type.Object(
        { name: Type.String(), ahead: Type.Number(), behind: Type.Number() },
        strict,
      ),
    ),
  },
  strict,
);

export const LaneEdge = Type.Object(
  {
    fromLane: Type.Number(),
    toLane: Type.Number(),
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
    sha: Type.String(),
    parents: Type.Array(Type.String()),
    /** Column assigned by the engine's deterministic lane layout. */
    lane: Type.Number(),
    /** Edges drawn through this row: continuing lanes and merge/branch turns. */
    laneEdges: Type.Array(LaneEdge),
    author: BlameSignature,
    time: Type.Number(),
    summary: Type.String(),
    refs: Type.Array(GraphRef),
    kind: Type.Union([Type.Literal('commit'), Type.Literal('stash'), Type.Literal('wip')]),
  },
  strict,
);

export const DiffHunk = Type.Object(
  {
    header: Type.String(),
    oldStart: Type.Number(),
    oldLines: Type.Number(),
    newStart: Type.Number(),
    newLines: Type.Number(),
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
    sha: Type.String(),
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
    patch: Type.String(),
    /** Fingerprint of origin remote URL (sha256 hex, first 16) for repo matching. */
    remoteFingerprint: Type.Optional(Type.String()),
    createdAtIso: Type.String(),
  },
  strict,
);
