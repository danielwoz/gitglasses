// Wire protocol between the VS Code extension and gitglasses-engine.
// Schema-first: the TypeBox schemas in src/schema are the source of truth;
// the types below derive from them via Static<>, and protocol.schema.json is
// emitted from them. engine/tests drives a live engine through the read
// methods against that artifact, checking both its responses and its
// rejection of params the schemas forbid.

import type { Static } from '@sinclair/typebox';

import * as models from './schema/models.js';
import {
  ClientNotificationSchemas,
  EngineNotificationSchemas,
} from './schema/notifications.js';
import { RequestSchemas } from './schema/requests.js';
import { EngineRequestSchemas } from './schema/engineRequests.js';

export { PROTOCOL_VERSION } from './version.js';

// The TypeBox schemas themselves, so consumers can validate at runtime.
export { models };
export { patchEnvelopeError, schemaError } from './validate.js';
export {
  COMMIT_DETAILS_MAX_FILES,
  COMMIT_PROVENANCE_MAX_SHAS,
  NOTES_READ_MAX_SHAS,
  RESTRICTED_MODE_METHODS,
} from './schema/requests.js';

// Sha helpers also have their own lean entry point: @gitglasses/protocol/sha.
export { SHORT_SHA_LENGTH, UNCOMMITTED_SHA, shortSha } from './sha.js';

// --- JSON-RPC envelope ------------------------------------------------------
// Hand-written: JSON-RPC boilerplate carrying open `unknown` payloads.

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
  /** Structured detail; for GitError, a GitErrorData. */
  data?: unknown;
}

export interface RpcResponse {
  jsonrpc: '2.0';
  /** Integer for answers to the client's requests; requests the engine sends
   *  carry string ids. */
  id: number | string | null;
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
  /** Method requires a capability this engine build lacks (e.g. gitCli). */
  MethodNotSupported: -32003,
  /** The engine runs in Restricted Mode (capabilities.restricted) and the
   *  method would run git or change the repository. */
  Restricted: -32004,
  /** The path goes through a filter driver (Git LFS, git-crypt, a custom
   *  clean filter) or a working-tree-encoding that only the git CLI can
   *  apply, and this engine has no git CLI. Other paths still work. */
  FilterNeedsGitCli: -32010,
  /** The path's change cannot be split into hunks (a submodule, or a Git LFS
   *  pointer); stage or unstage the whole file instead. */
  WholeFileOnly: -32011,
} as const;

// --- Models (derived from src/schema/models.ts) -----------------------------

export type RepoInfo = Static<typeof models.RepoInfo>;
export type HeadState = Static<typeof models.HeadState>;
export type BlameSignature = Static<typeof models.BlameSignature>;
export type BlameCommit = Static<typeof models.BlameCommit>;
export type BlameHunk = Static<typeof models.BlameHunk>;
export type BlameOptions = Static<typeof models.BlameOptions>;
export type BlameMoveDetection = NonNullable<BlameOptions['moves']>;
export type CommitSummaryInfo = Static<typeof models.CommitSummaryInfo>;
export type CommitDetails = Static<typeof models.CommitDetails>;
export type CommitFileChange = Static<typeof models.CommitFileChange>;
export type CommitRef = Static<typeof models.CommitRef>;
export type CommitTrailer = Static<typeof models.CommitTrailer>;
export type CommitProvenance = Static<typeof models.CommitProvenance>;
export type ProvenanceDeclaration = Static<typeof models.ProvenanceDeclaration>;
export type FileHistoryEntry = Static<typeof models.FileHistoryEntry>;
export type FileChange = Static<typeof models.FileChange>;
export type GraphRef = Static<typeof models.GraphRef>;
export type GraphRow = Static<typeof models.GraphRow>;
export type DiffHunk = Static<typeof models.DiffHunk>;
export type RebaseEntry = Static<typeof models.RebaseEntry>;
export type PatchEnvelope = Static<typeof models.PatchEnvelope>;
export type PatchFileChange = Static<typeof models.PatchFileChange>;
export type SequencerState = Static<typeof models.SequencerState>;
export type SequencerOperation = Static<typeof models.SequencerOperation>;
export type GitErrorKind = Static<typeof models.GitErrorKind>;
export type GitErrorData = Static<typeof models.GitErrorData>;
export type AskpassKind = Static<typeof models.AskpassKind>;

