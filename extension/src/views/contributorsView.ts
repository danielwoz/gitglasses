import * as vscode from 'vscode';
import { CommitSummaryInfo } from '@gitglasses/protocol';
import { ActiveRepo, ViewBase, ViewNode, messageNode } from './viewBase';
import { ContributorStat, aggregateContributors } from './viewLogic';
import { relativeTime } from '../system/dates';

const SAMPLE_LIMIT = 1000;
const FETCH_PAGE = 200;

// Client-side aggregation over the most recent commits (up to 1000, fetched
// in pages): commit counts per author email, sorted descending.
export class ContributorsViewProvider extends ViewBase {
  private stats: ContributorStat[] | undefined;
  private repoId: string | undefined;

  protected override invalidate(): void {
    this.stats = undefined;
  }

  protected async getRootNodes(repo: ActiveRepo): Promise<ViewNode[]> {
    if (this.repoId !== repo.repoId) {
      this.repoId = repo.repoId;
      this.stats = undefined;
    }
    if (!this.stats) {
      const commits: CommitSummaryInfo[] = [];
      let cursor: string | undefined;
      while (commits.length < SAMPLE_LIMIT) {
        const page = await this.engine.request('log/commits', {
          repoId: repo.repoId,
          cursor,
          limit: Math.min(FETCH_PAGE, SAMPLE_LIMIT - commits.length),
        });
        commits.push(...page.commits);
        if (page.nextCursor === undefined || page.commits.length === 0) break;
        cursor = page.nextCursor;
      }
      this.stats = aggregateContributors(commits);
    }

    if (this.stats.length === 0) return [messageNode('No commits')];
    return this.stats.map((stat) => {
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
    });
  }
}
