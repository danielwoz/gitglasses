// Git command palette: a root QuickPick of git operations, each backed by a
// small multi-step flow (quickFlow) with back navigation to the root picker.

import * as vscode from 'vscode';
import { EngineClient } from '../engine/engineClient';
import { CLI_UNAVAILABLE_MESSAGE, isMethodAvailable } from '../engine/capabilityGate';
import { RepositoryService } from '../model/repositoryService';
import { ActiveRepo, firstWorkspaceRepo } from '../views/viewBase';
import { back, cancel, next, runFlow } from './quickFlow';
import {
  confirmBranchDelete,
  confirmBranchForceDelete,
  confirmCherryPick,
  confirmMerge,
  confirmResetHard,
  confirmStashDrop,
  sha7,
} from './confirmations';
import {
  confirmDestructive,
  errorMessage,
  setStatus,
  showConflictGuidance,
  showInput,
  showPick,
} from './ui';

type CommandId =
  | 'commit'
  | 'branch'
  | 'merge'
  | 'rebase'
  | 'stash'
  | 'push'
  | 'pull'
  | 'fetch'
  | 'reset'
  | 'cherryPick';

interface RootItem extends vscode.QuickPickItem {
  id: CommandId;
}

const ROOT_ITEMS: RootItem[] = [
  { id: 'commit', label: '$(check) Commit', description: 'Commit staged changes' },
  { id: 'branch', label: '$(git-branch) Branch', description: 'Create, switch, or delete' },
  { id: 'merge', label: '$(git-merge) Merge', description: 'Merge a branch into the current one' },
  { id: 'rebase', label: '$(history) Rebase', description: 'Interactive rebase onto a branch' },
  { id: 'stash', label: '$(archive) Stash', description: 'Push, apply, pop, or drop' },
  { id: 'push', label: '$(arrow-up) Push', description: 'Push the current branch' },
  { id: 'pull', label: '$(arrow-down) Pull', description: 'Pull with auto-stash' },
  { id: 'fetch', label: '$(sync) Fetch', description: 'Fetch from remotes' },
  { id: 'reset', label: '$(discard) Reset', description: 'Reset the current branch to a ref' },
  { id: 'cherryPick', label: '$(git-commit) Cherry-pick', description: 'Apply commits here' },
];

// Representative engine method per flow, for capability gating: every flow
// here ends in a CLI-dependent mutation, keyed by its first mutating call.
const FLOW_METHODS: Record<CommandId, string> = {
  commit: 'mutate/commit',
  branch: 'mutate/branchCreate',
  merge: 'mutate/merge',
  rebase: 'rebase/start',
  stash: 'stash/push',
  push: 'mutate/push',
  pull: 'mutate/pull',
  fetch: 'mutate/fetch',
  reset: 'mutate/reset',
  cherryPick: 'mutate/cherryPick',
};

type FlowStatus = 'completed' | 'cancelled' | 'backedOut';

interface PaletteContext {
  engine: EngineClient;
  repo: ActiveRepo;
  openRebase: (upstream?: string) => void | Promise<void>;
}

async function currentBranch(ctx: PaletteContext): Promise<string> {
  const { head } = await ctx.engine.request('repo/state', { repoId: ctx.repo.repoId });
  return head.detached || !head.branch ? 'HEAD' : head.branch;
}

/** QuickPick of local branches, optionally excluding the current one. The
 *  result is wrapped so a branch literally named 'back' stays unambiguous. */
async function pickBranch(
  ctx: PaletteContext,
  options: { title: string; placeholder: string; excludeCurrent: boolean },
): Promise<{ name: string } | 'back' | undefined> {
  const { branches } = await ctx.engine.request('refs/list', { repoId: ctx.repo.repoId });
  const candidates = branches.filter((branch) => !options.excludeCurrent || !branch.current);
  if (candidates.length === 0) {
    void vscode.window.showInformationMessage('GitGlasses: no other branches.');
    return undefined;
  }
  const picked = await showPick(
    candidates.map((branch) => ({
      label: branch.name,
      description: `${sha7(branch.sha)}${branch.current ? ' (current)' : ''}`,
    })),
    { title: options.title, placeholder: options.placeholder, back: true },
  );
  if (picked === 'back' || picked === undefined) return picked;
  return { name: picked.label };
}

// --- Flows ------------------------------------------------------------------

