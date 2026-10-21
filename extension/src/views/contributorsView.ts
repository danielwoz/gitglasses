import * as vscode from 'vscode';
import { CommitSummaryInfo } from '@gitglasses/protocol';
import { ActiveRepo, ViewBase, ViewNode, loadMoreNode } from './viewBase';
import {
  ContributorStat,
  PageState,
  aggregateContributors,
  appendPage,
  emptyPageState,
} from './viewLogic';
import { relativeTime } from '../system/dates';

/** Commits the sample stops at; further pages are never requested. */
const SAMPLE_LIMIT = 1000;
const FETCH_PAGE = 200;

// Client-side aggregation over the most recent commits: commit counts per
// author email, sorted descending. The first render costs one page; "Load
// more…" widens the sample a page at a time, up to SAMPLE_LIMIT commits.
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
    const nodes = stats.map((stat) => contributorNode(stat));
    if (this.hasMore()) {
      const repoId = repo.repoId;
      nodes.push(loadMoreNode(() => void this.loadMore(repoId)));
    }
    return nodes;
  }

  /** More commits to sample: the engine has another page and the sample cap
   *  has not been reached. */
  private hasMore(): boolean {
    return this.state.nextCursor !== undefined && this.state.items.length < SAMPLE_LIMIT;
  }

  private async fetchPage(repoId: string): Promise<void> {
    const result = await this.engine.request('log/commits', {
      repoId,
      cursor: this.state.nextCursor,
      limit: Math.min(FETCH_PAGE, SAMPLE_LIMIT - this.state.items.length),
    });
    this.state = appendPage(this.state, { items: result.commits, nextCursor: result.nextCursor });
  }

  private async loadMore(repoId: string): Promise<void> {
    if (this.repoId !== repoId || !this.hasMore()) return;
    try {
      await this.fetchPage(repoId);
    } catch {
      // Keep the sample we have; the tail node stays and can be retried.
    }
    this.fireChange();
  }
}

function contributorNode(stat: ContributorStat): ViewNode {
  const item = new vscode.TreeItem(
    `${stat.name} (${stat.count})`,
    vscode.TreeItemCollapsibleState.None,
  );
  item.iconPath = new vscode.ThemeIcon('person');
  item.description = stat.email;
  item.tooltip = `${stat.name} <${stat.email}>\n${stat.count} commit${
    stat.count === 1 ? '' : 's'
  }, last ${relativeTime(stat.lastTime)}`;
  item.contextValue = 'gitglassesContributor';
  return { item };
}
