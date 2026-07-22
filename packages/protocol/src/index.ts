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
