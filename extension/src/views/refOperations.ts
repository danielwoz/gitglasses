// Branch and tag operations the sidebar's Branches and Tags views and the
// commit graph's ref chips share: renaming, deleting and pushing a branch, and
// creating, deleting and pushing a tag, with their prompts, confirmations,
// progress and status. Each throws what the engine reports, and the caller
// presents a failure in its own way.

import * as vscode from 'vscode';
import type { EngineClient } from '@gitglasses/rpc';
import { confirmBranchDelete, confirmBranchForceDelete } from '../commands/confirmations';
import { confirmDestructive, setStatus, showInput, showPick } from '../commands/ui';
import {
  confirmForcePush,
  confirmPublishUnderOwnName,
  confirmRemoteTagDelete,
  confirmTagDelete,
  isNotFullyMerged,
  isPushRejected,
  isUpstreamNameMismatch,
  planPush,
  splitRemoteBranch,
} from './refActionsLogic';
import type { LogFn } from './errorReport';

export interface RefOperationDeps {
  engine: EngineClient;
  log: LogFn;
}

/** Runs `task` under a cancellable notification. */
export function withProgress<T>(
  title: string,
  task: (token: vscode.CancellationToken) => Promise<T>,
): Thenable<T> {
  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title, cancellable: true },
    (_progress, token) => task(token),
  );
}

/** The names of the repository's remotes. */
export async function remoteNames(engine: EngineClient, repoId: string): Promise<string[]> {
  return (await engine.request('refs/list', { repoId })).remotes.map((r) => r.name);
}

/** Lets the user pick one of `remotes` (`preferred` first); a single remote
 *  is picked without asking. */
export async function pickRemote(
  remotes: readonly string[],
  title: string,
  preferred?: string,
): Promise<string | undefined> {
  if (remotes.length === 1) return remotes[0];
  const ordered = preferred
    ? [preferred, ...remotes.filter((remote) => remote !== preferred)]
    : [...remotes];
  const picked = await showPick(
    ordered.map((remote) => ({ label: remote })),
    { title, placeholder: 'Remote' },
  );
  return picked === 'back' || !picked ? undefined : picked.label;
}

function messageOf(error: unknown): string {
  return String((error as Error)?.message ?? error);
}

/** Asks for a new name for branch `oldName` and renames it. */
export async function renameBranch(
  deps: RefOperationDeps,
  repoId: string,
  oldName: string,
): Promise<void> {
  const name = await showInput({
    title: `Rename Branch '${oldName}'`,
    prompt: 'New name',
    value: oldName,
    validate: (value) => (value.trim() ? undefined : 'Branch name is required'),
  });
  if (name === 'back' || name === undefined || name.trim() === oldName) return;
  await deps.engine.request('branch/rename', { repoId, name: oldName, newName: name.trim() });
  setStatus(`Renamed '${oldName}' to '${name.trim()}'`);
}

/** Deletes branch `name` once confirmed, offering a forced delete when git
 *  refuses because the branch is not merged. */
export async function deleteBranch(
  deps: RefOperationDeps,
  repoId: string,
  name: string,
): Promise<void> {
  const { engine } = deps;
  if (!(await confirmDestructive(confirmBranchDelete(name)))) return;
  try {
    await engine.request('mutate/branchDelete', { repoId, name, force: false });
  } catch (error) {
    // Only an unmerged branch warrants the forced delete; any other refusal
    // is reported as it is.
    if (!isNotFullyMerged(messageOf(error))) throw error;
    if (!(await confirmDestructive(confirmBranchForceDelete(name)))) return;
    await engine.request('mutate/branchDelete', { repoId, name, force: true });
  }
  setStatus(`Deleted branch '${name}'`);
}

/** Pushes local branch `name`, publishing it when it tracks nothing, and
 *  offers a force-with-lease push when the remote rejects it. */
