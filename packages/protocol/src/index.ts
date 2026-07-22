// Wire protocol between the VS Code extension and gitglasses-engine.
// Mirrors the C++ shapes in engine/src (the engine is authoritative until the
// TypeBox -> JSON Schema -> C++ codegen pipeline lands).

export const PROTOCOL_VERSION = '0.1.0';

/** SHA git uses for uncommitted (working tree / dirty buffer) lines. */
export const UNCOMMITTED_SHA = '0'.repeat(40);

// --- JSON-RPC envelope ------------------------------------------------------

export interface RpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: unknown;
}

export interface RpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

export interface RpcError {
  code: number;
  message: string;
}

export interface RpcResponse {
  jsonrpc: '2.0';
  id: number | null;
  result?: unknown;
  error?: RpcError;
}

export type RpcMessage = RpcRequest | RpcNotification | RpcResponse;

export const ErrorCodes = {
  Cancelled: -32800,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  Internal: -32603,
  RepoNotFound: -32000,
  GitError: -32001,
} as const;

// --- Models -----------------------------------------------------------------

export interface RepoInfo {
  repoId: string;
  rootPath: string;
  bare: boolean;
}

export interface HeadState {
  oid: string;
  branch: string;
  detached: boolean;
  unborn: boolean;
}

export interface BlameSignature {
  name: string;
  email: string;
  time: number;
}

export interface BlameCommit {
  author: BlameSignature;
  committer: BlameSignature;
  summary: string;
  boundary: boolean;
}

export interface BlameHunk {
  sha: string;
  /** 1-based first line in the blamed file version. */
  resultLine: number;
  originalLine: number;
  lineCount: number;
  /** Path in the blamed commit (differs across renames). */
  path: string;
  previous?: { sha: string; path: string };
}

// --- Method map -------------------------------------------------------------

export interface CommitSummaryInfo {
  sha: string;
  parents: string[];
  author: BlameSignature;
  committer: BlameSignature;
  summary: string;
}

export interface FileHistoryEntry {
  sha: string;
  author: BlameSignature;
  summary: string;
  /** Path of the file at this commit (differs across renames). */
  path: string;
  additions: number;
  deletions: number;
}

export interface FileChange {
  path: string;
  status: 'M' | 'A' | 'D' | 'R' | 'C' | 'T' | 'U';
  origPath?: string;
  additions: number;
  deletions: number;
}

export interface GraphRef {
  name: string;
  kind: 'head' | 'branch' | 'remote' | 'tag' | 'stash';
  upstream?: { name: string; ahead: number; behind: number };
}

export interface GraphRow {
  sha: string;
  parents: string[];
  /** Column assigned by the engine's deterministic lane layout. */
  lane: number;
  /** Edges drawn through this row: continuing lanes and merge/branch turns. */
  laneEdges: { fromLane: number; toLane: number; kind: 'line' | 'mergeIn' | 'branchOut' }[];
  author: BlameSignature;
  time: number;
  summary: string;
  refs: GraphRef[];
  kind: 'commit' | 'stash' | 'wip';
}

export interface DiffHunk {
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** Unified diff lines including leading ' ', '+', '-'. */
  lines: string[];
}

export interface RebaseEntry {
  action: 'pick' | 'reword' | 'squash' | 'fixup' | 'drop' | 'edit';
  sha: string;
  summary: string;
  /** Replacement message for reword/squash. */
  message?: string;
}

