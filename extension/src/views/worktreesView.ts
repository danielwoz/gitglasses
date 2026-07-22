// Worktrees sidebar view plus its add/open/remove commands. The provider
// refreshes itself on worktree/HEAD changes; commands refresh it after
// mutations as well since the watcher may lag.

import * as vscode from 'vscode';
import * as path from 'node:path';
import { EngineClient } from '../engine/engineClient';
import { RepositoryService } from '../model/repositoryService';
import { ActiveRepo, ViewBase, ViewNode, firstWorkspaceRepo, messageNode } from './viewBase';
import {
  defaultWorktreePath,
  isSameWorktreePath,
  worktreeDescription,
  worktreeLabel,
} from './worktreeLogic';
import { confirmWorktreeForceRemove, confirmWorktreeRemove } from '../commands/confirmations';
import { confirmDestructive, errorMessage, setStatus, showPick } from '../commands/ui';
import { shortSha } from './viewLogic';

interface WorktreeNode extends ViewNode {
  worktreePath?: string;
}

export class WorktreesViewProvider extends ViewBase {
  constructor(engine: EngineClient, repos: RepositoryService) {
    super(engine, repos);
    this.disposables.push(
      engine.onNotification('repo/didChange', (params) => {
        if (!Array.isArray(params?.changed)) return;
        if (params.changed.includes('worktrees') || params.changed.includes('HEAD')) {
          this.refresh();
        }
      }),
    );
  }

  protected async getRootNodes(repo: ActiveRepo): Promise<ViewNode[]> {
    const { worktrees } = await this.engine.request('worktree/list', { repoId: repo.repoId });
    if (worktrees.length === 0) return [messageNode('No worktrees')];
    return worktrees.map((worktree) => {
      const current = isSameWorktreePath(worktree.path, repo.rootPath);
      const item = new vscode.TreeItem(
        worktreeLabel(worktree.path),
        vscode.TreeItemCollapsibleState.None,
      );
      item.description = worktreeDescription(worktree, current);
      item.iconPath = new vscode.ThemeIcon(current ? 'folder-active' : 'folder');
      item.tooltip = `${worktree.path}\n${worktree.branch ?? '(detached)'} @ ${worktree.sha}${
        worktree.locked ? '\nlocked' : ''
      }`;
      item.contextValue = current ? 'gitglassesCurrentWorktree' : 'gitglassesWorktree';
      const node: WorktreeNode = { item, sha: worktree.sha, worktreePath: worktree.path };
      return node;
    });
  }
}

async function activeRepoOrWarn(repos: RepositoryService): Promise<ActiveRepo | undefined> {
  let repo: ActiveRepo | undefined;
  try {
    repo = await firstWorkspaceRepo(repos);
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

export function registerWorktreeCommands(
  engine: EngineClient,
  repos: RepositoryService,
  view: WorktreesViewProvider,
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
  ];
}
