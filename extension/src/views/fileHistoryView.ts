import * as vscode from 'vscode';
import { FileHistoryEntry } from '@gitglasses/protocol';
import { LocatedFile, RepositoryService } from '../model/repositoryService';
import { EngineClient } from '@gitglasses/rpc';
import {
  ActiveRepo,
  ViewBase,
  ViewNode,
  loadMoreNode,
  messageNode,
  setViewState,
} from './viewBase';
import { fileHistoryNode } from './nodes';
import { PageState, appendPage, emptyPageState } from './viewLogic';
import { viewPageSize } from '../system/settings';

// Follows the active editor and pages that file's history (rename-following
// is the engine's job; entries carry the path at each commit).
export class FileHistoryViewProvider extends ViewBase {
  private current: LocatedFile | undefined;
  private state: PageState<FileHistoryEntry> = emptyPageState();

  constructor(engine: EngineClient, repos: RepositoryService) {
    super(engine, repos);
    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor((editor) => void this.trackEditor(editor)),
    );
    void this.trackEditor(vscode.window.activeTextEditor);
  }

  private async trackEditor(editor: vscode.TextEditor | undefined): Promise<void> {
    // Ignore non-file editors (output panes, diffs) so the last file's
    // history stays visible while the user looks at it.
    if (!editor || editor.document.uri.scheme !== 'file') return;
    let located: LocatedFile | undefined;
    try {
      located = await this.repos.locateOrDiscover(editor.document.uri);
    } catch {
      located = undefined;
    }
    if (!located) return;
    if (
      this.current &&
      this.current.repoId === located.repoId &&
      this.current.relativePath === located.relativePath
    ) {
      return;
    }
    this.current = located;
    this.state = emptyPageState();
    this.fireChange();
  }

  protected override invalidate(): void {
    this.state = emptyPageState();
  }

  override async getChildren(node?: ViewNode): Promise<ViewNode[]> {
    if (node) return node.children ? ((await node.children()) ?? []) : [];
    // No tracked file and engine failures both leave the tree empty so the
    // view's welcome content explains the state.
    if (!this.current) return [];
    try {
      return await this.buildNodes(this.current);
    } catch {
      return setViewState('engineUnavailable');
    }
  }

  protected getRootNodes(_repo: ActiveRepo): Promise<ViewNode[]> {
    // Unused: getChildren above resolves the repo from the tracked editor.
    return this.current ? this.buildNodes(this.current) : Promise.resolve([]);
  }

  private async buildNodes(file: LocatedFile): Promise<ViewNode[]> {
    if (!this.state.loaded) await this.fetchPage(file);

    if (this.state.items.length === 0) {
      return [messageNode(`No history for ${file.relativePath}`)];
    }
    const nodes = this.state.items.map((entry) => fileHistoryNode(file.repoId, entry));
    if (this.state.nextCursor !== undefined) {
      nodes.push(loadMoreNode(() => void this.loadMore(file)));
    }
    return nodes;
  }

  private async fetchPage(file: LocatedFile): Promise<void> {
    const result = await this.engine.request('history/file', {
      repoId: file.repoId,
      path: file.relativePath,
      cursor: this.state.nextCursor,
      limit: viewPageSize(),
    });
    this.state = appendPage(this.state, { items: result.entries, nextCursor: result.nextCursor });
  }

  private async loadMore(file: LocatedFile): Promise<void> {
    if (this.current !== file || this.state.nextCursor === undefined) return;
    try {
      await this.fetchPage(file);
    } catch {
      // Keep the loaded entries; the tail node stays and can be retried.
    }
    this.fireChange();
  }
}
