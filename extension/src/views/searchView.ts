import * as vscode from 'vscode';
import { CommitSummaryInfo, ErrorCodes } from '@gitglasses/protocol';
import { ActiveRepo, ViewBase, ViewNode, activeWorkspaceRepo, messageNode } from './viewBase';
import { commitNode } from './nodes';
import { errorMessage } from '../commands/ui';
import { CommitSearchQuery, describeQuery, parseSearchInput } from './searchQuery';
import { searchCommitHistory } from './commitSearch';

const SEARCH_LIMIT = 200;
const VIEW_ID = 'gitglasses.views.searchCompare';
/** A search still running after this long also gets a cancellable notification. */
const NOTIFY_AFTER_MS = 1500;
/** Streamed matches re-render the view at most this often. */
const RENDER_INTERVAL_MS = 250;

const SEARCH_PROMPT =
  'Search commits: words match the message; narrow with author:, change: (code added or removed), diff: (regex), file:, after:, before:';

type SearchState = 'idle' | 'running' | 'done';

/** Explains why the engine refused a search, or undefined for other errors. */
export function searchRefusal(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | undefined)?.code;
  if (code === ErrorCodes.Restricted) {
    return 'Searching by code change or file runs git, which GitGlasses does not do in Restricted Mode. Trust this folder to use it; message, author, date and sha searches still work.';
  }
  if (code === ErrorCodes.MethodNotSupported) {
    return 'Searching by code change or file needs the git command line, which is not available here. Message, author, date and sha searches still work.';
  }
  return undefined;
}

// Holds the last search's results; the viewsWelcome contribution shows the
// "Search Commits…" button while the tree is empty.
export class SearchViewProvider extends ViewBase {
  private lastInput: string | undefined;
  /** What the last search looked for, phrased to follow "commits": the
   *  criteria ("matching \"crash\" by alice"), or an NL question. */
  private lastLabel: string | undefined;
  private results: CommitSummaryInfo[] = [];
  private truncated = false;
  /** Only recent history was searched (a date window applied here). */
  private partial = false;
  private state: SearchState = 'idle';
  private failure: string | undefined;
  private streamCounter = 0;
  private running: vscode.CancellationTokenSource | undefined;

  override async getChildren(node?: ViewNode): Promise<ViewNode[]> {
    // Before any search: an empty tree lets the welcome content show.
    if (!node && this.state === 'idle') return [];
    return super.getChildren(node);
  }

  protected async getRootNodes(_repo: ActiveRepo): Promise<ViewNode[]> {
    const label = this.lastLabel ?? '';
    let header: ViewNode;
    if (this.failure) {
      header = messageNode(this.failure);
      header.item.iconPath = new vscode.ThemeIcon('warning');
      header.item.tooltip = this.failure;
      return [header];
    }
    if (this.state === 'running') {
      const found = this.results.length > 0 ? `, ${this.results.length} found so far` : '';
      header = messageNode(`Searching commits ${label}…${found}`);
      header.item.iconPath = new vscode.ThemeIcon('loading~spin');
    } else {
      const count = this.results.length;
      const recent = this.partial ? ' in recent history (older commits were not searched)' : '';
      header = messageNode(
        count === 0
          ? `No commits ${label}${recent}`
          : `${count}${this.truncated ? '+' : ''} commit${count === 1 ? '' : 's'} ${label}${recent}`,
      );
      header.item.iconPath = new vscode.ThemeIcon('search');
    }
    header.item.tooltip = label;
    return [header, ...this.results.map((commit) => commitNode(commit))];
  }

  /** Prompts for a query and runs a commit search on the active repo. */
  async searchCommits(): Promise<void> {
    const input = await vscode.window.showInputBox({
      prompt: SEARCH_PROMPT,
      placeHolder: 'login crash author:alice change:validateUser file:src/ after:30d',
      value: this.lastInput,
      validateInput: (value) => {
        if (value.trim() === '') return undefined;
        const parsed = parseSearchInput(value);
        return parsed.ok ? undefined : parsed.error;
      },
    });
    if (input === undefined || input.trim() === '') return;
    const parsed = parseSearchInput(input);
    if (!parsed.ok) {
      void vscode.window.showWarningMessage(`GitGlasses: ${parsed.error}`);
      return;
    }
    this.lastInput = input;
    await this.runSearch(parsed.query, describeQuery(parsed.query));
  }

  /**
   * Runs an externally-built query (e.g. AI natural-language search) and shows
   * the results in this view under a human-readable label.
   */
  async runExternalSearch(query: CommitSearchQuery, label: string): Promise<void> {
    await this.runSearch(query, label);
  }

  private async runSearch(query: CommitSearchQuery, label: string): Promise<void> {
    let repo: ActiveRepo | undefined;
    try {
      repo = await activeWorkspaceRepo(this.repos);
    } catch {
      repo = undefined;
    }
    if (!repo) {
      void vscode.window.showWarningMessage('GitGlasses: no git repository to search.');
      return;
    }

    // A new search supersedes one still running.
    this.running?.cancel();
    const cancel = new vscode.CancellationTokenSource();
    this.running = cancel;

    this.lastLabel = label;
    this.results = [];
    this.truncated = false;
    this.partial = false;
    this.failure = undefined;
    this.state = 'running';
    this.fireChange();
    void vscode.commands.executeCommand(`${VIEW_ID}.focus`);

    const streamId = `search-${this.streamCounter++}`;
    let lastRender = 0;
    const search = searchCommitHistory(
      this.engine,
      { repoId: repo.repoId, streamId, limit: SEARCH_LIMIT, query },
      (matches) => {
        if (this.running !== cancel) return;
        this.results.push(...matches);
        const now = Date.now();
        if (now - lastRender >= RENDER_INTERVAL_MS) {
          lastRender = now;
          this.fireChange();
        }
      },
      cancel.token,
    );

    // Long searches (the pickaxe over a big history) get a notification
    // with a Cancel button; quick ones only show the view's progress bar.
    const notifyTimer = setTimeout(() => {
      if (this.running !== cancel) return;
      void vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `GitGlasses: searching commits ${label}`,
          cancellable: true,
        },
        async (_progress, token) => {
          token.onCancellationRequested(() => cancel.cancel());
          await search.catch(() => undefined);
        },
      );
    }, NOTIFY_AFTER_MS);

    try {
      const result = await vscode.window.withProgress(
        { location: { viewId: VIEW_ID } },
        () => search,
      );
      if (this.running !== cancel) return;
      this.truncated = result.truncated;
      this.partial = result.partial;
    } catch (error) {
      if (this.running !== cancel) return;
      if (cancel.token.isCancellationRequested) {
        this.failure = `Search cancelled: commits ${label}`;
      } else {
        this.failure = searchRefusal(error) ?? `Commit search failed: ${errorMessage(error)}`;
        void vscode.window.showWarningMessage(`GitGlasses: ${this.failure}`);
      }
    } finally {
      clearTimeout(notifyTimer);
      if (this.running === cancel) {
        this.running = undefined;
        this.state = 'done';
        this.fireChange();
      }
      cancel.dispose();
    }
  }

  override dispose(): void {
    this.running?.cancel();
    super.dispose();
  }
}
