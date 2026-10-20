// Worktrees sidebar view plus its commands. Each row shows a worktree's
// status at a glance (uncommitted paths, ahead/behind the base, whether it
// merges cleanly, the coding agent working in it), loaded lazily a few rows
// at a time. The provider refreshes itself on worktree, HEAD and ref changes;
// commands refresh it after mutations as well since the watcher may lag.

import * as vscode from 'vscode';
import * as path from 'node:path';
import type { WorktreeEntry, WorktreeStatus } from '@gitglasses/protocol';
import { EngineClient } from '@gitglasses/rpc';
import { RepositoryService } from '../model/repositoryService';
import { ActiveRepo, ViewBase, ViewNode, activeWorkspaceRepo, withRepo } from './viewBase';
import {
  StatusEntry,
  WorktreeStatusCache,
  confirmDiscardWorktreeChanges,
  confirmWorktreeAndBranchRemove,
  defaultWorktreePath,
  statusKey,
  worktreeContext,
  worktreeDescription,
  worktreeLabel,
  worktreeRowLabel,
  worktreeTooltip,
} from './worktreeLogic';
import { CompareEntry, compareEntries, workingTreeCompareEntries } from './refActionsLogic';
import { confirmWorktreeForceRemove, confirmWorktreeRemove } from '../commands/confirmations';
import { confirmDestructive, errorMessage, setStatus, showPick } from '../commands/ui';
import { encodeRevisionUri } from '../scm/revisionContentProvider';
import { shortSha } from '@gitglasses/protocol/sha';

interface WorktreeNode extends ViewNode {
  worktreePath?: string;
  worktree?: WorktreeEntry;
  repo?: ActiveRepo;
}

/** Per-repository base the rows compare with, in workspace state. */
const BASE_KEY_PREFIX = 'gitglasses.worktrees.base:';

/** Lets a burst of repository changes (an agent committing, a rebase in a
 *  worktree) settle into one reload. */
const REFRESH_SETTLE_MS = 1000;

/** What one row shows, for the e2e suite. */
export interface WorktreeRow {
  label: string;
  description: string;
  tooltip: string;
  contextValue: string;
  /** Status loads still queued or running. */
  loading: number;
  /** The row's node, as its context menu commands receive it. */
  node: ViewNode;
}

export class WorktreesViewProvider extends ViewBase {
  private readonly statuses: WorktreeStatusCache;
  /** The rows of the last render, by worktree path. */
  private nodes = new Map<string, WorktreeNode>();
  /** The repository the rows were listed for. */
  private listedRepo: ActiveRepo | undefined;
  private settleTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    engine: EngineClient,
    repos: RepositoryService,
    private readonly state?: vscode.Memento,
  ) {
    super(engine, repos);
    this.statuses = new WorktreeStatusCache(
      (worktreePath) => this.loadStatus(worktreePath),
      (worktreePath) => this.statusLoaded(worktreePath),
    );
    this.disposables.push(
      engine.onNotification('repo/didChange', (params) => {
        if (!Array.isArray(params?.changed)) return;
        const relevant = ['worktrees', 'HEAD', 'refs', 'index'];
        if (params.changed.some((change) => relevant.includes(change))) this.settleThenRefresh();
      }),
      { dispose: () => clearTimeout(this.settleTimer) },
    );
  }

  /** The base the user chose for `repo`; undefined means the engine's default
   *  (the branch checked out in the main worktree). */
  baseFor(repo: ActiveRepo | undefined): string | undefined {
    return repo ? this.state?.get<string>(BASE_KEY_PREFIX + repo.rootPath) : undefined;
  }

  async setBase(repo: ActiveRepo, base: string | undefined): Promise<void> {
    await this.state?.update(BASE_KEY_PREFIX + repo.rootPath, base);
    this.refresh();
  }

  protected invalidate(): void {
    this.statuses.invalidate();
  }

  private settleThenRefresh(): void {
    clearTimeout(this.settleTimer);
    this.settleTimer = setTimeout(() => this.refresh(), REFRESH_SETTLE_MS);
  }

  protected async getRootNodes(repo: ActiveRepo): Promise<ViewNode[]> {
    const { worktrees } = await this.engine.request('worktree/list', { repoId: repo.repoId });
    // An empty list shows the view's state lines, which explain worktrees.
    if (worktrees.length === 0) return [];
    this.listedRepo = repo;
    const base = this.baseFor(repo);
    this.statuses.retain(new Set(worktrees.map((worktree) => worktree.path)));
    const nodes = new Map<string, WorktreeNode>();
    const rows = worktrees.map((worktree, index) => {
      const item = new vscode.TreeItem(
        worktreeRowLabel(worktree),
        vscode.TreeItemCollapsibleState.None,
      );
      item.iconPath = new vscode.ThemeIcon(
        worktree.current ? 'folder-active' : worktree.prunable ? 'warning' : 'folder',
      );
      item.contextValue = worktreeContext(worktree, index);
      const node: WorktreeNode = {
        item,
        sha: worktree.sha || undefined,
        worktreePath: worktree.path,
        worktree,
        repo,
      };
      // Bare repositories and vanished directories have no status to load.
      const entry =
        worktree.bare || worktree.prunable
          ? undefined
          : this.statuses.get(worktree.path, statusKey(worktree, base));
      render(node, worktree, entry);
      nodes.set(worktree.path, node);
      return node;
    });
    this.nodes = nodes;
    return rows;
  }

  private async loadStatus(worktreePath: string): Promise<WorktreeStatus> {
    const repo = this.listedRepo;
    if (!repo) throw new Error('no repository listed');
    try {
      return await this.engine.request('worktree/status', {
        repoId: repo.repoId,
        path: worktreePath,
        base: this.baseFor(repo),
      });
    } catch (error) {
      this.logFailure(error);
      throw error;
    }
  }

  private statusLoaded(worktreePath: string): void {
    const node = this.nodes.get(worktreePath);
    if (!node?.worktree) return;
    const entry = this.statuses.get(
      worktreePath,
      statusKey(node.worktree, this.baseFor(this.listedRepo)),
    );
    render(node, node.worktree, entry);
    this.fireNode(node);
  }

  /** The rows as they render now, listing them first. */
  async rows(): Promise<WorktreeRow[]> {
    await this.getChildren();
    return [...this.nodes.values()].map((node) => ({
      label: String(node.item.label ?? ''),
      description: String(node.item.description ?? ''),
      tooltip: String(node.item.tooltip ?? ''),
      contextValue: node.item.contextValue ?? '',
      loading: this.statuses.busy,
      node,
    }));
  }
}