export async function pushBranch(
  deps: RefOperationDeps,
  repoId: string,
  branch: { name: string; upstream?: string },
): Promise<void> {
  const { engine, log } = deps;
  const { name, upstream } = branch;
  const remotes = await remoteNames(engine, repoId);
  const plan = planPush(upstream, remotes);
  let remote: string | undefined;
  if (plan.kind === 'noRemote') {
    const choice = await vscode.window.showInformationMessage(
      `GitGlasses: this repository has no remote to publish '${name}' to.`,
      'Add Remote…',
    );
    if (choice) await vscode.commands.executeCommand('gitglasses.remote.add');
    return;
  }
  if (plan.kind === 'pickRemote') {
    remote = await pickRemote(plan.remotes, `Publish '${name}' to`, plan.preferred);
    if (!remote) return;
  } else if (plan.kind === 'publish') {
    remote = plan.remote;
  }
  let setUpstream = plan.kind !== 'push';
  // The engine resolves where the push lands from git's config, so the
  // progress, the force prompt and the status name the real branch.
  const resolve = () =>
    engine.request('branch/push', {
      repoId,
      name,
      remote,
      setUpstream: setUpstream || undefined,
      dryRun: true,
    });
  let target;
  try {
    target = await resolve();
  } catch (error) {
    // A branch tracking a branch of another name is not pushed there (git's
    // push.default=simple); publishing it under its own name is the way
    // forward.
    const tracked = upstream && splitRemoteBranch(upstream, remotes);
    if (!tracked || !isUpstreamNameMismatch(messageOf(error))) throw error;
    const prompt = confirmPublishUnderOwnName(name, upstream, tracked.remote);
    const publish = `Publish to ${tracked.remote}/${name}`;
    const choice = await vscode.window.showWarningMessage(
      prompt.message,
      { modal: true, detail: prompt.detail },
      publish,
    );
    if (choice !== publish) return;
    remote = tracked.remote;
    setUpstream = true;
    target = await resolve();
  }
  const where = `${target.remote}/${target.branch}`;
  const push = (force: boolean) =>
    withProgress(`Pushing '${name}' to ${where}…`, (token) =>
      engine.request(
        'branch/push',
        {
          repoId,
          name,
          remote: target.remote,
          setUpstream: setUpstream || undefined,
          force: force ? 'with-lease' : undefined,
        },
        token,
      ),
    );
  let result;
  try {
    result = await push(false);
  } catch (error) {
    const message = messageOf(error);
    if (!isPushRejected(message)) throw error;
    log(`push of '${name}' to ${where} rejected: ${message}`);
    if (!(await confirmDestructive(confirmForcePush(name, target)))) return;
    result = await push(true);
  }
  setStatus(
    `${setUpstream ? 'Published' : 'Pushed'} '${name}' to ${result.remote}/${result.branch}`,
  );
}

/** Asks for a tag name and message and creates the tag at `at`, or at a
 *  revision the user enters when `at` is not given. An empty message makes
 *  a lightweight tag. */
export async function createTag(
  deps: RefOperationDeps,
  repoId: string,
  at?: { revision: string; label: string },
): Promise<void> {
  const name = await showInput({
    title: `Create Tag${at ? ` at ${at.label}` : ''}`,
    prompt: 'Tag name',
    validate: (value) =>
      !value.trim()
        ? 'Tag name is required'
        : /\s/.test(value.trim())
          ? 'Tag names cannot contain spaces'
          : undefined,
  });
  if (name === 'back' || name === undefined) return;
  let ref = at?.revision;
  if (!ref) {
    const entered = await showInput({
      title: `Create Tag '${name.trim()}'`,
      prompt: 'Commit to tag (sha, branch, HEAD~n…)',
      value: 'HEAD',
      validate: (value) => (value.trim() ? undefined : 'A revision is required'),
    });
    if (entered === 'back' || entered === undefined) return;
    ref = entered.trim();
  }
  const message = await showInput({
    title: `Create Tag '${name.trim()}'`,
    prompt: 'Message for an annotated tag; leave empty for a lightweight tag',
  });
  if (message === 'back' || message === undefined) return;
  await deps.engine.request('tag/create', {
    repoId,
    name: name.trim(),
    ref,
    message: message.trim() || undefined,
  });
  setStatus(`Created tag '${name.trim()}'`);
}

/** Deletes local tag `name` once confirmed. */
export async function deleteTag(
  deps: RefOperationDeps,
  repoId: string,
  name: string,
): Promise<void> {
  if (!(await confirmDestructive(confirmTagDelete(name)))) return;
  await deps.engine.request('tag/delete', { repoId, name });
  setStatus(`Deleted tag '${name}'`);
}

/** Pushes tag `name` to a remote the user picks, or with `remove` deletes it
 *  there once confirmed. */
export async function pushTag(
  deps: RefOperationDeps,
  repoId: string,
  name: string,
  remove = false,
): Promise<void> {
  const { engine } = deps;
  const remotes = await remoteNames(engine, repoId);
  if (remotes.length === 0) {
    void vscode.window.showInformationMessage('GitGlasses: this repository has no remotes.');
    return;
  }
  const remote = await pickRemote(
    remotes,
    remove ? `Delete '${name}' from` : `Push '${name}' to`,
    remotes.includes('origin') ? 'origin' : undefined,
  );
  if (!remote) return;
  if (remove && !(await confirmDestructive(confirmRemoteTagDelete(name, remote)))) return;
  await withProgress(
    remove ? `Deleting '${name}' from ${remote}…` : `Pushing '${name}' to ${remote}…`,
    (token) =>
      engine.request('tag/push', { repoId, name, remote, delete: remove || undefined }, token),
  );
  setStatus(remove ? `Deleted '${name}' from ${remote}` : `Pushed '${name}' to ${remote}`);
}
