// Per-method params/result schemas for every request in the protocol.
// The `Requests` interface in ../index.ts derives its member types from these
// via Static<>; protocol.schema.json is emitted from them verbatim.

import { Type } from '@sinclair/typebox';

import {
  BlameCommit,
  CommitSummaryInfo,
  DiffHunk,
  FileChange,
  FileHistoryEntry,
  GraphRow,
  HeadState,
  PatchEnvelope,
  RebaseEntry,
  RepoInfo,
  SequencerState,
  Sha,
  strict,
} from './models.js';

/** An object with no members. `Static<>` of it is `{}`, so ../index.ts
 *  publishes these payloads as its own `Record<string, never>`. */
export const EmptyObject = Type.Object({}, strict);

const StageAction = Type.Union([Type.Literal('stage'), Type.Literal('unstage')]);

/** Page size the engine serves when a paged read omits `limit`. */
export const DEFAULT_LIMIT = 100;

/** Largest page the engine will serve; larger requests are rejected. */
export const MAX_LIMIT = 100000;

/** Default cap on a rev/fileAtRev payload, in bytes. */
export const DEFAULT_FILE_BYTES = 4 * 1024 * 1024;

/** Largest cap a client may ask for, chosen to keep the response frame
 * inside the engine's frame limit once JSON escaping is applied. */
export const MAX_FILE_BYTES = 16 * 1024 * 1024;

const Limit = Type.Optional(
  Type.Integer({
    minimum: 1,
    maximum: MAX_LIMIT,
    default: DEFAULT_LIMIT,
    description: `Maximum entries in the page. Omitted means ${DEFAULT_LIMIT}.`,
  }),
);

/** Continuation token, copied verbatim from the previous page's `nextCursor`.
 *  The encoding is the engine's and differs per method, so clients neither
 *  parse it nor construct one. */
const Cursor = Type.Optional(Type.String({ minLength: 1 }));

// Values the engine hands to git as positional arguments. git parses anything
// beginning with '-' as an option wherever it appears, so a leading dash turns
// a data field into an option-injection primitive and is rejected.
const positional = (description: string) =>
  Type.String({ minLength: 1, pattern: '^[^-]', description });

// Same, for a field whose absence is meaningful. An empty string is rejected
// rather than read as "absent": omit the field instead.
const optionalPositional = (description: string) =>
  Type.Optional(Type.String({ minLength: 1, pattern: '^[^-]', description }));

const Path = (description: string) => Type.String({ minLength: 1, description });

/** Zero-based position in the stash list; 0 is the most recent entry. */
const StashIndex = Type.Integer({ minimum: 0 });

/** Non-negative line count or offset in a diff hunk. */
const HunkOffset = Type.Integer({ minimum: 0 });

/** What this engine build can do; the client gates features on these.
 * additionalProperties stays open so newer engines can add flags without
 * breaking older clients. */
export const EngineCapabilities = Type.Object(
  {
    /** git CLI available: blame --incremental, --follow/-L history, all
     * mutations, rebase, network ops, patch create/apply. When false the
     * engine serves libgit2-backed fallbacks for reads and rejects
     * CLI-dependent methods with MethodNotSupported. */
    gitCli: Type.Boolean(),
    /** Filesystem watching (repo/didChange pushes). */
    watch: Type.Boolean(),
    /** Concurrent request execution (false in single-threaded wasm builds). */
    threads: Type.Boolean(),
    /** Mechanism behind `watch`. Polling still delivers repo/didChange, at a
     * coarser interval and a higher idle cost. */
    watchBackend: Type.Optional(
      Type.Union([Type.Literal('inotify'), Type.Literal('polling'), Type.Literal('none')]),
    ),
  },
  { additionalProperties: true },
);