function render(node: WorktreeNode, worktree: WorktreeEntry, entry: StatusEntry | undefined): void {
  node.item.description = worktreeDescription(worktree, entry?.status);
  node.item.tooltip = worktreeTooltip(worktree, entry?.status, { error: entry?.error });
}

async function activeRepoOrWarn(repos: RepositoryService): Promise<ActiveRepo | undefined> {
  let repo: ActiveRepo | undefined;
  try {
    repo = await activeWorkspaceRepo(repos);
  } catch {
    repo = undefined;
  }
  if (!repo) {
    void vscode.window.showWarningMessage('GitGlasses: no git repository in this workspace.');
  }
  return repo;
}

async function addWorktree(
  engine: EngineClient,
  repos: RepositoryService,
  view: WorktreesViewProvider,
): Promise<void> {
  const repo = await activeRepoOrWarn(repos);
  if (!repo) return;
  let branches;
  try {
    ({ branches } = await engine.request('refs/list', { repoId: repo.repoId }));
  } catch (error) {
    void vscode.window.showErrorMessage(`GitGlasses: add worktree failed: ${errorMessage(error)}`);
    return;
  }
  const refPick = await showPick(
    branches.map((branch) => ({
      label: branch.name,
      description: shortSha(branch.sha) + (branch.current ? ' (current)' : ''),
    })),
    { title: 'Add Worktree', placeholder: 'Ref to check out in the new worktree' },
  );
  if (refPick === 'back' || !refPick) return;
  const ref = refPick.label;

  const suggested = defaultWorktreePath(repo.rootPath, ref);
  const enteredPath = await vscode.window.showInputBox({
    prompt: 'Worktree path (relative paths resolve against the repository root)',
    value: suggested,
    validateInput: (value) => (value.trim() ? undefined : 'Path is required'),
  });
  if (!enteredPath?.trim()) return;
  const worktreePath = path.resolve(repo.rootPath, enteredPath.trim());

  const newBranch = await vscode.window.showInputBox({
    prompt: 'New branch name (leave empty to check out the ref directly)',
    value: '',
  });
  if (newBranch === undefined) return;

  try {
    await engine.request('worktree/add', {
      repoId: repo.repoId,
      path: worktreePath,
      ref,
      createBranch: newBranch.trim() || undefined,
    });
  } catch (error) {
    void vscode.window.showErrorMessage(`GitGlasses: add worktree failed: ${errorMessage(error)}`);
    return;
  }
  view.refresh();
  setStatus(`Added worktree at ${worktreePath}`);
}

