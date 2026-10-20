// Typed postMessage protocol between the extension host and the graph and
// commit details webviews. Protocol types are imported type-only so the
// browser bundles carry no runtime code from the protocol package, and the
// host imports these declarations too, so both sides agree on every message.

import type {
  CommitDetails,
  CommitFileChange,
  FileChange,
  GraphRef,
  GraphRow,
} from '@gitglasses/protocol';
import type { BranchOption, FindMatch, RefMenuAction, RowMenuAction } from './graphLogic';
import type { ProvenanceFilter } from '../../src/provenance/provenanceLogic';

export type {
  BranchOption,
  CommitDetails,
  CommitFileChange,
  FileChange,
  FindMatch,
  GraphRef,
  GraphRow,
};

// --- Provenance -------------------------------------------------------------

/** What a commit declares about who wrote it, as the graph and the details
 *  view show it. Only commits that declare something have one. */
export interface ProvenanceMark {
  /** An AI agent is declared. */
  agent: boolean;
  /** 'AI-authored', 'AI-assisted' or 'Human-written'. */
  label: string;
  /** "Co-authored-by: Claude Opus 4.7". */
  via: string;
  /** "AI-assisted (declared via Co-authored-by: Claude Opus 4.7)". */
  text: string;
  /** Every declaration, one per line, for tooltips. */
  lines: string[];
  /** An http(s) link to the agent session: rendered, never fetched. */
  sessionUrl?: string;
}

// --- Details --------------------------------------------------------------

/** What the details pane (and the Commit Details panel) shows. */
export type DetailsView =
  | {
      kind: 'commit';
      details: CommitDetails;
      /** stash@{n} when the commit is a stash entry. */
      stash?: { index: number };
      /** Declared provenance; absent when none is declared or it is turned off. */
      provenance?: ProvenanceMark;
    }
  | {
      kind: 'compare';
      /** The older commit, the left side of every diff. */
      base: { sha: string; subject: string };
      /** The newer commit, the right side of every diff. */
      head: { sha: string; subject: string };
      files: FileChange[];
    }
  | {
      kind: 'wip';
      staged: FileChange[];
      unstaged: FileChange[];
      untracked: string[];
      conflicted: string[];
    }
  | { kind: 'error'; message: string };

/** What the details pane asks the host for. */
export type DetailsTarget =
  | { kind: 'commit'; sha: string }
  | { kind: 'compare'; base: string; head: string }
  | { kind: 'wip' };

/** One file to open in a diff editor. */
export type FileTarget =
  | { kind: 'commit'; sha: string; file: CommitFileChange }
  | { kind: 'compare'; base: string; head: string; file: FileChange }
  | { kind: 'wip'; path: string; origPath?: string; status: string; untracked: boolean };

/** Every file of a commit or comparison, for one multi-file diff editor. */
export type ChangesTarget =
  { kind: 'commit'; sha: string } | { kind: 'compare'; base: string; head: string };

/** Messages the details renderer posts, shared by the graph pane and the
 *  Commit Details panel. */
export type DetailsToHostMessage =
  | { type: 'openFile'; target: FileTarget }
  | { type: 'openChanges'; target: ChangesTarget }
  | { type: 'copy'; text: string; label: string }
  /** A parent sha was clicked. */
  | { type: 'showCommit'; sha: string };

// --- Graph ----------------------------------------------------------------

/** What the graph webview keeps across reloads (vscode.setState), and what
 *  the panel serializer restores. */
export interface GraphViewState {
  /** The repository the state belongs to. */
  repoRoot?: string;
  /** The commit at the top of the viewport. */
  topSha?: string;
  /** How many rows were loaded, so a restore can load as many at once. */
  loaded?: number;
  selected?: string[];
  /** Full ref names the graph is filtered to; absent for every branch. */
  filter?: string[];
  detailsOpen?: boolean;
  /** Share of the panel height the details pane takes. */
  detailsShare?: number;
  query?: string;
  /** The declared-provenance filter. */
  provenanceFilter?: ProvenanceFilter;
}

export type HostToWebviewMessage =
  /** A (possibly different) repository: drop every row and start over. */
  | {
      type: 'reset';
      generation: number;
      repoName: string;
      repoRoot: string;
      /** False in Restricted Mode: menus leave out what changes the repository. */
      canMutate: boolean;
      maxLanes: number;
      filter?: string[];
      /** The webview's saved state belongs to this repository: apply it, if
       *  not applied yet, once its rows are loaded. */
      restore?: boolean;
      /** Declared provenance is shown (gitglasses.provenance.enabled). */
      provenance?: boolean;
    }
  /** A page of rows. `replace` swaps out every loaded row (a refresh) and
   *  keeps the selection and scroll position on the same commits. */
  | {
      type: 'rows';
      generation: number;
      rows: GraphRow[];
      nextCursor?: string;
      replace: boolean;
    }
  | { type: 'branches'; branches: BranchOption[] }
  | { type: 'details'; requestId: number; view: DetailsView }
  /** Every row of the graph's walk that matches `query`, in row order.
   *  `failed` means the search could not run; matches is then empty. */
  | {
      type: 'findResults';
      query: string;
      matches: FindMatch[];
      truncated: boolean;
      failed?: boolean;
    }
  /** The working tree changed: a shown WIP details view is out of date. */
  | { type: 'wipChanged' }
  | { type: 'settings'; maxLanes: number; canMutate: boolean; provenance?: boolean }
  /** Declared provenance of loaded commits, keyed by sha; null for a commit
   *  that declares nothing. */
  | { type: 'provenance'; marks: Record<string, ProvenanceMark | null> }
  | { type: 'theme' }
  /** Why the graph is empty: no repository, or a failed graph/rows. */
  | { type: 'error'; message: string };

/** Graph mutation actions the context menu can request from the host. */
export type GraphActionId = Extract<
  RowMenuAction,
  | 'createBranch'
  | 'createTag'
  | 'switchDetached'
  | 'cherryPick'
  | 'revert'
  | 'reset'
  | 'merge'
  | 'rebase'
  | 'stashChanges'
  | 'stashApply'
  | 'stashPop'
  | 'stashDrop'
  | 'openScm'
>;

export type WebviewToHostMessage =
  | DetailsToHostMessage
  | { type: 'ready'; state?: GraphViewState }
  /** The next page; `limit` asks for more rows than a page at once, to
   *  reach a row further down. */
  | { type: 'loadMore'; generation: number; cursor: string; limit?: number }
  | { type: 'refresh' }
  /** The repository name was clicked: offer Select Repository. */
  | { type: 'selectRepository' }
  | { type: 'details'; requestId: number; target: DetailsTarget }
  | { type: 'find'; query: string }
  | { type: 'setFilter'; refs?: string[] }
  | { type: 'action'; generation: number; action: GraphActionId; shas: string[] }
  | {
      type: 'refAction';
      generation: number;
      action: Exclude<RefMenuAction, 'copyName'>;
      ref: GraphRef;
      sha: string;
    };

// --- Commit Details panel ---------------------------------------------------

/** What the Commit Details panel keeps across reloads. */
export interface CommitPanelState {
  repoPath: string;
  sha: string;
}

export type HostToCommitPanelMessage =
  { type: 'show'; view: DetailsView; state: CommitPanelState } | { type: 'loading' };
