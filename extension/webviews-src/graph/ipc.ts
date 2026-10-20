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

export type { CommitDetails, CommitFileChange, FileChange, GraphRef, GraphRow };

// --- Details --------------------------------------------------------------

/** What the details pane (and the Commit Details panel) shows. */
export type DetailsView =
  | {
      kind: 'commit';
      details: CommitDetails;
      /** stash@{n} when the commit is a stash entry. */
      stash?: { index: number };
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

export type HostToWebviewMessage =
  | { type: 'reset' }
  | { type: 'rows'; rows: GraphRow[]; nextCursor?: string }
  | { type: 'theme' }
  /** Why the graph is empty: no repository, or a failed graph/rows. */
  | { type: 'error'; message: string };

/** Graph mutation actions the context menu can request from the host. */
export type GraphActionId =
  'createBranch' | 'switchDetached' | 'cherryPick' | 'revert' | 'reset' | 'merge' | 'rebase';

export type WebviewToHostMessage =
  | { type: 'ready' }
  | { type: 'loadMore'; cursor: string }
  | { type: 'select'; shas: string[] }
  | { type: 'openCommit'; sha: string }
  | { type: 'copySha'; sha: string }
  | { type: 'action'; action: GraphActionId; shas: string[] };

// --- Commit Details panel ---------------------------------------------------

/** What the Commit Details panel keeps across reloads. */
export interface CommitPanelState {
  repoPath: string;
  sha: string;
}

export type HostToCommitPanelMessage =
  { type: 'show'; view: DetailsView; state: CommitPanelState } | { type: 'loading' };
