// Which repository the repo-scoped surfaces act on. A workspace can hold
// several: one per folder, more below a folder, submodules, and repositories
// reached by opening a file in them. The choice is explicit, persisted per
// workspace, and shown in the view titles; the first folder's repository is
// the default.

import * as vscode from 'vscode';
import * as path from 'node:path';
import {
  RepositoryService,
  defaultCaseInsensitive,
  repoName,
  sameRoot,
} from './repositoryService';
import {
  DEFAULT_SCAN_SETTINGS,
  DiscoveryHost,
  MAX_WORKSPACE_REPOSITORIES,
  ScanSettings,
  collectWorkspaceRepos,
} from './repoDiscovery';

export interface ActiveRepo {
  repoId: string;
  /** The root in the engine's spelling. */
  rootPath: string;
  /** The root in the spelling the editor uses for the files in it, which
   *  differs from rootPath under a symlink, an 8.3 short name or a junction.
   *  URIs of working-tree files are built from it, so they name the
   *  documents the explorer shows. */
  workspacePath?: string;
}

export interface WorkspaceRepo extends ActiveRepo {
  /** Last path segment of the root, the label used in pickers and titles. */
  name: string;
  workspacePath: string;
}

export const ACTIVE_REPO_KEY = 'gitglasses.activeRepoRoot';

/** Lets a burst of .git creations or registrations settle into one rescan. */
const SETTLE_MS = 300;

/** A child name that never exists. locateOrDiscover asks about a file's
 *  directory, so probing this child asks about the directory itself. */
const PROBE = '.gitglasses';

/** The Git extension settings that change which repositories are found. */
const SCAN_SETTING_KEYS = [
  'git.autoRepositoryDetection',
  'git.repositoryScanMaxDepth',
  'git.repositoryScanIgnoredFolders',
  'git.detectSubmodules',
  'git.detectSubmodulesLimit',
];

/** The Git extension's scan settings for a folder. Subfolders are searched
 *  only when it detects repositories automatically in them, as it does by
 *  default. */
function scanSettings(folder: string): ScanSettings {
  const git = vscode.workspace.getConfiguration('git', vscode.Uri.file(folder));
  const integer = (key: string, fallback: number): number => {
    const value = git.get<number>(key, fallback);
    return Number.isInteger(value) ? value : fallback;
  };
  const detection = git.get<boolean | string>('autoRepositoryDetection', true);
  const subfolders = detection === true || detection === 'subFolders';
  const ignored = git.get<unknown>(
    'repositoryScanIgnoredFolders',
    DEFAULT_SCAN_SETTINGS.ignoredFolders,
  );
  return {
    maxDepth: subfolders ? integer('repositoryScanMaxDepth', DEFAULT_SCAN_SETTINGS.maxDepth) : 0,
    ignoredFolders: Array.isArray(ignored)
      ? ignored.filter((name): name is string => typeof name === 'string')
      : DEFAULT_SCAN_SETTINGS.ignoredFolders,
    detectSubmodules: git.get<boolean>('detectSubmodules', true) !== false,
    submoduleLimit: integer('detectSubmodulesLimit', DEFAULT_SCAN_SETTINGS.submoduleLimit),
  };
}

function workspaceHost(repos: RepositoryService): DiscoveryHost {
  return {
    discover: async (dir, watch) => {
      const probe = vscode.Uri.file(path.join(dir, PROBE));
      const located = await repos.locateOrDiscover(probe, { watch });
      return located && { repoId: located.repoId, rootPath: located.rootPath };
    },
    readDirectory: async (dir) => {
      const entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(dir));
      return entries.map(([name, type]) => ({
        name,
        isDirectory: (type & vscode.FileType.Directory) !== 0,
        isSymbolicLink: (type & vscode.FileType.SymbolicLink) !== 0,
      }));
    },
    readFile: async (file) => {
      try {
        return new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.file(file)));
      } catch {
        return undefined;
      }
    },
    settings: scanSettings,
    join: path.join,
    caseInsensitive: defaultCaseInsensitive(),
  };
}

/** A repository for the repo-scoped surfaces: the root in the engine's
 *  spelling and in the spelling it was found by, labelled with the last
 *  segment of the latter, which is the name the user sees in the explorer. */
function workspaceRepo(
  repos: RepositoryService,
  repoId: string,
  spelledRoot: string,
): WorkspaceRepo {
  return {
    repoId,
    rootPath: repos.rootOf(repoId) ?? spelledRoot,
    workspacePath: spelledRoot,
    name: repoName(spelledRoot),
  };
}

interface WorkspaceScan {
  repos: WorkspaceRepo[];
  /** False when the engine left a lookup unanswered (not started yet, or
   *  restarting): the scan may have missed repositories or listed them out
   *  of order. */
  complete: boolean;
}

