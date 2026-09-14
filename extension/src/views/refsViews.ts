import * as vscode from 'vscode';
import { EngineClient } from '@gitglasses/rpc';
import { ActiveRepo, ViewBase, ViewNode } from './viewBase';
import { shortSha } from '@gitglasses/protocol/sha';
import type { PrChipProvider } from '../integrations/prChips';
import type { RepositoryService } from '../model/repositoryService';
import type { RefsModel } from '../model/refsModel';

// Branches, remotes, tags, and stashes: stateless views re-fetched per render.
// The first three read one shared refs/list through RefsModel.

const PR_CHIP_LIMIT = 50;

/** Base for the three views that each render a slice of refs/list. */
abstract class RefsViewBase extends ViewBase {
  constructor(
    engine: EngineClient,
    repos: RepositoryService,
    protected readonly refs: RefsModel,
  ) {
    super(engine, repos);
  }
}

export class BranchesViewProvider extends RefsViewBase {
  private prChips: PrChipProvider | undefined;

  setPrChipProvider(prChips: PrChipProvider): void {
    this.prChips = prChips;
  }

  protected async getRootNodes(repo: ActiveRepo): Promise<ViewNode[]> {
    const { branches } = await this.refs.list(repo.repoId);
    if (branches.length === 0) return [];
    const nodes = branches.map((branch) => {
      const item = new vscode.TreeItem(branch.name, vscode.TreeItemCollapsibleState.None);
      item.iconPath = new vscode.ThemeIcon(branch.current ? 'check' : 'git-branch');
      item.description = branch.upstream ?? '';
      item.tooltip = `${branch.name}\n${branch.sha}${branch.current ? '\n(current branch)' : ''}`;
      item.contextValue = branch.current ? 'gitglassesCurrentBranch' : 'gitglassesBranch';
      const node: ViewNode = { item, sha: branch.sha };
      return node;
    });
    this.decorateWithPrChips(
      repo,
      branches.map((branch, index) => ({ name: branch.name, node: nodes[index] })),
    );
    return nodes;
  }

  // Fire-and-forget: chips arrive after the tree renders and refresh only the
  // nodes they decorate, so PR lookups never block or fail the render.
  private decorateWithPrChips(
    repo: ActiveRepo,
    branches: Array<{ name: string; node: ViewNode }>,
  ): void {
    const prChips = this.prChips;
    if (!prChips) return;
    void Promise.allSettled(
      branches.slice(0, PR_CHIP_LIMIT).map(async ({ name, node }) => {
        const suffix = await prChips.getChipFor(repo.rootPath, name);
        if (!suffix) return;
        const base = typeof node.item.description === 'string' ? node.item.description : '';
        node.item.description = base ? `${base} · ${suffix}` : suffix;
        this.fireNode(node);
      }),
    );
  }
}

export class RemotesViewProvider extends RefsViewBase {
  protected async getRootNodes(repo: ActiveRepo): Promise<ViewNode[]> {
    const { remotes } = await this.refs.list(repo.repoId);
    if (remotes.length === 0) return [];
    return remotes.map((remote) => {
      const item = new vscode.TreeItem(
        remote.name,
        vscode.TreeItemCollapsibleState.Collapsed,
      );
      item.iconPath = new vscode.ThemeIcon('cloud');
      item.contextValue = 'gitglassesRemote';
      return {
        item,
        children: () =>
          remote.branches.map((branch) => {
            const child = new vscode.TreeItem(branch.name, vscode.TreeItemCollapsibleState.None);
            child.iconPath = new vscode.ThemeIcon('git-branch');
            child.description = shortSha(branch.sha);
            child.contextValue = 'gitglassesRemoteBranch';
            const node: ViewNode = { item: child, sha: branch.sha };
            return node;
          }),
      };
    });
  }
}

export class TagsViewProvider extends RefsViewBase {
  protected async getRootNodes(repo: ActiveRepo): Promise<ViewNode[]> {
    const { tags } = await this.refs.list(repo.repoId);
    if (tags.length === 0) return [];
    return tags.map((tag) => {
      const item = new vscode.TreeItem(tag.name, vscode.TreeItemCollapsibleState.None);
      item.iconPath = new vscode.ThemeIcon('tag');
      item.description = shortSha(tag.sha);
      item.contextValue = 'gitglassesTag';
      const node: ViewNode = { item, sha: tag.sha };
      return node;
    });
  }
}

export class StashesViewProvider extends ViewBase {
  protected async getRootNodes(repo: ActiveRepo): Promise<ViewNode[]> {
    const { entries } = await this.engine.request('stash/list', { repoId: repo.repoId });
    if (entries.length === 0) return [];
    return entries.map((entry) => {
      const item = new vscode.TreeItem(entry.message, vscode.TreeItemCollapsibleState.None);
      item.iconPath = new vscode.ThemeIcon('archive');
      item.description = entry.branch
        ? `stash@{${entry.index}} on ${entry.branch}`
        : `stash@{${entry.index}}`;
      item.tooltip = `${entry.message}\n${entry.sha}`;
      item.contextValue = 'gitglassesStash';
      const node: ViewNode = { item, sha: entry.sha };
      return node;
    });
  }
}