async function commitFlow(ctx: PaletteContext): Promise<FlowStatus> {
  const { engine, repo } = ctx;
  const status = await engine.request('status/summary', { repoId: repo.repoId });
  if (status.staged.length === 0) {
    const stageable = [...status.unstaged.map((file) => file.path), ...status.untracked];
    if (stageable.length === 0) {
      void vscode.window.showInformationMessage('GitGlasses: nothing to commit.');
      return 'completed';
    }
    const choice = await vscode.window.showWarningMessage(
      'Nothing is staged.',
      { modal: true, detail: `Stage all ${stageable.length} changed file(s) and continue?` },
      'Stage All',
    );
    if (choice !== 'Stage All') return 'cancelled';
    await engine.request('stage/files', { repoId: repo.repoId, paths: stageable, action: 'stage' });
  }
  const flow = await runFlow<{ message: string }>({ message: '' }, [
    async (state) => {
      const message = await showInput({
        title: 'Commit',
        prompt: 'Commit message',
        value: state.message,
        back: true,
        validate: (value) => (value.trim() ? undefined : 'Commit message is required'),
      });
      if (message === 'back') return back();
      if (message === undefined) return cancel();
      return next({ message: message.trim() });
    },
  ]);
  if (flow.status !== 'completed') return flow.status;
  const { sha } = await engine.request('mutate/commit', {
    repoId: repo.repoId,
    message: flow.state.message,
  });
  setStatus(`Committed ${sha7(sha)}`);
  return 'completed';
}

async function branchFlow(ctx: PaletteContext): Promise<FlowStatus> {
  const { engine, repo } = ctx;
  interface SubItem extends vscode.QuickPickItem {
    id: 'create' | 'switch' | 'delete';
  }
  const sub = await showPick<SubItem>(
    [
      { id: 'create', label: '$(add) Create Branch…' },
      { id: 'switch', label: '$(arrow-swap) Switch Branch…' },
      { id: 'delete', label: '$(trash) Delete Branch…' },
    ],
    { title: 'Branch', placeholder: 'Branch operation', back: true },
  );
  if (sub === 'back') return 'backedOut';
  if (!sub) return 'cancelled';

  if (sub.id === 'create') {
    const flow = await runFlow<{ name: string; checkout: boolean }>(
      { name: '', checkout: true },
      [
        async (state) => {
          const name = await showInput({
            title: 'Create Branch',
            prompt: 'Branch name',
            value: state.name,
            back: true,
            validate: (value) => (value.trim() ? undefined : 'Branch name is required'),
          });
          if (name === 'back') return back();
          if (name === undefined) return cancel();
          return next({ ...state, name: name.trim() });
        },
        async (state) => {
          const picked = await showPick(
            [
              { label: 'Create and Switch', checkout: true },
              { label: 'Create Only', checkout: false },
            ],
            { title: 'Create Branch', placeholder: `Create '${state.name}'`, back: true },
          );
          if (picked === 'back') return back();
          if (!picked) return cancel();
          return next({ ...state, checkout: picked.checkout });
        },
      ],
    );
    if (flow.status !== 'completed') return flow.status === 'backedOut' ? 'cancelled' : flow.status;
    await engine.request('mutate/branchCreate', {
      repoId: repo.repoId,
      name: flow.state.name,
      checkout: flow.state.checkout,
    });
    setStatus(`Created branch '${flow.state.name}'`);
    return 'completed';
  }

  if (sub.id === 'switch') {
    const picked = await pickBranch(ctx, {
      title: 'Switch Branch',
      placeholder: 'Branch to switch to',
      excludeCurrent: true,
    });
    if (picked === 'back' || picked === undefined) return 'cancelled';
    await engine.request('mutate/switch', { repoId: repo.repoId, ref: picked.name });
    setStatus(`Switched to '${picked.name}'`);
    return 'completed';
  }

  const picked = await pickBranch(ctx, {
    title: 'Delete Branch',
    placeholder: 'Branch to delete',
    excludeCurrent: true,
  });
  if (picked === 'back' || picked === undefined) return 'cancelled';
  const name = picked.name;
  if (!(await confirmDestructive(confirmBranchDelete(name)))) return 'cancelled';
  try {
    await engine.request('mutate/branchDelete', { repoId: repo.repoId, name, force: false });
  } catch {
    if (!(await confirmDestructive(confirmBranchForceDelete(name)))) return 'cancelled';
    await engine.request('mutate/branchDelete', { repoId: repo.repoId, name, force: true });
  }
  setStatus(`Deleted branch '${name}'`);
  return 'completed';
}

async function mergeFlow(ctx: PaletteContext): Promise<FlowStatus> {
  const picked = await pickBranch(ctx, {
    title: 'Merge',
    placeholder: 'Branch to merge into the current branch',
    excludeCurrent: true,
  });
  if (picked === 'back') return 'backedOut';
  if (picked === undefined) return 'cancelled';
  const into = await currentBranch(ctx);
  if (!(await confirmDestructive(confirmMerge(picked.name, into)))) return 'cancelled';
  const { conflicts } = await ctx.engine.request('mutate/merge', {
    repoId: ctx.repo.repoId,
    ref: picked.name,
  });
  if (conflicts) showConflictGuidance('Merge');
  else setStatus(`Merged '${picked.name}' into '${into}'`);
  return 'completed';
}

