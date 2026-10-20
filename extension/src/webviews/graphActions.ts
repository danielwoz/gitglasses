// What the commit graph's context menus do: commit actions on rows, branch
// and tag actions on ref chips, and stash and working-tree actions on the
// synthetic rows. Every mutation is checked against the engine's capabilities
// (Restricted Mode, engines without the git CLI) and against unresolved
// conflicts before it runs, and asks before anything destructive.

import * as vscode from 'vscode';
import type {
  GraphRef,
  GraphRow,
  RequestMethod,
  RequestParams,
  RequestResult,
} from '@gitglasses/protocol';
import { shortSha } from '@gitglasses/protocol/sha';
import { EngineClient } from '@gitglasses/rpc';
import { isMethodAvailable, unavailableMessage } from '../engine/capabilityGate';
import {
  confirmBranchDelete,
  confirmBranchForceDelete,
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

export type RefActionId = Extract<WebviewToHostMessage, { type: 'refAction' }>['action'];

export interface GraphActionContext {
  engine: EngineClient;
  repoId: string;
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

// Engine method each action leads with, for capability gating. Branch
// renames, pushes of branches that are not checked out, and tag operations
// need the branch and tag management methods (REF_MANAGEMENT).
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
  push: 'mutate/push',
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

/** The branch and tag management methods (branch renames, pushes of a branch
 *  that is not checked out, tag creation, pushes and deletion), with the
 *  params and results the sidebar's branch and tag views define for them. */
interface RefManagementMethods {
  'branch/rename': {
    params: { repoId: string; name: string; newName: string };
    result: Record<string, never>;
  };
  'branch/push': {
    params: { repoId: string; name: string; setUpstream?: boolean };
    result: { remote: string; branch: string };
  };
  'tag/create': {
    params: { repoId: string; name: string; ref?: string; message?: string };
    result: Record<string, never>;
  };
  'tag/delete': { params: { repoId: string; name: string }; result: Record<string, never> };
  'tag/push': {
    params: { repoId: string; name: string; remote: string };
    result: Record<string, never>;
  };
}
type RefManagementMethod = keyof RefManagementMethods;

/** True when the protocol defines every method of `M`. */
type ProtocolDefines<M extends string> = [M] extends [RequestMethod] ? true : false;

/** Whether this build's engine serves the branch and tag management methods.
 *  Its type is true exactly when the protocol defines all of them, so the
 *  compiler requires it to be switched on as soon as they exist. Until then
 *  the menus leave out the actions that need them. */
export const REF_MANAGEMENT: ProtocolDefines<RefManagementMethod> = false;

/** The protocol's params and result for a method it defines; the shapes
 *  above while it does not. */
type RefManagementParams<M extends RefManagementMethod> = M extends RequestMethod
  ? RequestParams<M>
  : RefManagementMethods[M]['params'];
type RefManagementResult<M extends RefManagementMethod> = M extends RequestMethod
  ? RequestResult<M>
  : RefManagementMethods[M]['result'];

/** Calls a branch or tag management method. Callers' params are checked
 *  against the protocol's definition once it has one. */
async function requestRefManagement<M extends RefManagementMethod>(
  engine: EngineClient,
  method: M,
  params: RefManagementParams<M>,
): Promise<RefManagementResult<M>> {
  const request = engine.request as unknown as (
    name: string,
    body: unknown,
  ) => Promise<RefManagementResult<M>>;
  return request.call(engine, method, params);
}

/** Refuses an action that needs the branch and tag management methods when
 *  the engine lacks them. */
function refManagementAvailable(label: string): boolean {
  if (REF_MANAGEMENT) return true;
  void vscode.window.showWarningMessage(
    `GitGlasses: cannot ${label}: this version of GitGlasses does not support it yet.`,
  );
  return false;
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
        if (refManagementAvailable(label)) await createTagAt(ctx, sha);
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
  const { engine, repoId } = ctx;
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
      case 'rename': {
        if (!refManagementAvailable(label)) return;
        const newName = await vscode.window.showInputBox({
          prompt: `Rename branch '${ref.name}'`,
          value: ref.name,
          validateInput: (value) => (value.trim() ? undefined : 'Branch name is required'),
        });
        if (!newName?.trim() || newName.trim() === ref.name) return;
        await requestRefManagement(engine, 'branch/rename', {
          repoId,
          name: ref.name,
          newName: newName.trim(),
        });
        setStatus(`Renamed '${ref.name}' to '${newName.trim()}'`);
        break;
      }
      case 'delete':
        await deleteBranch(ctx, ref.name);
        break;
      case 'push':
        await pushBranch(ctx, ref);
        break;
      case 'pushTag': {
        if (!refManagementAvailable(label)) return;
        const remote = await pickRemote(ctx, `Push tag '${ref.name}' to`);
        if (!remote) return;
        await requestRefManagement(engine, 'tag/push', { repoId, name: ref.name, remote });
        setStatus(`Pushed tag '${ref.name}' to ${remote}`);
        break;
      }
      case 'deleteTag': {
        if (!refManagementAvailable(label)) return;
        const choice = await vscode.window.showWarningMessage(
          `Delete tag '${ref.name}'?`,
          {
            modal: true,
            detail: `git tag -d ${ref.name}\n\nThe tag stays on any remote it was pushed to.`,
          },
          'Delete',
        );
        if (choice !== 'Delete') return;
        await requestRefManagement(engine, 'tag/delete', { repoId, name: ref.name });
        setStatus(`Deleted tag '${ref.name}'`);
        break;
      }
    }
  } catch (error) {
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

async function createTagAt(ctx: GraphActionContext, sha: string): Promise<void> {
  const name = await vscode.window.showInputBox({
    prompt: `Tag name (at ${shortSha(sha)})`,
    validateInput: (value) => (value.trim() ? undefined : 'Tag name is required'),
  });
  if (!name?.trim()) return;
  const message = await vscode.window.showInputBox({
    prompt: 'Tag message (leave empty for a lightweight tag)',
  });
  if (message === undefined) return;
  await requestRefManagement(ctx.engine, 'tag/create', {
    repoId: ctx.repoId,
    name: name.trim(),
    ref: sha,
    ...(message.trim() ? { message: message.trim() } : {}),
  });
  setStatus(`Created tag '${name.trim()}' at ${shortSha(sha)}`);
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

async function deleteBranch(ctx: GraphActionContext, name: string): Promise<void> {
  if (!(await confirmDestructive(confirmBranchDelete(name)))) return;
  try {
    await ctx.engine.request('mutate/branchDelete', { repoId: ctx.repoId, name, force: false });
  } catch (error) {
    // git refuses to delete a branch that is not merged; offer to force it.
    if (!/not fully merged/i.test(errorMessage(error))) throw error;
    if (!(await confirmDestructive(confirmBranchForceDelete(name)))) return;
    await ctx.engine.request('mutate/branchDelete', { repoId: ctx.repoId, name, force: true });
  }
  setStatus(`Deleted branch '${name}'`);
}

async function pushBranch(ctx: GraphActionContext, ref: GraphRef): Promise<void> {
  const { engine, repoId } = ctx;
  const head = await currentBranch(ctx);
  if (!head.detached && head.name === ref.name) {
    // The checked-out branch: publish it when it has no upstream yet.
    await engine.request('mutate/push', { repoId, setUpstream: !ref.upstream });
    setStatus(`Pushed '${ref.name}'`);
    return;
  }
  if (!refManagementAvailable(`push '${ref.name}'`)) return;
  const result = await requestRefManagement(engine, 'branch/push', {
    repoId,
    name: ref.name,
    setUpstream: !ref.upstream,
  });
  setStatus(`Pushed '${ref.name}' to ${result.remote}`);
}

async function pickRemote(
  ctx: GraphActionContext,
  placeHolder: string,
): Promise<string | undefined> {
  const { remotes } = await ctx.engine.request('remote/list', { repoId: ctx.repoId });
  if (remotes.length === 0) {
    void vscode.window.showWarningMessage('GitGlasses: this repository has no remotes.');
    return undefined;
  }
  if (remotes.length === 1) return remotes[0].name;
  return vscode.window.showQuickPick(
    remotes.map((remote) => remote.name),
    { placeHolder },
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
