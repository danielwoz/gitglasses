import * as vscode from 'vscode';
import * as path from 'node:path';
import { CommitSummaryInfo } from '@gitglasses/protocol';
import { EngineClient } from '../engine/engineClient';
import { RepositoryService } from '../model/repositoryService';
import { DiffSpec } from './viewLogic';

export interface ActiveRepo {
  repoId: string;
  rootPath: string;
}

/** Resolves the first workspace folder that is (in) a git repository. */
export async function firstWorkspaceRepo(
  repos: RepositoryService,
): Promise<ActiveRepo | undefined> {
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    if (folder.uri.scheme !== 'file') continue;
    // locateOrDiscover keys discovery on the file's parent directory, so a
    // synthetic child path makes it discover the folder itself.
    const probe = vscode.Uri.file(path.join(folder.uri.fsPath, '.gitglasses'));
    const located = await repos.locateOrDiscover(probe);
    if (located) return { repoId: located.repoId, rootPath: located.rootPath };
  }
  return undefined;
}

/** Tree element: a prebuilt item plus payload the command handlers read. */
export interface ViewNode {
  item: vscode.TreeItem;
  children?: () => vscode.ProviderResult<ViewNode[]>;
  sha?: string;
  commit?: CommitSummaryInfo;
  diff?: DiffSpec;
}

export function messageNode(message: string): ViewNode {
  const item = new vscode.TreeItem(message, vscode.TreeItemCollapsibleState.None);
  item.iconPath = new vscode.ThemeIcon('info');
  item.contextValue = 'gitglassesMessage';
  return { item };
}

export function loadMoreNode(loadMore: () => void): ViewNode {
  const item = new vscode.TreeItem('Load more…', vscode.TreeItemCollapsibleState.None);
  item.iconPath = new vscode.ThemeIcon('ellipsis');
  item.contextValue = 'gitglassesLoadMore';
  item.command = { command: 'gitglasses.loadMore', title: 'Load More', arguments: [loadMore] };
  return { item };
}

// Shared provider skeleton: engine readiness, active-repo resolution, error
// and empty states, and refresh() that also drops any per-view cache.
export abstract class ViewBase implements vscode.TreeDataProvider<ViewNode>, vscode.Disposable {
  private emitter = new vscode.EventEmitter<ViewNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  protected disposables: vscode.Disposable[] = [];

  constructor(
    protected readonly engine: EngineClient,
    protected readonly repos: RepositoryService,
  ) {}

  /** Full reload: drop cached pages/results and re-render. */
  refresh(): void {
    this.invalidate();
    this.emitter.fire(undefined);
  }

  /** Re-render only (cached state kept) — used after appending a page. */
  protected fireChange(): void {
    this.emitter.fire(undefined);
  }

  /** Overridden by views that cache fetched state. */
  protected invalidate(): void {}

  getTreeItem(node: ViewNode): vscode.TreeItem {
    return node.item;
  }

  async getChildren(node?: ViewNode): Promise<ViewNode[]> {
    if (node) return node.children ? ((await node.children()) ?? []) : [];

    let repo: ActiveRepo | undefined;
    try {
      repo = await firstWorkspaceRepo(this.repos);
    } catch {
      return [messageNode('GitGlasses engine unavailable')];
    }
    if (!repo) {
      // Discovery failures swallow errors, so probe the engine to tell
      // "no repository" apart from "engine down".
      try {
        await this.engine.request('repo/list', {});
      } catch {
        return [messageNode('GitGlasses engine unavailable')];
      }
      return [messageNode('No git repository in this workspace')];
    }
    try {
      return await this.getRootNodes(repo);
    } catch {
      return [messageNode('GitGlasses engine unavailable')];
    }
  }

  protected abstract getRootNodes(repo: ActiveRepo): Promise<ViewNode[]>;

  dispose(): void {
    for (const disposable of this.disposables.splice(0)) disposable.dispose();
    this.emitter.dispose();
  }
}