async function rebaseFlow(ctx: PaletteContext): Promise<FlowStatus> {
  const picked = await pickBranch(ctx, {
    title: 'Rebase',
    placeholder: 'Upstream branch to rebase onto',
    excludeCurrent: true,
  });
  if (picked === 'back') return 'backedOut';
  if (picked === undefined) return 'cancelled';
  await ctx.openRebase(picked.name);
  return 'completed';
}

async function stashFlow(ctx: PaletteContext): Promise<FlowStatus> {
  const { engine, repo } = ctx;
  interface SubItem extends vscode.QuickPickItem {
    id: 'push' | 'apply' | 'pop' | 'drop';
  }
  const sub = await showPick<SubItem>(
    [
      { id: 'push', label: '$(add) Stash Push…' },
      { id: 'apply', label: '$(debug-step-back) Stash Apply…' },
      { id: 'pop', label: '$(debug-step-out) Stash Pop…' },
      { id: 'drop', label: '$(trash) Stash Drop…' },
    ],
    { title: 'Stash', placeholder: 'Stash operation', back: true },
  );
  if (sub === 'back') return 'backedOut';
  if (!sub) return 'cancelled';

  if (sub.id === 'push') {
    const message = await showInput({
      title: 'Stash Push',
      prompt: 'Stash message (optional)',
      back: true,
    });
    if (message === 'back' || message === undefined) return 'cancelled';
    await engine.request('stash/push', {
      repoId: repo.repoId,
      message: message.trim() || undefined,
    });
    setStatus('Stashed changes');
    return 'completed';
  }

  const { entries } = await engine.request('stash/list', { repoId: repo.repoId });
  if (entries.length === 0) {
    void vscode.window.showInformationMessage('GitGlasses: no stashes.');
    return 'completed';
  }
  const picked = await showPick(
    entries.map((entry) => ({
      label: entry.message,
      description: entry.branch ? `stash@{${entry.index}} on ${entry.branch}` : `stash@{${entry.index}}`,
      entry,
    })),
    { title: `Stash ${sub.id[0].toUpperCase()}${sub.id.slice(1)}`, placeholder: 'Stash entry', back: true },
  );
  if (picked === 'back' || !picked) return 'cancelled';
  const { entry } = picked;

  if (sub.id === 'drop') {
    if (!(await confirmDestructive(confirmStashDrop(entry.index, entry.message)))) {
      return 'cancelled';
    }
    await engine.request('stash/drop', { repoId: repo.repoId, index: entry.index });
    setStatus(`Dropped stash@{${entry.index}}`);
    return 'completed';
  }

  const { conflicts } = await engine.request('stash/apply', {
    repoId: repo.repoId,
    index: entry.index,
    pop: sub.id === 'pop',
  });
  if (conflicts) showConflictGuidance('Stash apply');
  else setStatus(`${sub.id === 'pop' ? 'Popped' : 'Applied'} stash@{${entry.index}}`);
  return 'completed';
}

async function pushFlow(ctx: PaletteContext): Promise<FlowStatus> {
  const status = await ctx.engine.request('status/summary', { repoId: ctx.repo.repoId });
  const setUpstream = !status.upstream;
  await ctx.engine.request('mutate/push', { repoId: ctx.repo.repoId, setUpstream });
  setStatus(`Pushed '${status.branch}'${setUpstream ? ' (set upstream)' : ''}`);
  return 'completed';
}

async function pullFlow(ctx: PaletteContext): Promise<FlowStatus> {
  await ctx.engine.request('mutate/pull', { repoId: ctx.repo.repoId, autoStash: true });
  setStatus('Pulled (auto-stash)');
  return 'completed';
}

async function fetchFlow(ctx: PaletteContext): Promise<FlowStatus> {
  const picked = await showPick(
    [
      { label: 'Fetch', description: 'git fetch', prune: false },
      { label: 'Fetch (prune)', description: 'git fetch --prune', prune: true },
    ],
    { title: 'Fetch', placeholder: 'Fetch remotes', back: true },
  );
  if (picked === 'back') return 'backedOut';
  if (!picked) return 'cancelled';
  await ctx.engine.request('mutate/fetch', { repoId: ctx.repo.repoId, prune: picked.prune });
  setStatus(picked.prune ? 'Fetched (pruned)' : 'Fetched');
  return 'completed';
}

