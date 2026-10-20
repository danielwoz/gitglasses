// Git command palette: a root QuickPick of git operations, each backed by a
// small multi-step flow (quickFlow) with back navigation to the root picker.

import * as vscode from 'vscode';
import { EngineClient } from '@gitglasses/rpc';
import { isMethodAvailable, unavailableMessage } from '../engine/capabilityGate';
import { RepositoryService, repoName } from '../model/repositoryService';
import type { WorkspaceRepo } from '../model/activeRepo';
import { ActiveRepo, activeWorkspaceRepo } from '../views/viewBase';
import { allowedDespiteConflicts } from './conflictGuard';
import { back, cancel, next, runFlow } from './quickFlow';
import {
  Confirmation,
  confirmBranchDelete,
  confirmBranchForceDelete,
  confirmCherryPick,
  confirmMerge,
  confirmResetHard,
  confirmStashDrop,
  inRepository,
} from './confirmations';
import { choosePaletteRepo, paletteTitle } from './paletteRepo';
import { shortSha } from '@gitglasses/protocol/sha';
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
  id: CommandId | 'repository';
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

// Flows git refuses while a merge, rebase or cherry-pick is unresolved, with
// the wording the confirmation uses. Commit, push and fetch are left out:
// committing the resolution is how a conflicted merge is finished, and the
// other two do not touch the working tree.
const CONFLICT_GUARDED: Partial<Record<CommandId, string>> = {
  branch: 'branch',
  merge: 'merge',
  rebase: 'rebase',
  stash: 'stash',
  pull: 'pull',
  reset: 'reset',
  cherryPick: 'cherry-pick',
};

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

/** A repository the palette acts on, with the name every prompt shows. */
interface PaletteRepo extends ActiveRepo {
  name: string;
}

/** Opens the interactive rebase editor on `repo`. */
export type OpenRebase = (upstream: string, repo: ActiveRepo) => void | Promise<void>;

interface PaletteContext {
  engine: EngineClient;
  repo: PaletteRepo;
  openRebase: OpenRebase;
}

/** A step's title, naming the repository the flow acts on. */
function titled(ctx: PaletteContext, title: string): string {
  return `${title} — ${ctx.repo.name}`;
}

/** The destructive-operation modal, naming the repository. */
function confirmIn(ctx: PaletteContext, confirmation: Confirmation): Promise<boolean> {
  return confirmDestructive(inRepository(confirmation, ctx.repo));
}