async function removeWorktree(
  engine: EngineClient,
  repos: RepositoryService,
  view: WorktreesViewProvider,
  node?: WorktreeNode,
): Promise<void> {
  const worktreePath = node?.worktreePath;
  if (!worktreePath) return;
  const repo = await activeRepoOrWarn(repos);
  if (!repo) return;
  if (!(await confirmDestructive(confirmWorktreeRemove(worktreePath)))) return;
  try {
    await engine.request('worktree/remove', {
      repoId: repo.repoId,
      path: worktreePath,
      force: false,
    });
  } catch {
    // A dirty or locked worktree refuses a plain remove; offer a forced one.
    if (!(await confirmDestructive(confirmWorktreeForceRemove(worktreePath)))) return;
    try {
      await engine.request('worktree/remove', {
        repoId: repo.repoId,
        path: worktreePath,
        force: true,
      });
    } catch (error) {
      void vscode.window.showErrorMessage(
        `GitGlasses: remove worktree failed: ${errorMessage(error)}`,
      );
      return;
    }
  }
  view.refresh();
  setStatus(`Removed worktree at ${worktreePath}`);
}

/** The status a command acts on, read now rather than from the row. */
function freshStatus(
  engine: EngineClient,
  view: WorktreesViewProvider,
  repo: ActiveRepo,
  worktree: WorktreeEntry,
): Promise<WorktreeStatus> {
  return engine.request('worktree/status', {
    repoId: repo.repoId,
    path: worktree.path,
    base: view.baseFor(repo),
  });
}

/** Removes a worktree and deletes its branch after one confirmation that
 *  names both; uncommitted changes need a second one. */
async function removeWorktreeAndBranch(
  engine: EngineClient,
  repos: RepositoryService,
  view: WorktreesViewProvider,
  node?: WorktreeNode,
): Promise<void> {
  const worktree = node?.worktree;
  if (!worktree || worktree.current || worktree.bare) return;
  await withRepo(
    repos,
    'remove worktree',
    async (repo) => {
      const status = await freshStatus(engine, view, repo, worktree);
      if (!(await confirmDestructive(confirmWorktreeAndBranchRemove(worktree, status)))) return;
      const dirty = status.dirty ?? 0;
      if (
        dirty > 0 &&
        !(await confirmDestructive(confirmDiscardWorktreeChanges(worktree, dirty)))
      ) {
        return;
      }
      try {
        await engine.request('worktree/remove', {
          repoId: repo.repoId,
          path: worktree.path,
          force: dirty > 0,
        });
        // The user agreed to lose the branch's unmerged commits above.
        if (worktree.branch) {
          await engine.request('mutate/branchDelete', {
            repoId: repo.repoId,
            name: worktree.branch,
            force: true,
          });
        }
      } finally {
        view.refresh();
      }
      setStatus(
        worktree.branch
          ? `Removed worktree ${worktreeLabel(worktree.path)} and branch ${worktree.branch}`
          : `Removed worktree ${worktreeLabel(worktree.path)}`,
      );
    },
    node?.repo,
  );
}

/** Opens what a worktree changed since it left the base: the merge base
 *  against its HEAD, plus its uncommitted work when it has any, in one
 *  multi-file diff editor. */
async function compareWithBase(
  engine: EngineClient,
  repos: RepositoryService,
  view: WorktreesViewProvider,
  log: (line: string) => void,
  node?: WorktreeNode,
): Promise<void> {
  const worktree = node?.worktree;
  if (!worktree || worktree.bare || worktree.prunable) return;
  await withRepo(
    repos,
    'compare with base',
    async (repo) => {
      const status = await freshStatus(engine, view, repo, worktree);
      const base = status.base;
      if (!base) {
        void vscode.window.showInformationMessage(
          'GitGlasses: no base to compare with. Choose one with "Choose Base for Worktrees…".',
        );
        return;
      }
      const left = base.mergeBase ?? base.sha;
      const label = worktreeRowLabel(worktree);
      // Commits are shared by every worktree, so the repository listing the
      // worktrees reads them; the working tree needs the worktree itself.
      const { files } = await engine.request('diff/refs', {
        repoId: repo.repoId,
        base: left,
        head: worktree.sha,
      });
      let entries: CompareEntry[] = compareEntries(files);
      let right: (file: string) => vscode.Uri = (file) =>
        encodeRevisionUri(repo.repoId, file, worktree.sha);
      let title = `${base.ref} ↔ ${label}`;
      if ((status.dirty ?? 0) > 0) {
        const root = vscode.Uri.file(worktree.path);
        const located = await repos.locateOrDiscover(vscode.Uri.joinPath(root, '.gitglasses'), {
          watch: false,
        });
        if (located) {
          const wip = await engine.request('status/summary', { repoId: located.repoId });
          entries = workingTreeCompareEntries(files, wip);
          right = (file) => vscode.Uri.joinPath(root, ...file.split('/'));
          title = `${base.ref} ↔ ${label} (Working Tree)`;
        } else {
          log(`compare with base: ${worktree.path} did not resolve; comparing commits only`);
        }
      }
      await openComparison(
        title,
        entries,
        worktree.path,
        (file) => encodeRevisionUri(repo.repoId, file, left),
        right,
        log,
      );
    },
    node?.repo,
  );
}