async function resetFlow(ctx: PaletteContext): Promise<FlowStatus> {
  interface ResetState {
    ref: string;
    mode: 'soft' | 'mixed' | 'hard';
  }
  const flow = await runFlow<ResetState>({ ref: 'HEAD~1', mode: 'mixed' }, [
    async (state) => {
      const ref = await showInput({
        title: 'Reset',
        prompt: 'Target ref (sha, branch, HEAD~n…)',
        value: state.ref,
        back: true,
        validate: (value) => (value.trim() ? undefined : 'Ref is required'),
      });
      if (ref === 'back') return back();
      if (ref === undefined) return cancel();
      return next({ ...state, ref: ref.trim() });
    },
    async (state) => {
      const picked = await showPick(
        [
          { label: 'Soft', description: 'keep index and working tree', mode: 'soft' as const },
          { label: 'Mixed', description: 'reset index, keep working tree', mode: 'mixed' as const },
          {
            label: 'Hard',
            description: 'discard index and working tree changes',
            mode: 'hard' as const,
          },
        ],
        { title: 'Reset', placeholder: `Reset to ${state.ref}`, back: true },
      );
      if (picked === 'back') return back();
      if (!picked) return cancel();
      return next({ ...state, mode: picked.mode });
    },
  ]);
  if (flow.status !== 'completed') return flow.status;
  const { ref, mode } = flow.state;
  if (mode === 'hard') {
    const branch = await currentBranch(ctx);
    if (!(await confirmDestructive(confirmResetHard(branch, ref)))) return 'cancelled';
  }
  await ctx.engine.request('mutate/reset', { repoId: ctx.repo.repoId, ref, mode });
  setStatus(`Reset to ${ref} (${mode})`);
  return 'completed';
}

async function cherryPickFlow(ctx: PaletteContext): Promise<FlowStatus> {
  const input = await showInput({
    title: 'Cherry-pick',
    prompt: 'Commit sha(s), space separated, in the order to apply',
    back: true,
    validate: (value) => (value.trim() ? undefined : 'At least one sha is required'),
  });
  if (input === 'back') return 'backedOut';
  if (input === undefined) return 'cancelled';
  const shas = input.trim().split(/\s+/);
  if (!(await confirmDestructive(confirmCherryPick(shas)))) return 'cancelled';
  const { conflicts } = await ctx.engine.request('mutate/cherryPick', {
    repoId: ctx.repo.repoId,
    shas,
  });
  if (conflicts) showConflictGuidance('Cherry-pick');
  else setStatus(`Cherry-picked ${shas.length} commit${shas.length === 1 ? '' : 's'}`);
  return 'completed';
}

const FLOWS: Record<CommandId, (ctx: PaletteContext) => Promise<FlowStatus>> = {
  commit: commitFlow,
  branch: branchFlow,
  merge: mergeFlow,
  rebase: rebaseFlow,
  stash: stashFlow,
  push: pushFlow,
  pull: pullFlow,
  fetch: fetchFlow,
  reset: resetFlow,
  cherryPick: cherryPickFlow,
};

export function registerGitPalette(
  engine: EngineClient,
  repos: RepositoryService,
  openRebase: (upstream?: string) => void | Promise<void>,
): vscode.Disposable {
  return vscode.commands.registerCommand('gitglasses.gitCommands', async () => {
    let repo: ActiveRepo | undefined;
    try {
      repo = await firstWorkspaceRepo(repos);
    } catch {
      repo = undefined;
    }
    if (!repo) {
      void vscode.window.showWarningMessage('GitGlasses: no git repository in this workspace.');
      return;
    }
    const ctx: PaletteContext = { engine, repo, openRebase };
    // Backing out of a flow returns to the root picker.
    for (;;) {
      const caps = engine.capabilities();
      const items = ROOT_ITEMS.map((item) =>
        isMethodAvailable(caps, FLOW_METHODS[item.id])
          ? item
          : { ...item, description: CLI_UNAVAILABLE_MESSAGE },
      );
      const root = await showPick(items, {
        title: 'Git Commands',
        placeholder: 'Pick a git command',
      });
      if (root === 'back' || root === undefined) return;
      // Unavailable flows explain themselves instead of executing.
      if (!isMethodAvailable(engine.capabilities(), FLOW_METHODS[root.id])) {
        void vscode.window.showInformationMessage(`GitGlasses: ${CLI_UNAVAILABLE_MESSAGE}.`);
        continue;
      }
      let result: FlowStatus;
      try {
        result = await FLOWS[root.id](ctx);
      } catch (error) {
        void vscode.window.showErrorMessage(
          `GitGlasses: ${root.id} failed: ${errorMessage(error)}`,
        );
        return;
      }
      if (result !== 'backedOut') return;
    }
  });
}