async function scanWorkspace(repos: RepositoryService): Promise<WorkspaceScan> {
  const folders = (vscode.workspace.workspaceFolders ?? [])
    .filter((folder) => folder.uri.scheme === 'file')
    .map((folder) => folder.uri.fsPath);
  const unansweredBefore = repos.unansweredLookups();
  const found = await collectWorkspaceRepos(folders, workspaceHost(repos));
  return {
    repos: found.map((repo) => workspaceRepo(repos, repo.repoId, repo.rootPath)),
    complete: repos.unansweredLookups() === unansweredBefore,
  };
}

/** Every repository the workspace folders hold, the folders' own first, in
 *  folder order. */
export async function discoverWorkspaceRepos(
  repos: RepositoryService,
): Promise<WorkspaceRepo[]> {
  return (await scanWorkspace(repos)).repos;
}

/** Identifies a repository list by its roots, which outlive engine restarts. */
function listKey(list: readonly WorkspaceRepo[]): string {
  return list.map((repo) => repo.rootPath.replace(/\\/g, '/')).join('\n');
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
  /** The repository list onDidChange last announced. */
  private announced: string | undefined;
  private settleTimer: ReturnType<typeof setTimeout> | undefined;
  /** Directories whose .git was deleted since the last settle. */
  private removedGitEntries = new Set<string>();

  constructor(
    private readonly repoService: RepositoryService,
    private readonly workspaceState: vscode.Memento,
  ) {
    // A .git file or folder appearing or vanishing anywhere in the workspace
    // (clone, git init, submodule update --init, deinit) changes which
    // repository its directories belong to.
    const gitEntries = vscode.workspace.createFileSystemWatcher('**/.git', false, true, false);
    this.disposables.push(
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        this.discovery = undefined;
        this.changed.fire();
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (!SCAN_SETTING_KEYS.some((key) => event.affectsConfiguration(key))) return;
        this.discovery = undefined;
        this.settle();
      }),
      gitEntries,
      gitEntries.onDidCreate(() => this.gitEntryChanged()),
      gitEntries.onDidDelete((uri) => this.gitEntryChanged(uri)),
      repoService.onDidChangeRepositories(() => this.settle()),
    );
  }

  /** Discovers the workspace's repositories once, then answers from cache,
   *  adding any repository registered since (a file opened in a nested repo
   *  or outside the workspace), up to MAX_WORKSPACE_REPOSITORIES in all. A
   *  failed, empty or incomplete discovery is not cached: it also happens
   *  before the engine is ready, and the next lookup has to try again. */
  async all(): Promise<readonly WorkspaceRepo[]> {
    if (!this.discovery) {
      const attempt = scanWorkspace(this.repoService).then(({ repos, complete }) => {
        if (repos.length === 0 || !complete) this.discovery = undefined;
        return repos;
      });
      attempt.catch(() => {
        this.discovery = undefined;
      });
      this.discovery = attempt;
    }
    const list = [...(await this.discovery)];
    for (const known of this.repoService.repositories()) {
      if (list.length >= MAX_WORKSPACE_REPOSITORIES) break;
      if (list.some((repo) => repo.repoId === known.repoId)) continue;
      list.push(workspaceRepo(this.repoService, known.repoId, known.aliases[0] ?? known.rootPath));
    }
    this.announced ??= listKey(list);
    return list;
  }

  /** The repository every repo-scoped surface acts on: the stored choice when
   *  it is still in the workspace, else the first folder that is a repo. It
   *  is watched from then on, so the views follow outside changes to it. */
  async resolve(): Promise<ActiveRepo | undefined> {
    const all = await this.all();
    if (all.length === 0) return undefined;
    const stored = this.workspaceState.get<string>(ACTIVE_REPO_KEY);
    const match = stored
      ? all.find(
          (repo) =>
            sameRoot(repo.rootPath, stored) || this.repoService.isRootOf(repo.repoId, stored),
        )
      : undefined;
    const active = match ?? all[0];
    await this.repoService.ensureWatched(active.repoId);
    return active;
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

  private gitEntryChanged(removed?: vscode.Uri): void {
    if (removed) this.removedGitEntries.add(path.dirname(removed.fsPath));
    this.repoService.forgetDirectories();
    this.discovery = undefined;
    this.settle();
  }

  private settle(): void {
    clearTimeout(this.settleTimer);
    this.settleTimer = setTimeout(() => void this.announce().catch(() => undefined), SETTLE_MS);
  }

  /** Fires onDidChange when the repository list differs from the one last
   *  announced, so views and titles follow repositories as they come and go. */
  private async announce(): Promise<void> {
    const removed = [...this.removedGitEntries];
    this.removedGitEntries.clear();
    for (const dir of removed) await this.repoService.forgetRepositoriesAt(dir);
    const key = listKey(await this.all());
    if (key === this.announced) return;
    this.announced = key;
    this.changed.fire();
  }

  dispose(): void {
    clearTimeout(this.settleTimer);
    for (const disposable of this.disposables.splice(0)) disposable.dispose();
    this.changed.dispose();
  }
}
