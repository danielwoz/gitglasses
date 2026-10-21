import { CommitSummaryInfo } from '@gitglasses/protocol';
import { ActiveRepo, ViewBase, ViewNode, loadMoreNode } from './viewBase';
import { commitNode } from './nodes';
import { PageState, appendPage, emptyPageState } from './viewLogic';
import { viewPageSize } from '../system/settings';

// Pages of commits from HEAD with a "Load more…" tail node.
export class CommitsViewProvider extends ViewBase {
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

    if (this.state.items.length === 0) return [];
    const nodes = this.state.items.map((commit) => commitNode(commit));
    if (this.state.nextCursor !== undefined) {
      const repoId = repo.repoId;
      nodes.push(loadMoreNode(() => void this.loadMore(repoId)));
    }
    return nodes;
  }

  private async fetchPage(repoId: string): Promise<void> {
    const result = await this.engine.request('log/commits', {
      repoId,
      cursor: this.state.nextCursor,
      limit: viewPageSize(),
    });
    this.state = appendPage(this.state, { items: result.commits, nextCursor: result.nextCursor });
  }

  private async loadMore(repoId: string): Promise<void> {
    if (this.repoId !== repoId || this.state.nextCursor === undefined) return;
    try {
      await this.fetchPage(repoId);
    } catch {
      // Keep what we have; the tail node stays and can be retried.
    }
    this.fireChange();
  }
}