/** A status bar report of what a flow did, naming the repository. */
function report(ctx: PaletteContext, message: string): void {
  setStatus(`${message} in ${ctx.repo.name}`);
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
      description: `${shortSha(branch.sha)}${branch.current ? ' (current)' : ''}`,
    })),
    { title: titled(ctx, options.title), placeholder: options.placeholder, back: true },
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
      `Nothing is staged in ${repo.name}.`,
      {
        modal: true,
        detail: `Repository: ${repo.rootPath}\n\nStage all ${stageable.length} changed file(s) and continue?`,
      },
      'Stage All',
    );
    if (choice !== 'Stage All') return 'cancelled';
    await engine.request('stage/files', { repoId: repo.repoId, paths: stageable, action: 'stage' });
  }
  const flow = await runFlow<{ message: string }>({ message: '' }, [
    async (state) => {
      const message = await showInput({
        title: titled(ctx, 'Commit'),
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
  report(ctx, `Committed ${shortSha(sha)}`);
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
    { title: titled(ctx, 'Branch'), placeholder: 'Branch operation', back: true },
  );
  if (sub === 'back') return 'backedOut';
  if (!sub) return 'cancelled';

  if (sub.id === 'create') {
    const flow = await runFlow<{ name: string; checkout: boolean }>(
      { name: '', checkout: true },
      [
        async (state) => {
          const name = await showInput({
            title: titled(ctx, 'Create Branch'),
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
            {
              title: titled(ctx, 'Create Branch'),
              placeholder: `Create '${state.name}'`,
              back: true,
            },
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
    report(ctx, `Created branch '${flow.state.name}'`);
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
    report(ctx, `Switched to '${picked.name}'`);
    return 'completed';
  }

  const picked = await pickBranch(ctx, {
    title: 'Delete Branch',
    placeholder: 'Branch to delete',
    excludeCurrent: true,
  });
  if (picked === 'back' || picked === undefined) return 'cancelled';
  const name = picked.name;
  if (!(await confirmIn(ctx, confirmBranchDelete(name)))) return 'cancelled';
  try {
    await engine.request('mutate/branchDelete', { repoId: repo.repoId, name, force: false });
  } catch {
    if (!(await confirmIn(ctx, confirmBranchForceDelete(name)))) return 'cancelled';
    await engine.request('mutate/branchDelete', { repoId: repo.repoId, name, force: true });
  }
  report(ctx, `Deleted branch '${name}'`);
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
  if (!(await confirmIn(ctx, confirmMerge(picked.name, into)))) return 'cancelled';
  const { conflicts } = await ctx.engine.request('mutate/merge', {
    repoId: ctx.repo.repoId,
    ref: picked.name,
  });
  if (conflicts) showConflictGuidance('Merge');
  else report(ctx, `Merged '${picked.name}' into '${into}'`);
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
  await ctx.openRebase(picked.name, ctx.repo);
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
    { title: titled(ctx, 'Stash'), placeholder: 'Stash operation', back: true },
  );
  if (sub === 'back') return 'backedOut';
  if (!sub) return 'cancelled';

  if (sub.id === 'push') {
    const message = await showInput({
      title: titled(ctx, 'Stash Push'),
      prompt: 'Stash message (optional)',
      back: true,
    });
    if (message === 'back' || message === undefined) return 'cancelled';
    await engine.request('stash/push', {
      repoId: repo.repoId,
      message: message.trim() || undefined,
    });
    report(ctx, 'Stashed changes');
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
    {
      title: titled(ctx, `Stash ${sub.id[0].toUpperCase()}${sub.id.slice(1)}`),
      placeholder: 'Stash entry',
      back: true,
    },
  );
  if (picked === 'back' || !picked) return 'cancelled';
  const { entry } = picked;

  if (sub.id === 'drop') {
    if (!(await confirmIn(ctx, confirmStashDrop(entry.index, entry.message)))) {
      return 'cancelled';
    }
    await engine.request('stash/drop', { repoId: repo.repoId, index: entry.index });
    report(ctx, `Dropped stash@{${entry.index}}`);
    return 'completed';
  }

  const { conflicts } = await engine.request('stash/apply', {
    repoId: repo.repoId,
    index: entry.index,
    pop: sub.id === 'pop',
  });
  if (conflicts) showConflictGuidance('Stash apply');
  else report(ctx, `${sub.id === 'pop' ? 'Popped' : 'Applied'} stash@{${entry.index}}`);
  return 'completed';
}

async function pushFlow(ctx: PaletteContext): Promise<FlowStatus> {
  const status = await ctx.engine.request('status/summary', { repoId: ctx.repo.repoId });
  const setUpstream = !status.upstream;
  await ctx.engine.request('mutate/push', { repoId: ctx.repo.repoId, setUpstream });
  report(ctx, `Pushed '${status.branch}'${setUpstream ? ' (set upstream)' : ''}`);
  return 'completed';
}

async function pullFlow(ctx: PaletteContext): Promise<FlowStatus> {
  await ctx.engine.request('mutate/pull', { repoId: ctx.repo.repoId, autoStash: true });
  report(ctx, 'Pulled (auto-stash)');
  return 'completed';
}

async function fetchFlow(ctx: PaletteContext): Promise<FlowStatus> {
  const picked = await showPick(
    [
      { label: 'Fetch', description: 'git fetch', prune: false },
      { label: 'Fetch (prune)', description: 'git fetch --prune', prune: true },
    ],
    { title: titled(ctx, 'Fetch'), placeholder: 'Fetch remotes', back: true },
  );
  if (picked === 'back') return 'backedOut';
  if (!picked) return 'cancelled';
  await ctx.engine.request('mutate/fetch', { repoId: ctx.repo.repoId, prune: picked.prune });
  report(ctx, picked.prune ? 'Fetched (pruned)' : 'Fetched');
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
        title: titled(ctx, 'Reset'),
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
        { title: titled(ctx, 'Reset'), placeholder: `Reset to ${state.ref}`, back: true },
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
    if (!(await confirmIn(ctx, confirmResetHard(branch, ref)))) return 'cancelled';
  }
  await ctx.engine.request('mutate/reset', { repoId: ctx.repo.repoId, ref, mode });
  report(ctx, `Reset to ${ref} (${mode})`);
  return 'completed';
}

async function cherryPickFlow(ctx: PaletteContext): Promise<FlowStatus> {
  const input = await showInput({
    title: titled(ctx, 'Cherry-pick'),
    prompt: 'Commit sha(s), space separated, in the order to apply',
    back: true,
    validate: (value) => (value.trim() ? undefined : 'At least one sha is required'),
  });
  if (input === 'back') return 'backedOut';
  if (input === undefined) return 'cancelled';
  const shas = input.trim().split(/\s+/);
  if (!(await confirmIn(ctx, confirmCherryPick(shas)))) return 'cancelled';
  const { conflicts } = await ctx.engine.request('mutate/cherryPick', {
    repoId: ctx.repo.repoId,
    shas,
  });
  if (conflicts) showConflictGuidance('Cherry-pick');
  else report(ctx, `Cherry-picked ${shas.length} commit${shas.length === 1 ? '' : 's'}`);
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

export interface GitPaletteOptions {
  /** The workspace's repositories, to switch between. */
  listRepos: () => Promise<readonly WorkspaceRepo[]>;
  /** The file in the editor, whose repository the palette offers first. */
  activeEditorUri: () => vscode.Uri | undefined;
}

function paletteRepo(repo: ActiveRepo, name?: string): PaletteRepo {
  return { ...repo, name: name ?? repoName(repo.workspacePath ?? repo.rootPath) };
}

/** The repository of the file in the editor, if it is in one. */
async function editorRepo(
  repos: RepositoryService,
  options: GitPaletteOptions,
): Promise<PaletteRepo | undefined> {
  const uri = options.activeEditorUri();
  if (!uri) return undefined;
  const located = await repos.locateOrDiscover(uri).catch(() => undefined);
  if (!located) return undefined;
  const listed = (await options.listRepos().catch(() => [])).find(
    (repo) => repo.repoId === located.repoId,
  );
  return listed
    ? paletteRepo(listed, listed.name)
    : paletteRepo({ repoId: located.repoId, rootPath: located.rootPath });
}

/**
 * The repository a palette session starts on: the editor's file's and the
 * views' selected one agree, or there is only one of them; otherwise the
 * user picks, with the editor's first.
 */
async function startingRepo(
  repos: RepositoryService,
  options: GitPaletteOptions,
): Promise<PaletteRepo | undefined> {
  let selected: PaletteRepo | undefined;
  try {
    const active = await activeWorkspaceRepo(repos);
    selected = active && paletteRepo(active);
  } catch {
    selected = undefined;
  }
  const choice = choosePaletteRepo(
    selected,
    await editorRepo(repos, options),
    (a, b) => a.repoId === b.repoId,
  );
  if (choice.kind === 'none') return undefined;
  if (choice.kind === 'use') return choice.repo;
  const picked = await vscode.window.showQuickPick(
    [
      {
        label: `$(file) ${choice.editor.name}`,
        description: 'the active file’s repository',
        detail: choice.editor.rootPath,
        repo: choice.editor,
      },
      {
        label: `$(repo) ${choice.selected.name}`,
        description: 'selected in the GitGlasses views',
        detail: choice.selected.rootPath,
        repo: choice.selected,
      },
    ],
    { title: 'Git Commands', placeHolder: 'Run git commands in which repository?' },
  );
  return picked?.repo;
}

/** Lets the user switch the palette to another of the workspace's
 *  repositories; undefined keeps the current one. */
async function pickOtherRepo(
  current: PaletteRepo,
  all: readonly WorkspaceRepo[],
): Promise<PaletteRepo | undefined> {
  const picked = await showPick(
    all.map((repo) => ({
      label: repo.name,
      description: repo.repoId === current.repoId ? 'current' : undefined,
      detail: repo.workspacePath,
      repo,
    })),
    { title: 'Git Commands', placeholder: 'Run git commands in which repository?', back: true },
  );
  if (picked === 'back' || picked === undefined) return undefined;
  return paletteRepo(picked.repo, picked.repo.name);
}

export function registerGitPalette(
  engine: EngineClient,
  repos: RepositoryService,
  openRebase: OpenRebase,
  options: GitPaletteOptions,
): vscode.Disposable {
  return vscode.commands.registerCommand('gitglasses.gitCommands', async () => {
    let repo = await startingRepo(repos, options);
    if (!repo) {
      void vscode.window.showWarningMessage('GitGlasses: no git repository in this workspace.');
      return;
    }
    // Backing out of a flow returns to the root picker.
    for (;;) {
      const ctx: PaletteContext = { engine, repo, openRebase };
      const all = await options.listRepos().catch(() => [] as readonly WorkspaceRepo[]);
      const caps = engine.capabilities();
      const items: RootItem[] = ROOT_ITEMS.map((item) =>
        isMethodAvailable(caps, FLOW_METHODS[item.id as CommandId])
          ? item
          : { ...item, description: unavailableMessage(caps) },
      );
      if (all.length > 1) {
        items.unshift({
          id: 'repository',
          label: `$(repo) ${repo.name}`,
          description: 'Change repository…',
          detail: repo.workspacePath ?? repo.rootPath,
        });
      }
      const root = await showPick(items, {
        title: paletteTitle(repo.name),
        placeholder: 'Pick a git command',
      });
      if (root === 'back' || root === undefined) return;
      if (root.id === 'repository') {
        repo = (await pickOtherRepo(repo, all)) ?? repo;
        continue;
      }
      const id = root.id;
      // Unavailable flows explain themselves instead of executing.
      if (!isMethodAvailable(engine.capabilities(), FLOW_METHODS[id])) {
        void vscode.window.showInformationMessage(
          `GitGlasses: ${unavailableMessage(engine.capabilities())}.`,
        );
        continue;
      }
      const guarded = CONFLICT_GUARDED[id];
      if (guarded && !(await allowedDespiteConflicts(engine, repo.repoId, guarded))) continue;
      let result: FlowStatus;
      try {
        result = await FLOWS[id](ctx);
      } catch (error) {
        void vscode.window.showErrorMessage(
          `GitGlasses: ${id} failed in ${repo.name}: ${errorMessage(error)}`,
        );
        return;
      }
      if (result !== 'backedOut') return;
    }
  });
}
