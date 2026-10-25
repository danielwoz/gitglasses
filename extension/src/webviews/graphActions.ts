// What the commit graph's context menus do: commit actions on rows, branch
// and tag actions on ref chips, and stash and working-tree actions on the
// synthetic rows. Every mutation is checked against the engine's capabilities
// (Restricted Mode, engines without the git CLI) and against unresolved
// conflicts before it runs, and asks before anything destructive. Renaming,
// deleting and pushing a branch and creating, pushing and deleting a tag run
// the same flows as the Branches and Tags views.

import * as vscode from 'vscode';
import type { GraphRef, GraphRow } from '@gitglasses/protocol';
import { shortSha } from '@gitglasses/protocol/sha';
import { EngineClient } from '@gitglasses/rpc';
import { isMethodAvailable, unavailableMessage } from '../engine/capabilityGate';
import {
  confirmCherryPick,
  confirmMerge,
  confirmResetHard,
  confirmRevert,
  confirmStashDrop,
} from '../commands/confirmations';
import { confirmDestructive, errorMessage, setStatus, showConflictGuidance } from '../commands/ui';
import { allowedDespiteConflicts } from '../commands/conflictGuard';
import type { GraphActionId, WebviewToHostMessage } from '../../webviews-src/graph/ipc';
import { localNameFor } from './graphHostLogic';
import { reportIfStopped } from '../sync/syncCommands';
import type { LogFn } from '../views/errorReport';
import {
  createTag,
  deleteBranch,
  deleteTag,
  pushBranch,
  pushTag,
  renameBranch,
} from '../views/refOperations';

export type RefActionId = Extract<WebviewToHostMessage, { type: 'refAction' }>['action'];

export interface GraphActionContext {
  engine: EngineClient;
  repoId: string;
  log: LogFn;
  openRebase(upstream: string): void | Promise<void>;
}

const ROW_LABELS: Record<GraphActionId, string> = {
  createBranch: 'create branch',
  createTag: 'create tag',
  switchDetached: 'switch',
  cherryPick: 'cherry-pick',
  revert: 'revert',
  reset: 'reset',
  merge: 'merge',
  rebase: 'rebase',
  stashChanges: 'stash',
  stashApply: 'apply stash',
  stashPop: 'pop stash',
  stashDrop: 'drop stash',
  openScm: 'open Source Control',
};

const REF_LABELS: Record<RefActionId, string> = {
  checkout: 'check out',
  merge: 'merge',
  rebase: 'rebase',
  createBranch: 'create branch',
  rename: 'rename branch',
  delete: 'delete branch',
  push: 'push',
  pushTag: 'push tag',
  deleteTag: 'delete tag',
};

// Engine method each action leads with, for capability gating.
const ROW_METHODS: Record<GraphActionId, string | undefined> = {
  createBranch: 'mutate/branchCreate',
  createTag: 'tag/create',
  switchDetached: 'mutate/switch',
  cherryPick: 'mutate/cherryPick',
  revert: 'mutate/revert',
  reset: 'mutate/reset',
  merge: 'mutate/merge',
  rebase: 'rebase/start',
  stashChanges: 'stash/push',
  stashApply: 'stash/apply',
  stashPop: 'stash/apply',
  stashDrop: 'stash/drop',
  openScm: undefined,
};

const REF_METHODS: Record<RefActionId, string> = {
  checkout: 'mutate/switch',
  merge: 'mutate/merge',
  rebase: 'rebase/start',
  createBranch: 'mutate/branchCreate',
  rename: 'branch/rename',
  delete: 'mutate/branchDelete',
  push: 'branch/push',
  pushTag: 'tag/push',
  deleteTag: 'tag/delete',
};

// Operations git refuses while a merge, rebase or cherry-pick is unresolved.
const CONFLICT_GUARDED = new Set<string>([
  'switchDetached',
  'cherryPick',
  'revert',
  'reset',
  'merge',
  'rebase',
  'checkout',
  'stashApply',
  'stashPop',
]);

/** Which kind of row each action belongs to: commit actions never run on the
 *  uncommitted-changes row or a stash (resetting a branch onto a stash's
 *  internal commit is never what was meant). */
function rowKindFor(action: GraphActionId): GraphRow['kind'] | undefined {
  switch (action) {
    case 'stashApply':
    case 'stashPop':
    case 'stashDrop':
      return 'stash';
    case 'stashChanges':
    case 'openScm':
      return undefined;
    default:
      return 'commit';
  }
}

function gate(engine: EngineClient, method: string | undefined, label: string): boolean {
  const caps = engine.capabilities();
  if (method === undefined || isMethodAvailable(caps, method)) return true;
  void vscode.window.showWarningMessage(
    `GitGlasses: cannot ${label}. ${unavailableMessage(caps)}.`,
  );
  return false;
}

async function currentBranch(
  ctx: GraphActionContext,
): Promise<{ name: string; detached: boolean }> {
  const { head } = await ctx.engine.request('repo/state', { repoId: ctx.repoId });
  return { name: head.detached || !head.branch ? 'HEAD' : head.branch, detached: head.detached };
}