async function openComparison(
  title: string,
  entries: readonly CompareEntry[],
  worktreePath: string,
  left: (file: string) => vscode.Uri,
  right: (file: string) => vscode.Uri,
  log: (line: string) => void,
): Promise<void> {
  if (entries.length === 0) {
    void vscode.window.showInformationMessage(`GitGlasses: ${title}: no differences.`);
    return;
  }
  const root = vscode.Uri.file(worktreePath);
  const resources = entries.map((entry) => [
    vscode.Uri.joinPath(root, ...entry.path.split('/')),
    entry.left === undefined ? undefined : left(entry.left),
    entry.right === undefined ? undefined : right(entry.right),
  ]);
  try {
    await vscode.commands.executeCommand('vscode.changes', title, resources);
    return;
  } catch (error) {
    // vscode.changes is missing on some hosts (older VS Code builds, Theia).
    log(`multi-file diff unavailable, listing files instead: ${errorMessage(error)}`);
  }
  const picked = await showPick(
    entries.map((entry) => ({ label: entry.path, entry })),
    { title, placeholder: 'File to compare' },
  );
  if (picked === 'back' || !picked) return;
  const { entry } = picked;
  await vscode.commands.executeCommand(
    'vscode.diff',
    left(entry.left ?? entry.path),
    right(entry.right ?? entry.path),
    `${entry.path} (${title})`,
  );
}

/** Picks the branch the rows compare with, or the default. */
async function chooseBase(
  engine: EngineClient,
  repos: RepositoryService,
  view: WorktreesViewProvider,
): Promise<void> {
  await withRepo(repos, 'choose base', async (repo) => {
    const refs = await engine.request('refs/list', { repoId: repo.repoId });
    const current = view.baseFor(repo);
    const mark = (name: string): string | undefined =>
      name === current ? 'current base' : undefined;
    type BaseItem = vscode.QuickPickItem & { base?: string };
    const items: BaseItem[] = [
      {
        label: '$(home) Main worktree branch',
        description: current === undefined ? 'current base' : undefined,
        detail: 'Compare with the branch checked out in the main worktree',
      },
      { label: 'Branches', kind: vscode.QuickPickItemKind.Separator },
      ...refs.branches.map((branch) => ({
        label: branch.name,
        description: mark(branch.name),
        base: branch.name,
      })),
      { label: 'Remote branches', kind: vscode.QuickPickItemKind.Separator },
      ...refs.remotes.flatMap((remote) =>
        remote.branches.map((branch) => {
          const name = `${remote.name}/${branch.name}`;
          return { label: name, description: mark(name), base: name };
        }),
      ),
    ];
    const picked = await showPick(items, {
      title: 'Choose Base for Worktrees',
      placeholder: 'Branch the worktrees are compared and merge-checked against',
    });
    if (picked === 'back' || !picked) return;
    await view.setBase(repo, picked.base);
  });
}

export function registerWorktreeCommands(
  engine: EngineClient,
  repos: RepositoryService,
  view: WorktreesViewProvider,
  log: (line: string) => void,
): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand('gitglasses.worktrees.open', (node?: WorktreeNode) => {
      if (!node?.worktreePath) return;
      return vscode.commands.executeCommand(
        'vscode.openFolder',
        vscode.Uri.file(node.worktreePath),
        { forceNewWindow: true },
      );
    }),
    vscode.commands.registerCommand('gitglasses.worktrees.add', () =>
      addWorktree(engine, repos, view),
    ),
    vscode.commands.registerCommand('gitglasses.worktrees.remove', (node?: WorktreeNode) =>
      removeWorktree(engine, repos, view, node),
    ),
    vscode.commands.registerCommand(
      'gitglasses.worktrees.removeWithBranch',
      (node?: WorktreeNode) => removeWorktreeAndBranch(engine, repos, view, node),
    ),
    vscode.commands.registerCommand('gitglasses.worktrees.compareWithBase', (node?: WorktreeNode) =>
      compareWithBase(engine, repos, view, log, node),
    ),
    vscode.commands.registerCommand('gitglasses.worktrees.chooseBase', () =>
      chooseBase(engine, repos, view),
    ),
    vscode.commands.registerCommand('_gitglasses.worktreeRows', () => view.rows()),
  ];
}