// --- Method map (derived from src/schema/requests.ts) -----------------------

type Method = keyof typeof RequestSchemas;
type P<M extends Method> = Static<(typeof RequestSchemas)[M]['params']>;
type R<M extends Method> = Static<(typeof RequestSchemas)[M]['result']>;
// Hand-written: `Static<>` of an empty `Type.Object` is `{}`, which accepts
// any object, so empty payloads carry this type instead.
type Empty = Record<string, never>;

/** Typed engine capability flags (open bag: engines may add more). */
export interface EngineCapabilities {
  gitCli: boolean;
  /** Restricted Mode: only RESTRICTED_MODE_METHODS are served. */
  restricted?: boolean;
  watch: boolean;
  threads: boolean;
  [key: string]: unknown;
}

// Per-method prose lives with the schemas in src/schema/requests.ts, so it
// reaches protocol.schema.json.
export interface Requests {
  initialize: {
    params: P<'initialize'>;
    // Hand-written result: Static<> of an open-bag object widens poorly.
    result: { engineVersion: string; protocolVersion: string; capabilities: EngineCapabilities };
  };
  shutdown: { params: Empty; result: Empty };
  'repo/discover': { params: P<'repo/discover'>; result: R<'repo/discover'> };
  'repo/list': { params: Empty; result: R<'repo/list'> };
  'repo/state': { params: P<'repo/state'>; result: R<'repo/state'> };
  'repo/close': { params: P<'repo/close'>; result: Empty };
  'blame/file': { params: P<'blame/file'>; result: R<'blame/file'> };
  'log/commits': { params: P<'log/commits'>; result: R<'log/commits'> };
  'commit/details': { params: P<'commit/details'>; result: R<'commit/details'> };
  'commit/provenance': { params: P<'commit/provenance'>; result: R<'commit/provenance'> };
  'notes/read': { params: P<'notes/read'>; result: R<'notes/read'> };
  'notes/addFetchRefspec': {
    params: P<'notes/addFetchRefspec'>;
    result: R<'notes/addFetchRefspec'>;
  };
  'history/file': { params: P<'history/file'>; result: R<'history/file'> };
  'history/line': { params: P<'history/line'>; result: R<'history/line'> };
  'search/commits': { params: P<'search/commits'>; result: R<'search/commits'> };
  'search/log': { params: P<'search/log'>; result: R<'search/log'> };
  'rev/fileAtRev': { params: P<'rev/fileAtRev'>; result: R<'rev/fileAtRev'> };
  'refs/list': { params: P<'refs/list'>; result: R<'refs/list'> };
  'stash/list': { params: P<'stash/list'>; result: R<'stash/list'> };

  // --- P2: status / graph / diff / staging / mutations / rebase ------------

