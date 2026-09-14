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
  strict,
} from './models.js';

/** `Record<string, never>` on the TS side: an object with no members. */
export const EmptyObject = Type.Object({}, strict);

const StageAction = Type.Union([Type.Literal('stage'), Type.Literal('unstage')]);

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
    params: Type.Object({ protocolVersion: Type.String() }, strict),
    result: Type.Object(
      {
        engineVersion: Type.String(),
        protocolVersion: Type.String(),
        capabilities: EngineCapabilities,
      },
      strict,
    ),
  },
  shutdown: { params: EmptyObject, result: EmptyObject },
  'repo/discover': {
    params: Type.Object({ path: Type.String() }, strict),
    result: RepoInfo,
  },
  'repo/close': {
    params: Type.Object({ repoId: Type.String() }, strict),
    result: EmptyObject,
  },
  'repo/list': {
    params: EmptyObject,
    result: Type.Object({ repos: Type.Array(RepoInfo) }, strict),
  },
  'repo/state': {
    params: Type.Object({ repoId: Type.String() }, strict),
    result: Type.Object({ head: HeadState }, strict),
  },
  'blame/file': {
    params: Type.Object(
      {
        repoId: Type.String(),
        path: Type.String(),
        rev: Type.Optional(Type.String()),
        streamId: Type.String(),
      },
      strict,
    ),
    result: Type.Object(
      {
        streamId: Type.String(),
        totalLines: Type.Number(),
        fromCache: Type.Boolean(),
        commits: Type.Record(Type.String(), BlameCommit),
      },
      strict,
    ),
  },
  'log/commits': {
    params: Type.Object(
      {
        repoId: Type.String(),
        ref: Type.Optional(Type.String()),
        cursor: Type.Optional(Type.String()),
        limit: Type.Number(),
      },
      strict,
    ),
    result: Type.Object(
      {
        commits: Type.Array(CommitSummaryInfo),
        nextCursor: Type.Optional(Type.String()),
      },
      strict,
    ),
  },
  'history/file': {
    params: Type.Object(
      {
        repoId: Type.String(),
        path: Type.String(),
        cursor: Type.Optional(Type.String()),
        limit: Type.Number(),
      },
      strict,
    ),
    result: Type.Object(
      {
        entries: Type.Array(FileHistoryEntry),
        nextCursor: Type.Optional(Type.String()),
      },
      strict,
    ),
  },
  'history/line': {
    params: Type.Object(
      {
        repoId: Type.String(),
        path: Type.String(),
        startLine: Type.Number(),
        endLine: Type.Number(),
      },
      strict,
    ),
    result: Type.Object({ entries: Type.Array(FileHistoryEntry) }, strict),
  },
  'search/commits': {
    params: Type.Object(
      {
        repoId: Type.String(),
        streamId: Type.String(),
        limit: Type.Number(),
        query: Type.Object(
          {
            text: Type.Optional(Type.String()),
            author: Type.Optional(Type.String()),
            sha: Type.Optional(Type.String()),
          },
          strict,
        ),
      },
      strict,
    ),
    result: Type.Object(
      {
        streamId: Type.String(),
        total: Type.Number(),
        truncated: Type.Boolean(),
      },
      strict,
    ),
  },
  'rev/fileAtRev': {
    params: Type.Object(
      { repoId: Type.String(), path: Type.String(), rev: Type.String() },
      strict,
    ),
    result: Type.Object({ contents: Type.String() }, strict),
  },
  'refs/list': {
    params: Type.Object({ repoId: Type.String() }, strict),
    result: Type.Object(
      {
        branches: Type.Array(
          Type.Object(
            {
              name: Type.String(),
              sha: Type.String(),
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
              branches: Type.Array(
                Type.Object({ name: Type.String(), sha: Type.String() }, strict),
              ),
            },
            strict,
          ),
        ),
        tags: Type.Array(
          Type.Object({ name: Type.String(), sha: Type.String() }, strict),
        ),
      },
      strict,
    ),
  },
  'stash/list': {
    params: Type.Object({ repoId: Type.String() }, strict),
    result: Type.Object(
      {
        entries: Type.Array(
          Type.Object(
            {
              index: Type.Number(),
              sha: Type.String(),
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
    params: Type.Object({ repoId: Type.String() }, strict),
    result: Type.Object(
      {
        branch: Type.String(),
        upstream: Type.Optional(Type.String()),
        ahead: Type.Number(),
        behind: Type.Number(),
        staged: Type.Array(FileChange),
        unstaged: Type.Array(FileChange),
        untracked: Type.Array(Type.String()),
        conflicted: Type.Array(Type.String()),
      },
      strict,
    ),
  },
  'graph/rows': {
    params: Type.Object(
      {
        repoId: Type.String(),
        cursor: Type.Optional(Type.String()),
        limit: Type.Number(),
        include: Type.Object(
          { stashes: Type.Boolean(), wip: Type.Boolean() },
          strict,
        ),
      },
      strict,
    ),
    result: Type.Object(
      {
        rows: Type.Array(GraphRow),
        nextCursor: Type.Optional(Type.String()),
        generation: Type.Number(),
      },
      strict,
    ),
  },
  'diff/commit': {
    params: Type.Object({ repoId: Type.String(), sha: Type.String() }, strict),
    result: Type.Object({ files: Type.Array(FileChange) }, strict),
  },
  'diff/refs': {
    params: Type.Object(
      { repoId: Type.String(), base: Type.String(), head: Type.String() },
      strict,
    ),
    result: Type.Object({ files: Type.Array(FileChange) }, strict),
  },
  'diff/fileHunks': {
    params: Type.Object(
      { repoId: Type.String(), path: Type.String(), staged: Type.Boolean() },
      strict,
    ),
    result: Type.Object({ hunks: Type.Array(DiffHunk) }, strict),
  },
  'stage/files': {
    params: Type.Object(
      { repoId: Type.String(), paths: Type.Array(Type.String()), action: StageAction },
      strict,
    ),
    result: EmptyObject,
  },
  'stage/hunks': {
    params: Type.Object(
      {
        repoId: Type.String(),
        path: Type.String(),
        action: StageAction,
        hunks: Type.Array(
          Type.Object(
            {
              oldStart: Type.Number(),
              oldLines: Type.Number(),
              newStart: Type.Number(),
              newLines: Type.Number(),
            },
            strict,
          ),
        ),
      },
      strict,
    ),
    result: EmptyObject,
  },
  'mutate/commit': {
    params: Type.Object(
      {
        repoId: Type.String(),
        message: Type.String(),
        amend: Type.Optional(Type.Boolean()),
        signoff: Type.Optional(Type.Boolean()),
      },
      strict,
    ),
    result: Type.Object({ sha: Type.String() }, strict),
  },
  'mutate/branchCreate': {
    params: Type.Object(
      {
        repoId: Type.String(),
        name: Type.String(),
        startPoint: Type.Optional(Type.String()),
        checkout: Type.Optional(Type.Boolean()),
      },
      strict,
    ),
    result: EmptyObject,
  },
  'mutate/branchDelete': {
    params: Type.Object(
      {
        repoId: Type.String(),
        name: Type.String(),
        force: Type.Optional(Type.Boolean()),
      },
      strict,
    ),
    result: EmptyObject,
  },
  'mutate/switch': {
    params: Type.Object({ repoId: Type.String(), ref: Type.String() }, strict),
    result: EmptyObject,
  },
  'mutate/merge': {
    params: Type.Object(
      {
        repoId: Type.String(),
        ref: Type.String(),
        noFf: Type.Optional(Type.Boolean()),
      },
      strict,
    ),
    result: Type.Object({ conflicts: Type.Boolean() }, strict),
  },
  'mutate/cherryPick': {
    params: Type.Object(
      { repoId: Type.String(), shas: Type.Array(Type.String()) },
      strict,
    ),
    result: Type.Object({ conflicts: Type.Boolean() }, strict),
  },
  'mutate/revert': {
    params: Type.Object(
      { repoId: Type.String(), shas: Type.Array(Type.String()) },
      strict,
    ),
    result: Type.Object({ conflicts: Type.Boolean() }, strict),
  },
  'mutate/reset': {
    params: Type.Object(
      {
        repoId: Type.String(),
        ref: Type.String(),
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
    params: Type.Object(
      {
        repoId: Type.String(),
        remote: Type.Optional(Type.String()),
        prune: Type.Optional(Type.Boolean()),
      },
      strict,
    ),
    result: EmptyObject,
  },
  'mutate/pull': {
    params: Type.Object(
      { repoId: Type.String(), autoStash: Type.Optional(Type.Boolean()) },
      strict,
    ),
    result: EmptyObject,
  },
  'mutate/push': {
    params: Type.Object(
      {
        repoId: Type.String(),
        setUpstream: Type.Optional(Type.Boolean()),
        force: Type.Optional(Type.Literal('with-lease')),
      },
      strict,
    ),
    result: EmptyObject,
  },
  'stash/push': {
    params: Type.Object(
      {
        repoId: Type.String(),
        message: Type.Optional(Type.String()),
        includeUntracked: Type.Optional(Type.Boolean()),
      },
      strict,
    ),
    result: EmptyObject,
  },
  'stash/apply': {
    params: Type.Object(
      { repoId: Type.String(), index: Type.Number(), pop: Type.Boolean() },
      strict,
    ),
    result: Type.Object({ conflicts: Type.Boolean() }, strict),
  },
  'stash/drop': {
    params: Type.Object({ repoId: Type.String(), index: Type.Number() }, strict),
    result: EmptyObject,
  },
  'worktree/list': {
    params: Type.Object({ repoId: Type.String() }, strict),
    result: Type.Object(
      {
        worktrees: Type.Array(
          Type.Object(
            {
              path: Type.String(),
              branch: Type.Optional(Type.String()),
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
    params: Type.Object(
      {
        repoId: Type.String(),
        path: Type.String(),
        ref: Type.String(),
        createBranch: Type.Optional(Type.String()),
      },
      strict,
    ),
    result: EmptyObject,
  },
  'worktree/remove': {
    params: Type.Object(
      {
        repoId: Type.String(),
        path: Type.String(),
        force: Type.Optional(Type.Boolean()),
      },
      strict,
    ),
    result: EmptyObject,
  },
  'rebase/preview': {
    params: Type.Object(
      { repoId: Type.String(), upstream: Type.String() },
      strict,
    ),
    result: Type.Object(
      {
        entries: Type.Array(
          Type.Object({ sha: Type.String(), summary: Type.String() }, strict),
        ),
      },
      strict,
    ),
  },
  'rebase/start': {
    params: Type.Object(
      {
        repoId: Type.String(),
        upstream: Type.String(),
        plan: Type.Array(RebaseEntry),
      },
      strict,
    ),
    result: Type.Object(
      { conflicts: Type.Boolean(), completed: Type.Boolean() },
      strict,
    ),
  },
  'rebase/continue': {
    params: Type.Object({ repoId: Type.String() }, strict),
    result: Type.Object(
      { conflicts: Type.Boolean(), completed: Type.Boolean() },
      strict,
    ),
  },
  'rebase/abort': {
    params: Type.Object({ repoId: Type.String() }, strict),
    result: EmptyObject,
  },

  // --- P4: remotes / open patches ------------------------------------------

  'remote/list': {
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
          Type.Object(
            { kind: Type.Literal('stash'), index: Type.Number() },
            strict,
          ),
          Type.Object({ kind: Type.Literal('commit'), sha: Type.String() }, strict),
          Type.Object(
            {
              kind: Type.Literal('range'),
              base: Type.String(),
              head: Type.String(),
            },
            strict,
          ),
        ]),
        summary: Type.Optional(Type.String()),
      },
      strict,
    ),
    result: Type.Object({ envelope: PatchEnvelope }, strict),
  },
  'patch/apply': {
    params: Type.Object(
      { repoId: Type.String(), envelope: PatchEnvelope },
      strict,
    ),
    result: Type.Object(
      {
        applied: Type.Boolean(),
        conflicts: Type.Boolean(),
        baseFound: Type.Boolean(),
      },
      strict,
    ),
  },
};
