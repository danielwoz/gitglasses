import * as vscode from 'vscode';
import { EngineClient } from '@gitglasses/rpc';
import { ActiveRepo, ViewBase, ViewNode } from './viewBase';
import { shortSha } from '@gitglasses/protocol/sha';
import type { PrChipProvider } from '../integrations/prChips';
import type { RepositoryService } from '../model/repositoryService';
import type { RefsModel } from '../model/refsModel';
import { SHOW_COMMIT_DETAILS_COMMAND } from '../commitDetails/commitDetails';
import type { RefPayload } from './refActionsLogic';

export { refLabel, refRevision, type RefPayload } from './refActionsLogic';

// Branches, remotes, tags, and stashes: stateless views re-fetched per render.
// The first three read one shared refs/list through RefsModel. None of them
// invalidate that cache themselves — core's refreshViews() drops it before
// refreshing any view, so a refresh always re-fetches. Each node carries the
// repository and ref it shows, which the actions in refCommands read.

const PR_CHIP_LIMIT = 50;

export interface RefNode extends ViewNode {
  repo: ActiveRepo;
  ref: RefPayload;
}

export function isRefNode(value: unknown): value is RefNode {
  const node = value as Partial<RefNode> | undefined;
  return typeof node?.ref?.kind === 'string' && typeof node.repo?.repoId === 'string';
}

// Clicking a ref shows the commit it points at.
function showCommitOnClick(item: vscode.TreeItem, repo: ActiveRepo, sha: string): void {
  item.command = {
    command: SHOW_COMMIT_DETAILS_COMMAND,
    title: 'Show Commit Details',
    arguments: [{ repoPath: repo.rootPath, sha }],
  };
}

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
      item.tooltip = [
        branch.name,
        branch.sha,
        branch.current ? '(current branch)' : '',
        branch.upstream ? `Tracks ${branch.upstream}` : 'Not published',
      ]
        .filter(Boolean)
        .join('\n');
      item.contextValue = branch.current ? 'gitglassesCurrentBranch' : 'gitglassesBranch';
      showCommitOnClick(item, repo, branch.sha);
      const node: RefNode = {
        item,
        sha: branch.sha,
        repo,
        ref: { kind: 'branch', name: branch.name, upstream: branch.upstream, current: branch.current },
      };
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
    const [{ remotes }, urls] = await Promise.all([
      this.refs.list(repo.repoId),
      // URLs are a nicety; the tree still renders without them.
      this.engine
        .request('remote/list', { repoId: repo.repoId })
        .then((result) => new Map(result.remotes.map((remote) => [remote.name, remote.fetchUrl])))
        .catch(() => new Map<string, string>()),
    ]);
    if (remotes.length === 0) return [];
    return remotes.map((remote) => {
      const item = new vscode.TreeItem(
        remote.name,
        vscode.TreeItemCollapsibleState.Collapsed,
      );
      const url = urls.get(remote.name);
      item.iconPath = new vscode.ThemeIcon('cloud');
      item.description = url ?? '';
      item.tooltip = url ? `${remote.name}\n${url}` : remote.name;
      item.contextValue = 'gitglassesRemote';
      const node: RefNode = {
        item,
        repo,
        ref: { kind: 'remote', name: remote.name, url },
        children: () =>
          remote.branches.map((branch) => {
            const child = new vscode.TreeItem(branch.name, vscode.TreeItemCollapsibleState.None);
            child.iconPath = new vscode.ThemeIcon('git-branch');
            child.description = shortSha(branch.sha);
            child.tooltip = `${remote.name}/${branch.name}\n${branch.sha}`;
            child.contextValue = 'gitglassesRemoteBranch';
            showCommitOnClick(child, repo, branch.sha);
            const branchNode: RefNode = {
              item: child,
              sha: branch.sha,
              repo,
              ref: { kind: 'remoteBranch', remote: remote.name, name: branch.name },
            };
            return branchNode;
          }),
      };
      return node;
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
      item.tooltip = `${tag.name}\n${tag.sha}`;
      item.contextValue = 'gitglassesTag';
      showCommitOnClick(item, repo, tag.sha);
      const node: RefNode = { item, sha: tag.sha, repo, ref: { kind: 'tag', name: tag.name } };
      return node;
    });
  }
}

/** Command a stash click runs: its changes in a multi-file diff. */
export const SHOW_STASH_COMMAND = 'gitglasses.stash.show';

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
      const node: RefNode = {
        item,
        sha: entry.sha,
        repo,
        ref: { kind: 'stash', index: entry.index, message: entry.message },
      };
      item.command = { command: SHOW_STASH_COMMAND, title: 'Show Changes', arguments: [node] };
      return node;
    });
  }
}
