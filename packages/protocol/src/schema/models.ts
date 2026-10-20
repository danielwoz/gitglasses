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

/** Attribution choices for blame/file. Every member is optional; the defaults
 *  are plain `git blame`. */
export const BlameOptions = Type.Object(
  {
    ignoreWhitespace: Type.Optional(
      Type.Boolean({
        description:
          '`git blame -w`: a change that only touches whitespace does not take a line over. Default false.',
      }),
    ),
    moves: Type.Optional(
      Type.Union([Type.Literal('off'), Type.Literal('withinFile'), Type.Literal('acrossFiles')], {
        description:
          "How far blame looks for lines that were moved or copied rather than written: 'withinFile' is `git blame -M`, 'acrossFiles' is `-C`, which also covers moves within the file. Default 'off'. Ignored when the engine has no git CLI.",
      }),
    ),
    ignoreRevs: Type.Optional(
      Type.Boolean({
        description:
          'Look through the commits listed in the blame.ignoreRevsFile files that exist, or in the repository\'s .git-blame-ignore-revs when that setting is unset. Default true. Ignored when the engine has no git CLI.',
      }),
    ),
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

/** A file one commit changes, as commit/details lists it: a FileChange that
 *  also says whether the content is binary. */
export const CommitFileChange = Type.Object(
  {
    path: Type.String({ description: 'Path after the commit (for a deletion, the deleted path).' }),
    status: FileChangeStatus,
    origPath: Type.Optional(
      Type.String({ description: 'Path before the commit; renames and copies only.' }),
    ),
    /** 0 for binary files, whose lines are not counted. */
    additions: Count,
    deletions: Count,
    binary: Type.Boolean({
      description: 'Either side is binary; additions and deletions are then 0.',
    }),
  },
  strict,
);

/** One `Key: value` trailer from the end of a commit message. */
export const CommitTrailer = Type.Object(
  {
    key: Type.String(),
    value: Type.String(),
  },
  strict,
);

/** A ref that points at a commit. */
export const CommitRef = Type.Object(
  {
    name: Type.String({
      description: "Short name: 'HEAD', 'main', 'origin/main', 'v1.0'.",
    }),
    kind: Type.Union(
      [Type.Literal('head'), Type.Literal('branch'), Type.Literal('remote'), Type.Literal('tag')],
      {
        description:
          "'head' when HEAD resolves to the commit (attached or detached), 'branch' for a local branch, 'remote' for a remote-tracking branch, 'tag' for a tag (annotated tags peeled).",
      },
    ),
  },
  strict,
);

export const CommitDetails = Type.Object(
  {
    /** The commit the requested revision resolved to. */
    sha: Sha,
    parents: Type.Array(Sha),
    author: BlameSignature,
    committer: BlameSignature,
    subject: Type.String({
      description:
        "The message's first paragraph with its line breaks folded into spaces, like git's %s.",
    }),
    body: Type.String({
      description:
        'The message after the subject and the blank line that ends it, trailers included, trimmed; empty when there is none.',
    }),
    trailers: Type.Array(CommitTrailer, {
      description: "Trailers parsed from the message's closing paragraph, in order.",
    }),
    refs: Type.Array(CommitRef, {
      description:
        'Refs pointing at the commit: HEAD, then local branches, remote branches and tags, each sorted by name.',
    }),
    files: Type.Array(CommitFileChange, {
      description:
        "Files changed against the first parent (the empty tree for a root commit), with diff/commit's rename detection. Capped; see `truncated`.",
    }),
    stats: Type.Object(
      {
        /** Every changed file, including those past the cap. */
        files: Count,
        /** Sums over the listed files. */
        additions: Count,
        deletions: Count,
      },
      {
        ...strict,
        description:
          '`files` counts every changed file; `additions` and `deletions` sum the listed files only, so they undercount when `truncated` is set.',
      },
    ),
    truncated: Type.Boolean({
      description: 'More files changed than `files` lists.',
    }),
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

/** What a git failure was about, as far as git's own output tells. Carried in
 *  a GitError's `error.data.kind`, so a client can offer the next step
 *  instead of showing git's text alone. */
export const GitErrorKind = Type.Union(
  [
    /** The remote wanted credentials that were missing, refused or not given. */
    Type.Literal('auth'),
    /** An ssh host key is unknown, or differs from the one on record. */
    Type.Literal('hostKey'),
    /** The ssh server accepted none of the keys offered. */
    Type.Literal('publickey'),
    /** A commit could not be signed (gpg or ssh signing). */
    Type.Literal('signing'),
    /** The remote refused the push: the branch moved on there. */
    Type.Literal('rejected'),
    /** Local and remote branches diverged and git needs a merge or rebase choice. */
    Type.Literal('divergent'),
    /** No remote to publish to, or several and none chosen; see `remotes`. */
    Type.Literal('noRemote'),
    /** The branch tracks no upstream to pull from. */
    Type.Literal('noUpstream'),
    /** A cherry-pick or revert stopped because the commit became empty. */
    Type.Literal('emptyCommit'),
    /** A multi-step operation stopped without conflicts (a hook, a signing
     *  failure, an edit step); `operation` names it. */
    Type.Literal('stopped'),
    /** The remote could not be reached. */
    Type.Literal('network'),
    /** git ran past its time limit and was stopped. */
    Type.Literal('timeout'),
    /** A credential or confirmation prompt was dismissed. */
    Type.Literal('cancelled'),
  ],
  { description: "What a git failure was about, read from git's output." },
);

export const GitErrorData = Type.Object(
  {
    kind: GitErrorKind,
    /** Multi-step operation the failure left the repository in, if any. */
    operation: Type.Optional(SequencerOperation),
    /** Remote the command talked to, when known. */
    remote: Type.Optional(Type.String()),
    /** Configured remotes, for a `noRemote` failure to choose from. */
    remotes: Type.Optional(Type.Array(Type.String())),
    /** Host the command talked to, when git named it. */
    host: Type.Optional(Type.String()),
    /** The failure came from fetching objects a partial clone left out. */
    partialClone: Type.Optional(Type.Boolean()),
    /** git reaches ssh remotes through PuTTY's plink, which cannot show
     *  prompts through the client (it ignores SSH_ASKPASS). */
    sshProgram: Type.Optional(Type.Literal('plink')),
  },
  {
    ...strict,
    description:
      'error.data of a GitError (-32001), present when the engine could tell what the failure was about.',
  },
);

/** What a credential prompt asks for. */
export const AskpassKind = Type.Union([
  Type.Literal('username'),
  Type.Literal('password'),
  /** A key's passphrase or a security key PIN: ssh, ssh signing or gpg. */
  Type.Literal('passphrase'),
  /** Whether to trust an ssh host key seen for the first time; answer yes or no. */
  Type.Literal('hostKey'),
  /** A yes/no confirmation ssh asks for (SSH_ASKPASS_PROMPT=confirm). */
  Type.Literal('confirm'),
  Type.Literal('other'),
]);