  'status/summary': { params: P<'status/summary'>; result: R<'status/summary'> };
  'graph/rows': { params: P<'graph/rows'>; result: R<'graph/rows'> };
  'graph/find': { params: P<'graph/find'>; result: R<'graph/find'> };
  'diff/commit': { params: P<'diff/commit'>; result: R<'diff/commit'> };
  'diff/refs': { params: P<'diff/refs'>; result: R<'diff/refs'> };
  'diff/fileHunks': { params: P<'diff/fileHunks'>; result: R<'diff/fileHunks'> };
  'stage/files': { params: P<'stage/files'>; result: Empty };
  'stage/hunks': { params: P<'stage/hunks'>; result: Empty };
  'mutate/commit': { params: P<'mutate/commit'>; result: R<'mutate/commit'> };
  'mutate/branchCreate': { params: P<'mutate/branchCreate'>; result: Empty };
  'mutate/branchDelete': { params: P<'mutate/branchDelete'>; result: Empty };
  'mutate/switch': { params: P<'mutate/switch'>; result: Empty };
  'mutate/merge': { params: P<'mutate/merge'>; result: R<'mutate/merge'> };
  'mutate/cherryPick': { params: P<'mutate/cherryPick'>; result: R<'mutate/cherryPick'> };
  'mutate/revert': { params: P<'mutate/revert'>; result: R<'mutate/revert'> };
  'mutate/reset': { params: P<'mutate/reset'>; result: Empty };
  'mutate/fetch': { params: P<'mutate/fetch'>; result: Empty };
  'mutate/pull': { params: P<'mutate/pull'>; result: R<'mutate/pull'> };
  'mutate/push': { params: P<'mutate/push'>; result: R<'mutate/push'> };
  'mutate/sequencer': { params: P<'mutate/sequencer'>; result: R<'mutate/sequencer'> };
  'stash/push': { params: P<'stash/push'>; result: Empty };
  'stash/apply': { params: P<'stash/apply'>; result: R<'stash/apply'> };
  'stash/drop': { params: P<'stash/drop'>; result: Empty };
  'worktree/list': { params: P<'worktree/list'>; result: R<'worktree/list'> };
  'worktree/add': { params: P<'worktree/add'>; result: Empty };
  'worktree/remove': { params: P<'worktree/remove'>; result: Empty };
  'rebase/preview': { params: P<'rebase/preview'>; result: R<'rebase/preview'> };
  'rebase/start': { params: P<'rebase/start'>; result: R<'rebase/start'> };
  'rebase/continue': { params: P<'rebase/continue'>; result: R<'rebase/continue'> };
  'rebase/skip': { params: P<'rebase/skip'>; result: R<'rebase/skip'> };
  'rebase/abort': { params: P<'rebase/abort'>; result: Empty };
  'branch/rename': { params: P<'branch/rename'>; result: Empty };
  'branch/setUpstream': { params: P<'branch/setUpstream'>; result: Empty };
  'branch/push': { params: P<'branch/push'>; result: R<'branch/push'> };
  'tag/create': { params: P<'tag/create'>; result: Empty };
  'tag/delete': { params: P<'tag/delete'>; result: Empty };
  'tag/push': { params: P<'tag/push'>; result: Empty };
  'remote/add': { params: P<'remote/add'>; result: Empty };
  'remote/remove': { params: P<'remote/remove'>; result: Empty };

  // --- P4: remotes / open patches ------------------------------------------

  'remote/list': { params: P<'remote/list'>; result: R<'remote/list'> };
  'patch/create': { params: P<'patch/create'>; result: R<'patch/create'> };
  'patch/apply': { params: P<'patch/apply'>; result: R<'patch/apply'> };
}

export type RequestMethod = keyof Requests;
export type RequestParams<M extends RequestMethod> = Requests[M]['params'];
export type RequestResult<M extends RequestMethod> = Requests[M]['result'];

// --- Notifications (derived from src/schema/notifications.ts) ---------------

export interface ClientNotifications {
  'doc/didChange': {
    params: Static<(typeof ClientNotificationSchemas)['doc/didChange']['params']>;
  };
  'doc/didClose': {
    params: Static<(typeof ClientNotificationSchemas)['doc/didClose']['params']>;
  };
  '$/cancelRequest': {
    params: Static<(typeof ClientNotificationSchemas)['$/cancelRequest']['params']>;
  };
}

export interface EngineNotifications {
  'blame/hunks': {
    params: Static<(typeof EngineNotificationSchemas)['blame/hunks']['params']>;
  };
  'search/matches': {
    params: Static<(typeof EngineNotificationSchemas)['search/matches']['params']>;
  };
  'repo/didChange': {
    params: Static<(typeof EngineNotificationSchemas)['repo/didChange']['params']>;
  };
  'ui/askpassCancelled': {
    params: Static<(typeof EngineNotificationSchemas)['ui/askpassCancelled']['params']>;
  };
}

export type EngineNotificationMethod = keyof EngineNotifications;
export type EngineNotificationParams<M extends EngineNotificationMethod> =
  EngineNotifications[M]['params'];

// --- Engine-to-client requests (derived from src/schema/engineRequests.ts) ---

export interface EngineRequests {
  'ui/askpass': {
    params: Static<(typeof EngineRequestSchemas)['ui/askpass']['params']>;
    result: Static<(typeof EngineRequestSchemas)['ui/askpass']['result']>;
  };
}

export type EngineRequestMethod = keyof EngineRequests;
export type EngineRequestParams<M extends EngineRequestMethod> = EngineRequests[M]['params'];
export type EngineRequestResult<M extends EngineRequestMethod> = EngineRequests[M]['result'];

/** Client capabilities sent with initialize. */
export type ClientCapabilities = NonNullable<P<'initialize'>['clientCapabilities']>;