/** Runs a row action. `kinds` maps every sha the graph showed to its row kind;
 *  shas of another kind than the action needs are refused. */
export async function runRowAction(
  ctx: GraphActionContext,
  action: GraphActionId,
  shas: string[],
  kinds: ReadonlyMap<string, GraphRow['kind']>,
): Promise<void> {
  const label = ROW_LABELS[action];
  const needed = rowKindFor(action);
  if (needed && (shas.length === 0 || shas.some((sha) => kinds.get(sha) !== needed))) {
    void vscode.window.showWarningMessage(
      `GitGlasses: cannot ${label} here: it applies to ${needed === 'stash' ? 'stashes' : 'commits'} only.`,
    );
    return;
  }
  if (action === 'openScm') {
    await vscode.commands.executeCommand('workbench.view.scm');
    return;
  }
  if (!gate(ctx.engine, ROW_METHODS[action], label)) return;
  if (
    CONFLICT_GUARDED.has(action) &&
    !(await allowedDespiteConflicts(ctx.engine, ctx.repoId, label))
  ) {
    return;
  }
  const { engine, repoId } = ctx;
  const sha = shas[0];
  try {
    switch (action) {
      case 'createBranch':
        await createBranchAt(ctx, sha, shortSha(sha));
        break;
      case 'createTag':
        await createTag(ctx, repoId, { revision: sha, label: shortSha(sha) });
        break;
      case 'switchDetached':
        await engine.request('mutate/switch', { repoId, ref: sha });
        setStatus(`Checked out ${shortSha(sha)} (detached HEAD)`);
        break;
      case 'cherryPick': {
        // The webview sends selection newest-first; apply oldest-first.
        const ordered = [...shas].reverse();
        if (!(await confirmDestructive(confirmCherryPick(ordered)))) return;
        const { conflicts } = await engine.request('mutate/cherryPick', { repoId, shas: ordered });
        if (conflicts) showConflictGuidance('Cherry-pick');
        else setStatus(`Cherry-picked ${ordered.length} commit${ordered.length === 1 ? '' : 's'}`);
        break;
      }
      case 'revert': {
        if (!(await confirmDestructive(confirmRevert(shas)))) return;
        const { conflicts } = await engine.request('mutate/revert', { repoId, shas });
        if (conflicts) showConflictGuidance('Revert');
        else setStatus(`Reverted ${shas.length} commit${shas.length === 1 ? '' : 's'}`);
        break;
      }
      case 'reset':
        await resetTo(ctx, sha);
        break;
      case 'merge':
        await mergeRef(ctx, sha, shortSha(sha));
        break;
      case 'rebase':
        // Opens the interactive rebase editor with this commit as the
        // upstream; the rebase runs from there.
        await ctx.openRebase(sha);
        break;
      case 'stashChanges':
        await stashChanges(ctx);
        break;
      case 'stashApply':
      case 'stashPop':
      case 'stashDrop':
        await stashAction(ctx, action, sha);
        break;
    }
  } catch (error) {
    // A merge, cherry-pick, revert or rebase that git stopped half-way
    // offers to continue, skip or abort it instead.
    if (reportIfStopped(error)) return;
    void vscode.window.showErrorMessage(`GitGlasses: ${label} failed: ${errorMessage(error)}`);
  }
}

/** Runs a ref-chip action on `ref`, which points at `sha`. */
export async function runRefAction(
  ctx: GraphActionContext,
  action: RefActionId,
  ref: GraphRef,
  sha: string,
): Promise<void> {
  const label = REF_LABELS[action];
  if (!gate(ctx.engine, REF_METHODS[action], label)) return;
  if (
    CONFLICT_GUARDED.has(action) &&
    !(await allowedDespiteConflicts(ctx.engine, ctx.repoId, label))
  ) {
    return;
  }
  const { repoId } = ctx;
  try {
    switch (action) {
      case 'checkout':
        await checkoutRef(ctx, ref);
        break;
      case 'merge':
        await mergeRef(ctx, ref.name, ref.name);
        break;
      case 'rebase':
        await ctx.openRebase(ref.name);
        break;
      case 'createBranch':
        await createBranchAt(ctx, sha, ref.name);
        break;
      case 'rename':
        await renameBranch(ctx, repoId, ref.name);
        break;
      case 'delete':
        await deleteBranch(ctx, repoId, ref.name);
        break;
      case 'push':
        await pushBranch(ctx, repoId, { name: ref.name, upstream: ref.upstream?.name });
        break;
      case 'pushTag':
        await pushTag(ctx, repoId, ref.name);
        break;
      case 'deleteTag':
        await deleteTag(ctx, repoId, ref.name);
        break;
    }
  } catch (error) {
    // A merge, cherry-pick, revert or rebase that git stopped half-way
    // offers to continue, skip or abort it instead.
    if (reportIfStopped(error)) return;
    void vscode.window.showErrorMessage(`GitGlasses: ${label} failed: ${errorMessage(error)}`);
  }
}

