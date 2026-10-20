import * as vscode from 'vscode';
import { CommitSummaryInfo } from '@gitglasses/protocol';
import { ActiveRepo, ViewBase, ViewNode } from './viewBase';
import {
  ContributorStat,
  PageState,
  aggregateContributors,
  appendPage,
  contributorShare,
  contributorWindowLabel,
  emptyPageState,
} from './viewLogic';
import { relativeTime } from '../system/dates';

/** Commits the sample stops at; further pages are never requested. */
const SAMPLE_LIMIT = 1000;
const FETCH_PAGE = 200;

// Client-side aggregation over the most recent commits: commit counts per
// author email, sorted descending. The first render costs one page; the tail
// node widens the window a page at a time, up to SAMPLE_LIMIT commits. The
// first node says which window the counts cover, since they are not totals
// until the whole history fits.
export class ContributorsViewProvider extends ViewBase {
  private state: PageState<CommitSummaryInfo> = emptyPageState();
  private repoId: string | undefined;

  protected override invalidate(): void {
    this.state = emptyPageState();
  }

  protected async getRootNodes(repo: ActiveRepo): Promise<ViewNode[]> {
    if (this.repoId !== repo.repoId) {
      this.repoId = repo.repoId;
      this.state = emptyPageState();
    }
    if (!this.state.loaded) await this.fetchPage(repo.repoId);

    const stats = aggregateContributors(this.state.items);
    if (stats.length === 0) return [];
    const sampled = this.state.items.length;
    const complete = this.state.nextCursor === undefined;
    const nodes = [
      windowNode(sampled, complete),
      ...stats.map((stat) => contributorNode(stat, sampled, complete)),
    ];
    if (this.hasMore()) {
      const repoId = repo.repoId;
      nodes.push(widenNode(sampled + this.nextPageSize(), () => void this.loadMore(repoId)));
    }
    return nodes;
  }

  /** More commits to sample: the engine has another page and the sample cap
   *  has not been reached. */
  private hasMore(): boolean {
    return this.state.nextCursor !== undefined && this.state.items.length < SAMPLE_LIMIT;
  }

  private nextPageSize(): number {
    return Math.min(FETCH_PAGE, SAMPLE_LIMIT - this.state.items.length);
  }

  private async fetchPage(repoId: string): Promise<void> {
    const result = await this.engine.request('log/commits', {
      repoId,
      cursor: this.state.nextCursor,
      limit: this.nextPageSize(),
    });
    this.state = appendPage(this.state, { items: result.commits, nextCursor: result.nextCursor });
  }

  private async loadMore(repoId: string): Promise<void> {
    if (this.repoId !== repoId || !this.hasMore()) return;
    try {
      await this.fetchPage(repoId);
    } catch (error) {
      // Keep the sample we have; the tail node stays and can be retried.
      this.logFailure(error);
    }
    this.fireChange();
  }
}

/** Heads the list with the window the counts cover. */
function windowNode(sampled: number, complete: boolean): ViewNode {
  const item = new vscode.TreeItem(
    contributorWindowLabel(sampled, complete),
    vscode.TreeItemCollapsibleState.None,
  );
  item.iconPath = new vscode.ThemeIcon('history');
  item.description = complete ? undefined : 'on HEAD';
  item.tooltip = complete
    ? 'Commit counts cover the whole history of HEAD.'
    : `Commit counts cover the ${sampled} most recent commits on HEAD, not the whole history.`;
  item.contextValue = 'gitglassesMessage';
  return { item };
}

function widenNode(target: number, widen: () => void): ViewNode {
  const item = new vscode.TreeItem(
    `Count the last ${target} commits`,
    vscode.TreeItemCollapsibleState.None,
  );
  item.iconPath = new vscode.ThemeIcon('ellipsis');
  item.contextValue = 'gitglassesLoadMore';
  item.command = { command: 'gitglasses.loadMore', title: 'Load More', arguments: [widen] };
  return { item };
}

function contributorNode(stat: ContributorStat, sampled: number, complete: boolean): ViewNode {
  const item = new vscode.TreeItem(
    `${stat.name} (${stat.count})`,
    vscode.TreeItemCollapsibleState.None,
  );
  item.iconPath = new vscode.ThemeIcon('person');
  item.description = stat.email;
  item.tooltip = `${stat.name} <${stat.email}>\n${contributorShare(
    stat.count,
    sampled,
    complete,
  )}, last ${relativeTime(stat.lastTime)}`;
  item.contextValue = 'gitglassesContributor';
  return { item };
}