export interface Requests {
  initialize: {
    params: { protocolVersion: string };
    result: { engineVersion: string; protocolVersion: string; capabilities: object };
  };
  shutdown: { params: Record<string, never>; result: Record<string, never> };
  'repo/discover': { params: { path: string }; result: RepoInfo };
  'repo/list': { params: Record<string, never>; result: { repos: RepoInfo[] } };
  'repo/state': { params: { repoId: string }; result: { head: HeadState } };
  'blame/file': {
    params: { repoId: string; path: string; rev?: string; streamId: string };
    result: {
      streamId: string;
      totalLines: number;
      fromCache: boolean;
      commits: Record<string, BlameCommit>;
    };
  };
  /** Topo-ordered commit page from a ref (default HEAD). */
  'log/commits': {
    params: { repoId: string; ref?: string; cursor?: string; limit: number };
    result: { commits: CommitSummaryInfo[]; nextCursor?: string };
  };
  /** File history following renames, newest first. */
  'history/file': {
    params: { repoId: string; path: string; cursor?: string; limit: number };
    result: { entries: FileHistoryEntry[]; nextCursor?: string };
  };
  /** History of a line range (1-based, inclusive). */
  'history/line': {
    params: { repoId: string; path: string; startLine: number; endLine: number };
    result: { entries: FileHistoryEntry[] };
  };
  /** Commit search; matches stream via search/matches notifications. */
  'search/commits': {
    params: {
      repoId: string;
      streamId: string;
      limit: number;
      query: { text?: string; author?: string; sha?: string };
    };
    result: { streamId: string; total: number; truncated: boolean };
  };
  /** Full contents of a file at a revision (virtual docs, quick diff). */
  'rev/fileAtRev': {
    params: { repoId: string; path: string; rev: string };
    result: { contents: string };
  };
  /** Refs listing for views: branches, remotes, tags. */
  'refs/list': {
    params: { repoId: string };
    result: {
      branches: { name: string; sha: string; current: boolean; upstream?: string }[];
      remotes: { name: string; branches: { name: string; sha: string }[] }[];
      tags: { name: string; sha: string }[];
    };
  };
  /** Stash entries. */
  'stash/list': {
    params: { repoId: string };
    result: { entries: { index: number; sha: string; message: string; branch?: string }[] };
  };

  // --- P2: status / graph / diff / staging / mutations / rebase ------------

  'status/summary': {
    params: { repoId: string };
    result: {
      branch: string;
      upstream?: string;
      ahead: number;
      behind: number;
      staged: FileChange[];
      unstaged: FileChange[];
      untracked: string[];
      conflicted: string[];
    };
  };
  /** Graph rows with engine-computed lane layout, topo order, paged. */
  'graph/rows': {
    params: {
      repoId: string;
      cursor?: string;
      limit: number;
      include: { stashes: boolean; wip: boolean };
    };
    result: { rows: GraphRow[]; nextCursor?: string; generation: number };
  };
  'diff/commit': {
    params: { repoId: string; sha: string };
    result: { files: FileChange[] };
  };
  'diff/refs': {
    params: { repoId: string; base: string; head: string };
    result: { files: FileChange[] };
  };
  /** Hunks of a file's working-tree (or staged) diff, for hunk staging. */
  'diff/fileHunks': {
    params: { repoId: string; path: string; staged: boolean };
    result: { hunks: DiffHunk[] };
  };
  'stage/files': {
    params: { repoId: string; paths: string[]; action: 'stage' | 'unstage' };
    result: Record<string, never>;
  };
  'stage/hunks': {
    params: {
      repoId: string;
      path: string;
      action: 'stage' | 'unstage';
      hunks: { oldStart: number; oldLines: number; newStart: number; newLines: number }[];
    };
    result: Record<string, never>;
  };
  'mutate/commit': {
    params: { repoId: string; message: string; amend?: boolean; signoff?: boolean };
    result: { sha: string };
  };
  'mutate/branchCreate': {
    params: { repoId: string; name: string; startPoint?: string; checkout?: boolean };
    result: Record<string, never>;
  };
  'mutate/branchDelete': {
    params: { repoId: string; name: string; force?: boolean };
    result: Record<string, never>;
  };
  'mutate/switch': {
    params: { repoId: string; ref: string };
    result: Record<string, never>;
  };
  'mutate/merge': {
    params: { repoId: string; ref: string; noFf?: boolean };
    result: { conflicts: boolean };
  };
  'mutate/cherryPick': {
    params: { repoId: string; shas: string[] };
    result: { conflicts: boolean };
  };
  'mutate/revert': {
    params: { repoId: string; shas: string[] };
    result: { conflicts: boolean };
  };
  'mutate/reset': {
    params: { repoId: string; ref: string; mode: 'soft' | 'mixed' | 'hard' };
    result: Record<string, never>;
  };
  'mutate/fetch': {
    params: { repoId: string; remote?: string; prune?: boolean };
    result: Record<string, never>;
  };
  'mutate/pull': {
    params: { repoId: string; autoStash?: boolean };
    result: Record<string, never>;
  };
  'mutate/push': {
    params: { repoId: string; setUpstream?: boolean; force?: 'with-lease' };
    result: Record<string, never>;
  };
  'stash/push': {
    params: { repoId: string; message?: string; includeUntracked?: boolean };
    result: Record<string, never>;
  };
  'stash/apply': {
    params: { repoId: string; index: number; pop: boolean };
    result: { conflicts: boolean };
  };
  'stash/drop': {
    params: { repoId: string; index: number };
    result: Record<string, never>;
  };
  'worktree/list': {
    params: { repoId: string };
    result: {
      worktrees: { path: string; branch?: string; sha: string; bare: boolean; locked: boolean }[];
    };
  };
  'worktree/add': {
    params: { repoId: string; path: string; ref: string; createBranch?: string };
    result: Record<string, never>;
  };
  'worktree/remove': {
    params: { repoId: string; path: string; force?: boolean };
    result: Record<string, never>;
  };
  /** Commits upstream..HEAD, oldest first — the editable rebase plan. */
  'rebase/preview': {
    params: { repoId: string; upstream: string };
    result: { entries: { sha: string; summary: string }[] };
  };
  /** Executes an interactive rebase with the given plan via sequence-editor
   * interception. Conflicts pause the rebase (sequencer state watchable). */
  'rebase/start': {
    params: { repoId: string; upstream: string; plan: RebaseEntry[] };
    result: { conflicts: boolean; completed: boolean };
  };
  'rebase/continue': {
    params: { repoId: string };
    result: { conflicts: boolean; completed: boolean };
  };
  'rebase/abort': {
    params: { repoId: string };
    result: Record<string, never>;
  };