async function createBranchAt(ctx: GraphActionContext, sha: string, at: string): Promise<void> {
  const name = await vscode.window.showInputBox({
    prompt: `Branch name (created at ${at})`,
    validateInput: (value) => (value.trim() ? undefined : 'Branch name is required'),
  });
  if (!name?.trim()) return;
  const mode = await vscode.window.showQuickPick(['Create', 'Create and Switch'], {
    placeHolder: `Create '${name.trim()}' at ${at}`,
  });
  if (!mode) return;
  await ctx.engine.request('mutate/branchCreate', {
    repoId: ctx.repoId,
    name: name.trim(),
    startPoint: sha,
    checkout: mode === 'Create and Switch',
  });
  setStatus(`Created branch '${name.trim()}' at ${at}`);
}

async function mergeRef(ctx: GraphActionContext, ref: string, label: string): Promise<void> {
  const branch = await currentBranch(ctx);
  if (!(await confirmDestructive(confirmMerge(label, branch.name)))) return;
  const { conflicts } = await ctx.engine.request('mutate/merge', { repoId: ctx.repoId, ref });
  if (conflicts) showConflictGuidance('Merge');
  else setStatus(`Merged ${label} into '${branch.name}'`);
}

async function resetTo(ctx: GraphActionContext, sha: string): Promise<void> {
  const branch = (await currentBranch(ctx)).name;
  const mode = await vscode.window.showQuickPick(
    [
      { label: 'Soft', description: 'keep index and working tree', mode: 'soft' as const },
      { label: 'Mixed', description: 'reset index, keep working tree', mode: 'mixed' as const },
      {
        label: 'Hard',
        description: 'discard index and working tree changes',
        mode: 'hard' as const,
      },
    ],
    { placeHolder: `Reset '${branch}' to ${shortSha(sha)}` },
  );
  if (!mode) return;
  if (
    mode.mode === 'hard' &&
    !(await confirmDestructive(confirmResetHard(branch, shortSha(sha))))
  ) {
    return;
  }
  await ctx.engine.request('mutate/reset', { repoId: ctx.repoId, ref: sha, mode: mode.mode });
  setStatus(`Reset '${branch}' to ${shortSha(sha)} (${mode.mode})`);
}

async function checkoutRef(ctx: GraphActionContext, ref: GraphRef): Promise<void> {
  const { engine, repoId } = ctx;
  if (ref.kind === 'remote') {
    // A remote branch checks out as a local branch tracking it, or switches
    // to that local branch when it already exists.
    const refs = await engine.request('refs/list', { repoId });
    const local = localNameFor(
      ref.name,
      refs.remotes.map((remote) => remote.name),
    );
    if (refs.branches.some((branch) => branch.name === local)) {
      await engine.request('mutate/switch', { repoId, ref: local });
      setStatus(`Switched to '${local}'`);
      return;
    }
    await engine.request('mutate/branchCreate', {
      repoId,
      name: local,
      startPoint: ref.name,
      checkout: true,
    });
    setStatus(`Created '${local}' tracking '${ref.name}'`);
    return;
  }
  await engine.request('mutate/switch', { repoId, ref: ref.name });
  setStatus(
    ref.kind === 'tag' ? `Checked out ${ref.name} (detached HEAD)` : `Switched to '${ref.name}'`,
  );
}

async function stashChanges(ctx: GraphActionContext): Promise<void> {
  const message = await vscode.window.showInputBox({ prompt: 'Stash message (optional)' });
  if (message === undefined) return;
  const untracked = await vscode.window.showQuickPick(
    [
      { label: 'Tracked Changes', includeUntracked: false },
      { label: 'Tracked and Untracked Changes', includeUntracked: true },
    ],
    { placeHolder: 'What to stash' },
  );
  if (!untracked) return;
  await ctx.engine.request('stash/push', {
    repoId: ctx.repoId,
    message: message.trim() || undefined,
    includeUntracked: untracked.includeUntracked,
  });
  setStatus('Stashed changes');
}

async function stashAction(
  ctx: GraphActionContext,
  action: 'stashApply' | 'stashPop' | 'stashDrop',
  sha: string,
): Promise<void> {
  const { engine, repoId } = ctx;
  // Stash indices shift as entries come and go; resolve this one now.
  const { entries } = await engine.request('stash/list', { repoId });
  const entry = entries.find((candidate) => candidate.sha === sha);
  if (!entry) {
    void vscode.window.showWarningMessage('GitGlasses: that stash no longer exists.');
    return;
  }
  if (action === 'stashDrop') {
    if (!(await confirmDestructive(confirmStashDrop(entry.index, entry.message)))) return;
    await engine.request('stash/drop', { repoId, index: entry.index });
    setStatus(`Dropped stash@{${entry.index}}`);
    return;
  }
  const pop = action === 'stashPop';
  const { conflicts } = await engine.request('stash/apply', { repoId, index: entry.index, pop });
  if (conflicts) showConflictGuidance('Stash apply');
  else setStatus(`${pop ? 'Popped' : 'Applied'} stash@{${entry.index}}`);
}
