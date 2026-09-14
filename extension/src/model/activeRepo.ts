// Which repository the repo-scoped surfaces act on. A multi-root workspace
// holds several, so the choice is explicit, persisted per workspace, and
// shown in the view titles instead of being silently the first folder.

import * as vscode from 'vscode';
import * as path from 'node:path';
import { RepositoryService, repoName, sameRoot } from './repositoryService';

export interface ActiveRepo {
  repoId: string;
  rootPath: string;
}

export interface WorkspaceRepo extends ActiveRepo {
  /** Last path segment of the root, the label used in pickers and titles. */
  name: string;
}

export const ACTIVE_REPO_KEY = 'gitglasses.activeRepoRoot';

/** Every workspace folder that resolves to a repository, in folder order. */
export async function discoverWorkspaceRepos(
  repos: RepositoryService,
): Promise<WorkspaceRepo[]> {
  const folders = (vscode.workspace.workspaceFolders ?? []).filter(
    (folder) => folder.uri.scheme === 'file',
  );
  // locateOrDiscover keys discovery on the file's parent directory, so a
  // synthetic child path makes it discover the folder itself.
  const located = await Promise.all(
    folders.map((folder) =>
      repos
        .locateOrDiscover(vscode.Uri.file(path.join(folder.uri.fsPath, '.gitglasses')))
        .catch(() => undefined),
    ),
  );
  const found: WorkspaceRepo[] = [];
  for (const entry of located) {
    if (!entry) continue;
    if (found.some((repo) => sameRoot(repo.rootPath, entry.rootPath))) continue;
    found.push({ repoId: entry.repoId, rootPath: entry.rootPath, name: repoName(entry.rootPath) });
  }
  return found;
}

/**
 * Tracks the workspace's repositories and which one is active. The selection
 * is stored per workspace by root path, so it survives reloads and engine
 * restarts (which hand out fresh repo ids).
 */
export class ActiveRepoManager implements vscode.Disposable {
  private discovery: Promise<WorkspaceRepo[]> | undefined;
  private changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private disposables: vscode.Disposable[] = [];

  constructor(
    private readonly repoService: RepositoryService,
    private readonly workspaceState: vscode.Memento,
  ) {
    this.disposables.push(
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        this.discovery = undefined;
        this.changed.fire();
      }),
    );
  }

  /** Discovers the workspace's repositories once, then answers from cache.
   *  A failed or empty discovery is not cached: it also happens before the
   *  engine is ready, and the next lookup has to try again. */
  async all(): Promise<readonly WorkspaceRepo[]> {
    if (!this.discovery) {
      const attempt = discoverWorkspaceRepos(this.repoService).then((found) => {
        if (found.length === 0) this.discovery = undefined;
        return found;
      });
      attempt.catch(() => {
        this.discovery = undefined;
      });
      this.discovery = attempt;
    }
    return this.discovery;
  }

  /** The repository every repo-scoped surface acts on: the stored choice when
   *  it is still in the workspace, else the first folder that is a repo. */
  async resolve(): Promise<ActiveRepo | undefined> {
    const all = await this.all();
    if (all.length === 0) return undefined;
    const stored = this.workspaceState.get<string>(ACTIVE_REPO_KEY);
    const match = stored
      ? all.find((repo) => sameRoot(repo.rootPath, stored))
      : undefined;
    return match ?? all[0];
  }

  /** Re-discovers on the next resolve() (engine restart: repo ids are stale). */
  reset(): void {
    this.discovery = undefined;
  }

  async setActive(rootPath: string): Promise<void> {
    await this.workspaceState.update(ACTIVE_REPO_KEY, rootPath);
    this.changed.fire();
  }

  /** Quick pick of the workspace's repositories. */
  async pick(): Promise<void> {
    const all = await this.all();
    if (all.length === 0) {
      void vscode.window.showWarningMessage('GitGlasses: no git repository in this workspace.');
      return;
    }
    if (all.length === 1) {
      void vscode.window.showInformationMessage(
        `GitGlasses: '${all[0].name}' is the only repository in this workspace.`,
      );
      return;
    }
    const active = await this.resolve();
    const picked = await vscode.window.showQuickPick(
      all.map((repo) => ({
        label: repo.name,
        description: active && sameRoot(active.rootPath, repo.rootPath) ? 'active' : undefined,
        detail: repo.rootPath,
        rootPath: repo.rootPath,
      })),
      { placeHolder: 'Repository GitGlasses acts on' },
    );
    if (!picked) return;
    await this.setActive(picked.rootPath);
  }

  dispose(): void {
    for (const disposable of this.disposables.splice(0)) disposable.dispose();
    this.changed.dispose();
  }
}