export const RequestSchemas = {
  initialize: {
    description:
      'Handshake. The engine rejects a protocolVersion it does not implement, so this must be the first request of a session.',
    params: Type.Object({ protocolVersion: Type.String({ minLength: 1 }) }, strict),
    result: Type.Object(
      {
        engineVersion: Type.String(),
        protocolVersion: Type.String(),
        capabilities: EngineCapabilities,
      },
      strict,
    ),
  },
  shutdown: {
    description: 'Asks the engine to stop accepting work and exit.',
    params: EmptyObject,
    result: EmptyObject,
  },
  'repo/discover': {
    description:
      'Registers the repository containing `path`, walking up like `git rev-parse --git-dir`, and starts watching it. The returned repoId addresses it for the rest of the session.',
    params: Type.Object({ path: Path('Any path inside the repository.') }, strict),
    result: RepoInfo,
  },
  'repo/close': {
    description:
      'Releases everything held for a repository: its watch, its cached graph plans and its registry entry. Later requests for the id fail with RepoNotFound.',
    params: Type.Object({ repoId: Type.String() }, strict),
    result: EmptyObject,
  },
  'repo/list': {
    description: 'Repositories registered in this session.',
    params: EmptyObject,
    result: Type.Object({ repos: Type.Array(RepoInfo) }, strict),
  },
  'repo/state': {
    description:
      'Where HEAD points and what multi-step operation, if any, the repository is stopped in the middle of.',
    params: Type.Object({ repoId: Type.String() }, strict),
    result: Type.Object({ head: HeadState, sequencer: SequencerState }, strict),
  },
  'blame/file': {
    description:
      'Blames a file at a revision (working tree by default, honouring unsaved contents pushed via doc/didChange). Hunks stream as blame/hunks notifications tagged with `streamId`; the result carries only the totals and the commit table.',
    params: Type.Object(
      {
        repoId: Type.String(),
        path: Path('Path relative to the repository root.'),
        rev: Type.Optional(
          Type.String({
            minLength: 1,
            pattern: '^[^-]',
            description: 'Revision to blame. Omitted blames the working tree.',
          }),
        ),
        streamId: Type.String({
          minLength: 1,
          description: 'Correlates the blame/hunks notifications of this request.',
        }),
      },
      strict,
    ),
    result: Type.Object(
      {
        streamId: Type.String(),
        totalLines: Type.Integer({ minimum: 0 }),
        /** True when the blame was served from the engine's cache. */
        fromCache: Type.Boolean(),
        /** Commit metadata for every sha referenced by the streamed hunks. */
        commits: Type.Record(Type.String(), BlameCommit),
      },
      strict,
    ),
  },
  'log/commits': {
    description: 'Topo-ordered commit page from a ref (default HEAD).',
    params: Type.Object(
      {
        repoId: Type.String(),
        ref: Type.Optional(
          Type.String({ minLength: 1, description: 'Revision to walk from. Omitted means HEAD.' }),
        ),
        cursor: Cursor,
        limit: Limit,
      },
      strict,
    ),
    result: Type.Object(
      {
        commits: Type.Array(CommitSummaryInfo),
        /** Present only while more commits remain. */
        nextCursor: Type.Optional(Type.String()),
      },
      strict,
    ),
  },
  'history/file': {
    description: 'File history following renames, newest first.',
    params: Type.Object(
      {
        repoId: Type.String(),
        path: Path('Path relative to the repository root.'),
        cursor: Cursor,
        limit: Limit,
      },
      strict,
    ),
    result: Type.Object(
      {
        entries: Type.Array(FileHistoryEntry),
        /** Present only while more entries remain. */
        nextCursor: Type.Optional(Type.String()),
      },
      strict,
    ),
  },
  'history/line': {
    description: 'History of a line range (1-based, inclusive).',
    params: Type.Object(
      {
        repoId: Type.String(),
        path: Path('Path relative to the repository root.'),
        startLine: Type.Integer({ minimum: 1 }),
        /** The engine additionally requires endLine >= startLine, which this
         * schema cannot express. */
        endLine: Type.Integer({ minimum: 1 }),
      },
      strict,
    ),
    result: Type.Object({ entries: Type.Array(FileHistoryEntry) }, strict),
  },
  'search/commits': {
    description:
      'Commit search over HEAD history. Matches stream as search/matches notifications tagged with `streamId`; the result carries only the totals.',
    params: Type.Object(
      {
        repoId: Type.String(),
        streamId: Type.String({
          minLength: 1,
          description: 'Correlates the search/matches notifications of this request.',
        }),
        limit: Limit,
        query: Type.Optional(
          Type.Object(
            {
              /** Case-insensitive substring of the commit message. */
              text: Type.Optional(Type.String({ minLength: 1 })),
              /** Case-insensitive substring of the author name or email. */
              author: Type.Optional(Type.String({ minLength: 1 })),
              /** Case-insensitive sha prefix. */
              sha: Type.Optional(Type.String({ minLength: 1 })),
            },
            {
              ...strict,
              default: {},
              description:
                'Criteria, ANDed together. An absent or empty query matches every commit, so the page is bounded only by `limit`.',
            },
          ),
        ),
      },
      strict,
    ),
    result: Type.Object(
      {
        streamId: Type.String(),
        total: Type.Integer({ minimum: 0 }),
        /** True when the walk stopped at `limit` with matches left unseen. */
        truncated: Type.Boolean(),
      },
      strict,
    ),
  },
  'rev/fileAtRev': {
    description:
      'Contents of a file at a revision, passed through the repository\'s checkout filters so it compares byte-for-byte against an editor buffer. Binary blobs are reported, not returned.',
    params: Type.Object(
      {
        repoId: Type.String(),
        path: Path('Path relative to the repository root.'),
        rev: Type.String({ minLength: 1, description: 'Revision the file is read from.' }),
        maxBytes: Type.Optional(
          Type.Integer({
            minimum: 1,
            maximum: MAX_FILE_BYTES,
            default: DEFAULT_FILE_BYTES,
            description: `Cap on the returned contents. Omitted means ${DEFAULT_FILE_BYTES}.`,
          }),
        ),
      },
      strict,
    ),
    result: Type.Object(
      {
        /** Filtered contents, empty when the blob is binary. */
        contents: Type.String(),
        /** Size of the stored blob in bytes, before filtering or truncation. */
        size: Type.Integer({ minimum: 0 }),
        /** True when `contents` was cut short at `maxBytes`. */
        truncated: Type.Boolean(),
        /** True when the blob is binary; `contents` is then empty. */
        binary: Type.Boolean(),
      },
      strict,
    ),
  },
  'refs/list': {
    description: 'Refs listing for views: branches, remotes, tags.',
    params: Type.Object({ repoId: Type.String() }, strict),
    result: Type.Object(
      {
        branches: Type.Array(
          Type.Object(
            {
              name: Type.String(),
              sha: Sha,
              current: Type.Boolean(),
              upstream: Type.Optional(Type.String()),
            },
            strict,
          ),
        ),
        remotes: Type.Array(
          Type.Object(
            {
              name: Type.String(),
              branches: Type.Array(Type.Object({ name: Type.String(), sha: Sha }, strict)),
            },
            strict,
          ),
        ),
        tags: Type.Array(Type.Object({ name: Type.String(), sha: Sha }, strict)),
      },
      strict,
    ),
  },
  'stash/list': {
    description: 'Stash entries, most recent first.',
    params: Type.Object({ repoId: Type.String() }, strict),
    result: Type.Object(
      {
        entries: Type.Array(
          Type.Object(
            {
              index: StashIndex,
              sha: Sha,
              message: Type.String(),
              branch: Type.Optional(Type.String()),
            },
            strict,
          ),
        ),
      },
      strict,
    ),
  },

  // --- P2: status / graph / diff / staging / mutations / rebase ------------

  'status/summary': {
    description: 'Working tree and index summary, plus upstream divergence.',
    params: Type.Object({ repoId: Type.String() }, strict),
    result: Type.Object(
      {
        branch: Type.String(),
        upstream: Type.Optional(Type.String()),
        ahead: Type.Integer({ minimum: 0 }),
        behind: Type.Integer({ minimum: 0 }),
        staged: Type.Array(FileChange),
        unstaged: Type.Array(FileChange),
        untracked: Type.Array(Type.String()),
        conflicted: Type.Array(Type.String()),
      },
      strict,
    ),
  },
  'graph/rows': {
    description: 'Graph rows with engine-computed lane layout, topo order, paged.',
    params: Type.Object(
      {
        repoId: Type.String(),
        cursor: Cursor,
        limit: Limit,
        include: Type.Optional(
          Type.Object(
            { stashes: Type.Optional(Type.Boolean()), wip: Type.Optional(Type.Boolean()) },
            {
              ...strict,
              default: { stashes: false, wip: false },
              description:
                'Synthetic rows to mix in among the commits. Absent members default to false.',
            },
          ),
        ),
      },
      strict,
    ),
    result: Type.Object(
      {
        rows: Type.Array(GraphRow),
        /** Present only while more rows remain. */
        nextCursor: Type.Optional(Type.String()),
        refsFingerprint: Type.Integer({
          minimum: 0,
          description:
            'Content hash of the ref set the page was sliced from. Constant across the pages of one snapshot and different once any ref moves; unrelated to the monotonic counter in repo/didChange.',
        }),
      },
      strict,
    ),
  },
  'diff/commit': {
    description: "Files changed by one commit, against its first parent's tree.",
    params: Type.Object(
      {
        repoId: Type.String(),
        sha: Type.String({ minLength: 1, description: 'Revision naming the commit.' }),
      },
      strict,
    ),
    result: Type.Object({ files: Type.Array(FileChange) }, strict),
  },
  'diff/refs': {
    description: "Files changed between two revisions' trees.",
    params: Type.Object(
      {
        repoId: Type.String(),
        base: Type.String({ minLength: 1 }),
        head: Type.String({ minLength: 1 }),
      },
      strict,
    ),
    result: Type.Object({ files: Type.Array(FileChange) }, strict),
  },
  'diff/fileHunks': {
    description: "Hunks of a file's working-tree (or staged) diff, for hunk staging.",
    params: Type.Object(
      {
        repoId: Type.String(),
        path: Path('Path relative to the repository root.'),
        staged: Type.Optional(
          Type.Boolean({
            default: false,
            description:
              'Diff the index against HEAD instead of the working tree against the index.',
          }),
        ),
      },
      strict,
    ),
    result: Type.Object({ hunks: Type.Array(DiffHunk) }, strict),
  },
  'stage/files': {
    description: 'Stages or unstages whole files.',
    params: Type.Object(
      {
        repoId: Type.String(),
        paths: Type.Array(Type.String(), { minItems: 1 }),
        action: StageAction,
      },
      strict,
    ),
    result: EmptyObject,
  },
  'stage/hunks': {
    description:
      'Stages or unstages individual hunks. The ranges are matched against a freshly taken diff, so a request built from a stale diff/fileHunks page fails instead of applying the wrong lines.',
    params: Type.Object(
      {
        repoId: Type.String(),
        path: Path('Path relative to the repository root.'),
        action: StageAction,
        hunks: Type.Array(
          Type.Object(
            {
              oldStart: HunkOffset,
              oldLines: HunkOffset,
              newStart: HunkOffset,
              newLines: HunkOffset,
            },
            strict,
          ),
          {
            minItems: 1,
            description: 'Hunk ranges exactly as diff/fileHunks reported them.',
          },
        ),
      },
      strict,
    ),
    result: EmptyObject,
  },
  'mutate/commit': {
    description: 'Commits the index.',
    params: Type.Object(
      {
        repoId: Type.String(),
        message: Type.String({ minLength: 1 }),
        amend: Type.Optional(Type.Boolean()),
        signoff: Type.Optional(Type.Boolean()),
      },
      strict,
    ),
    result: Type.Object({ sha: Sha }, strict),
  },
  'mutate/branchCreate': {
    description: 'Creates a branch, optionally checking it out.',
    params: Type.Object(
      {
        repoId: Type.String(),
        name: positional('Branch to create.'),
        startPoint: optionalPositional('Revision to branch from. Omitted means HEAD.'),
        checkout: Type.Optional(Type.Boolean()),
      },
      strict,
    ),
    result: EmptyObject,
  },
  'mutate/branchDelete': {
    description: 'Deletes a branch.',
    params: Type.Object(
      {
        repoId: Type.String(),
        name: positional('Branch to delete.'),
        /** Deletes even when the branch is not merged. */
        force: Type.Optional(Type.Boolean()),
      },
      strict,
    ),
    result: EmptyObject,
  },
  'mutate/switch': {
    description: 'Checks out a ref, detaching HEAD when it is not a local branch.',
    params: Type.Object(
      { repoId: Type.String(), ref: positional('Revision to check out.') },
      strict,
    ),
    result: EmptyObject,
  },
  'mutate/merge': {
    description: 'Merges a ref into HEAD. Conflicts are a result, not an error.',
    params: Type.Object(
      {
        repoId: Type.String(),
        ref: positional('Revision to merge in.'),
        noFf: Type.Optional(Type.Boolean()),
      },
      strict,
    ),
    result: Type.Object({ conflicts: Type.Boolean() }, strict),
  },
  'mutate/cherryPick': {
    description: 'Cherry-picks commits onto HEAD. Conflicts are a result, not an error.',
    params: Type.Object(
      {
        repoId: Type.String(),
        shas: Type.Array(positional('Revision to pick.'), { minItems: 1 }),
      },
      strict,
    ),
    result: Type.Object({ conflicts: Type.Boolean() }, strict),
  },
  'mutate/revert': {
    description: 'Reverts commits on HEAD. Conflicts are a result, not an error.',
    params: Type.Object(
      {
        repoId: Type.String(),
        shas: Type.Array(positional('Revision to revert.'), { minItems: 1 }),
      },
      strict,
    ),
    result: Type.Object({ conflicts: Type.Boolean() }, strict),
  },
  'mutate/reset': {
    description: 'Moves HEAD to a revision, optionally rewriting index and working tree.',
    params: Type.Object(
      {
        repoId: Type.String(),
        ref: positional('Revision to reset onto.'),
        mode: Type.Union([
          Type.Literal('soft'),
          Type.Literal('mixed'),
          Type.Literal('hard'),
        ]),
      },
      strict,
    ),
    result: EmptyObject,
  },
  'mutate/fetch': {
    description: 'Fetches from a remote.',
    params: Type.Object(
      {
        repoId: Type.String(),
        remote: optionalPositional('Remote to fetch. Omitted uses git\'s default.'),
        prune: Type.Optional(Type.Boolean()),
      },
      strict,
    ),
    result: EmptyObject,
  },
  'mutate/pull': {
    description: "Pulls into the current branch using git's configured strategy.",
    params: Type.Object(
      { repoId: Type.String(), autoStash: Type.Optional(Type.Boolean()) },
      strict,
    ),
    result: EmptyObject,
  },
  'mutate/push': {
    description: 'Pushes the current branch.',
    params: Type.Object(
      {
        repoId: Type.String(),
        setUpstream: Type.Optional(Type.Boolean()),
        /** Only the lease-checked force is offered; a bare --force is not. */
        force: Type.Optional(Type.Literal('with-lease')),
      },
      strict,
    ),
    result: EmptyObject,
  },
  'stash/push': {
    description: 'Stashes the working tree.',
    params: Type.Object(
      {
        repoId: Type.String(),
        message: optionalPositional('Stash message. Omitted uses git\'s generated one.'),
        includeUntracked: Type.Optional(Type.Boolean()),
      },
      strict,
    ),
    result: EmptyObject,
  },
  'stash/apply': {
    description:
      'Applies a stash entry. Conflicts are a result, not an error; git keeps the entry on conflict even for a pop.',
    params: Type.Object(
      {
        repoId: Type.String(),
        index: StashIndex,
        pop: Type.Boolean({
          description:
            'Drops the entry after a clean apply. Required: the two behaviours are not interchangeable, so the engine will not guess.',
        }),
      },
      strict,
    ),
    result: Type.Object({ conflicts: Type.Boolean() }, strict),
  },
  'stash/drop': {
    description: 'Deletes a stash entry.',
    params: Type.Object({ repoId: Type.String(), index: StashIndex }, strict),
    result: EmptyObject,
  },
  'worktree/list': {
    description: 'Worktrees attached to the repository.',
    params: Type.Object({ repoId: Type.String() }, strict),
    result: Type.Object(
      {
        worktrees: Type.Array(
          Type.Object(
            {
              path: Type.String(),
              branch: Type.Optional(Type.String()),
              /** Empty for a bare worktree, which has no checked-out commit. */
              sha: Type.String(),
              bare: Type.Boolean(),
              locked: Type.Boolean(),
            },
            strict,
          ),
        ),
      },
      strict,
    ),
  },
  'worktree/add': {
    description: 'Adds a worktree checked out at a revision.',
    params: Type.Object(
      {
        repoId: Type.String(),
        path: Path('Directory to create the worktree in.'),
        ref: positional('Revision to check out.'),
        createBranch: optionalPositional('Branch to create at `ref` for the new worktree.'),
      },
      strict,
    ),
    result: EmptyObject,
  },
  'worktree/remove': {
    description: 'Removes a worktree.',
    params: Type.Object(
      {
        repoId: Type.String(),
        path: Path('Worktree directory to remove.'),
        /** Removes even when the worktree is dirty. */
        force: Type.Optional(Type.Boolean()),
      },
      strict,
    ),
    result: EmptyObject,
  },
  'rebase/preview': {
    description: 'Commits upstream..HEAD, oldest first — the editable rebase plan.',
    params: Type.Object(
      { repoId: Type.String(), upstream: positional('Revision to rebase onto.') },
      strict,
    ),
    result: Type.Object(
      {
        entries: Type.Array(Type.Object({ sha: Sha, summary: Type.String() }, strict)),
      },
      strict,
    ),
  },
  'rebase/start': {
    description:
      'Executes an interactive rebase with the given plan via sequence-editor interception. Conflicts pause the rebase; repo/state then reports the sequencer step.',
    params: Type.Object(
      {
        repoId: Type.String(),
        upstream: positional('Revision to rebase onto.'),
        plan: Type.Array(RebaseEntry, {
          description: 'Steps in execution order. An empty plan rebases nothing.',
        }),
      },
      strict,
    ),
    result: Type.Object(
      { conflicts: Type.Boolean(), completed: Type.Boolean() },
      strict,
    ),
  },
  'rebase/continue': {
    description: 'Resumes a paused rebase once the conflicts are staged.',
    params: Type.Object({ repoId: Type.String() }, strict),
    result: Type.Object(
      { conflicts: Type.Boolean(), completed: Type.Boolean() },
      strict,
    ),
  },
  'rebase/abort': {
    description: 'Restores the pre-rebase state.',
    params: Type.Object({ repoId: Type.String() }, strict),
    result: EmptyObject,
  },

  // --- P4: remotes / open patches ------------------------------------------

  'remote/list': {
    description: 'Configured remotes and their URLs.',
    params: Type.Object({ repoId: Type.String() }, strict),
    result: Type.Object(
      {
        remotes: Type.Array(
          Type.Object(
            {
              name: Type.String(),
              fetchUrl: Type.String(),
              pushUrl: Type.Optional(Type.String()),
            },
            strict,
          ),
        ),
      },
      strict,
    ),
  },
  'patch/create': {
    description: 'Creates a shareable patch envelope from WIP, a stash, a commit, or a range.',
    params: Type.Object(
      {
        repoId: Type.String(),
        source: Type.Union([
          Type.Object(
            {
              kind: Type.Literal('wip'),
              includeUntracked: Type.Optional(Type.Boolean()),
            },
            strict,
          ),
          Type.Object({ kind: Type.Literal('stash'), index: StashIndex }, strict),
          Type.Object(
            { kind: Type.Literal('commit'), sha: positional('Revision to capture.') },
            strict,
          ),
          Type.Object(
            {
              kind: Type.Literal('range'),
              base: positional('Revision the range starts after.'),
              head: positional('Revision the range ends at.'),
            },
            strict,
          ),
        ]),
        summary: Type.Optional(
          Type.String({
            minLength: 1,
            description: "Overrides the summary derived from the source.",
          }),
        ),
      },
      strict,
    ),
    result: Type.Object({ envelope: PatchEnvelope }, strict),
  },
  'patch/apply': {
    description: 'Applies a patch envelope; 3-way when the base is missing.',
    params: Type.Object(
      { repoId: Type.String(), envelope: PatchEnvelope },
      strict,
    ),
    result: Type.Object(
      {
        applied: Type.Boolean(),
        conflicts: Type.Boolean(),
        /** True when the envelope's base commit exists in this repository. */
        baseFound: Type.Boolean(),
      },
      strict,
    ),
  },
};