  // --- P4: remotes / open patches ------------------------------------------

  'remote/list': {
    params: { repoId: string };
    result: { remotes: { name: string; fetchUrl: string; pushUrl?: string }[] };
  };
  /** Creates a shareable patch envelope from WIP, a stash, a commit, or a range. */
  'patch/create': {
    params: {
      repoId: string;
      source:
        | { kind: 'wip'; includeUntracked?: boolean }
        | { kind: 'stash'; index: number }
        | { kind: 'commit'; sha: string }
        | { kind: 'range'; base: string; head: string };
      summary?: string;
    };
    result: { envelope: PatchEnvelope };
  };
  /** Applies a patch envelope; 3-way when the base is missing. */
  'patch/apply': {
    params: { repoId: string; envelope: PatchEnvelope };
    result: { applied: boolean; conflicts: boolean; baseFound: boolean };
  };
}

export interface PatchEnvelope {
  format: 'gitglasses-patch';
  version: 1;
  /** Commit the diff applies onto. */
  baseSha: string;
  branch?: string;
  summary: string;
  /** Unified diff text (git diff/format-patch output). */
  patch: string;
  /** Fingerprint of origin remote URL (sha256 hex, first 16) for repo matching. */
  remoteFingerprint?: string;
  createdAtIso: string;
}

export type RequestMethod = keyof Requests;
export type RequestParams<M extends RequestMethod> = Requests[M]['params'];
export type RequestResult<M extends RequestMethod> = Requests[M]['result'];

export interface ClientNotifications {
  'doc/didChange': {
    params: { repoId: string; path: string; contents: string; version: number };
  };
  'doc/didClose': { params: { repoId: string; path: string } };
  '$/cancelRequest': { params: { id: number } };
}

export interface EngineNotifications {
  'blame/hunks': { params: { streamId: string; hunks: BlameHunk[] } };
  'search/matches': { params: { streamId: string; matches: CommitSummaryInfo[] } };
  /** Pushed when the repo's git state changes (refs, HEAD, index, stash). */
  'repo/didChange': {
    params: {
      repoId: string;
      generation: number;
      changed: ('HEAD' | 'refs' | 'index' | 'stash' | 'worktrees' | 'sequencer')[];
    };
  };
}

export type EngineNotificationMethod = keyof EngineNotifications;
export type EngineNotificationParams<M extends EngineNotificationMethod> =
  EngineNotifications[M]['params'];
