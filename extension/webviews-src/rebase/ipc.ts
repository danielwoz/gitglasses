// Typed postMessage protocol between the extension host and the interactive
// rebase editor webview. RebaseEntry is imported type-only so the browser
// bundle carries no runtime code from the protocol package.

import type { RebaseEntry } from '@gitglasses/protocol';
import type { PlanAction } from './rebaseLogic';

export type { RebaseEntry };

/** The plan to edit: from rebase/preview, or (mode 'todo') from the todo
 *  list of a `git rebase -i` that is waiting for its editor. */
export interface RebaseInit {
  mode?: 'plan' | 'todo';
  upstream: string;
  branch: string;
  entries: { sha: string; summary: string; action?: PlanAction }[];
  /** Merge commits in the range, which the rebase flattens. */
  mergeCount: number;
  /** Uncommitted changes will be stashed and restored around the rebase. */
  autoStash: boolean;
  /** Keep the actions already chosen for commits that are still there. */
  keepPlan: boolean;
}

/** A rebase stopped part-way: on conflicts, at an edit step, or on an error
 *  that left git's rebase state behind. */
export interface RebasePaused {
  step?: number;
  total?: number;
  /** Why git stopped, when known: on conflicts (possibly resolved since), or
   *  at a step that stops on purpose, such as edit. */
  reason?: 'conflicts' | 'stopped';
  conflicted: string[];
  /** git's explanation when the stop came with a failure. */
  error?: string;
}

export type HostToWebviewMessage =
  | ({ type: 'init' } & RebaseInit)
  | { type: 'busy'; busy: boolean }
  | { type: 'stale'; reason: string }
  | ({ type: 'paused' } & RebasePaused)
  | { type: 'error'; message: string }
  | { type: 'message'; sha: string; message: string };

export type WebviewToHostMessage =
  | { type: 'ready' }
  | { type: 'start'; plan: RebaseEntry[] }
  | { type: 'cancel' }
  | { type: 'reload' }
  | { type: 'continue' }
  | { type: 'skip' }
  | { type: 'abort' }
  | { type: 'openFile'; path: string }
  | { type: 'markResolved'; path: string }
  | { type: 'showChanges' }
  | { type: 'fetchMessage'; sha: string };
