import * as vscode from 'vscode';
import { CommitSummaryInfo } from '@gitglasses/protocol';
import { ActiveRepo, ViewBase, ViewNode, firstWorkspaceRepo, messageNode } from './viewBase';
import { commitNode } from './nodes';
import { isFullOrAbbreviatedSha } from './viewLogic';

const SEARCH_LIMIT = 200;

// Holds the last search's results; the viewsWelcome contribution shows the
// "Search Commits…" button while the tree is empty.
export class SearchViewProvider extends ViewBase {
  private lastQuery: string | undefined;
  private results: CommitSummaryInfo[] = [];
  private truncated = false;
  private streamCounter = 0;

  override async getChildren(node?: ViewNode): Promise<ViewNode[]> {
    // Before any search: an empty tree lets the welcome content show.
    if (!node && this.lastQuery === undefined) return [];
    return super.getChildren(node);
  }

  protected async getRootNodes(_repo: ActiveRepo): Promise<ViewNode[]> {
    const header = messageNode(
      `${this.results.length}${this.truncated ? '+' : ''} result${
        this.results.length === 1 ? '' : 's'
      } for "${this.lastQuery}"`,
    );
    header.item.iconPath = new vscode.ThemeIcon('search');
    if (this.results.length === 0) return [header];
    return [header, ...this.results.map((commit) => commitNode(commit))];
  }

  /** Prompts for a query and runs a commit search on the first repo. */
  async searchCommits(): Promise<void> {
    const text = await vscode.window.showInputBox({
      prompt: 'Search commits (message text, or a 7-40 hex sha)',
      placeHolder: 'fix login crash | 1a2b3c4d',
      value: this.lastQuery,
    });
    if (!text) return;

    let repo: ActiveRepo | undefined;
    try {
      repo = await firstWorkspaceRepo(this.repos);
    } catch {
      repo = undefined;
    }
    if (!repo) {
      void vscode.window.showWarningMessage('GitGlasses: no git repository to search.');
      return;
    }

    const streamId = `search-${this.streamCounter++}`;
    const matches: CommitSummaryInfo[] = [];
    const sub = this.engine.onNotification('search/matches', (params) => {
      if (params.streamId === streamId) matches.push(...params.matches);
    });
    try {
      const query = isFullOrAbbreviatedSha(text) ? { sha: text } : { text };
      const result = await this.engine.request('search/commits', {
        repoId: repo.repoId,
        streamId,
        limit: SEARCH_LIMIT,
        query,
      });
      this.truncated = result.truncated;
    } catch {
      void vscode.window.showWarningMessage('GitGlasses: commit search failed.');
      return;
    } finally {
      sub.dispose();
    }

    this.lastQuery = text;
    this.results = matches;
    this.fireChange();
    await vscode.commands.executeCommand('gitglasses.views.searchCompare.focus');
  }
}
