// Finding the repositories a workspace holds: the repository each folder is
// in, repositories in its subfolders down to a bounded depth, and the
// submodules those declare. It follows the built-in Git extension's settings
// (git.autoRepositoryDetection, git.repositoryScanMaxDepth,
// git.repositoryScanIgnoredFolders, git.detectSubmodules and
// git.detectSubmodulesLimit), so both list the same repositories.
//
// Directory listing, file reads and the engine lookup are injected, so the
// walk runs against fakes in tests and against vscode.workspace.fs in the
// extension.

export interface DirectoryEntry {
  name: string;
  isDirectory: boolean;
  isSymbolicLink: boolean;
}

export interface ScanSettings {
  /** Levels below a workspace folder searched for repositories: 0 for none,
   *  -1 for no limit. */
  maxDepth: number;
  /** Folder names never descended into. */
  ignoredFolders: readonly string[];
  /** Whether each repository's .gitmodules adds its submodules. */
  detectSubmodules: boolean;
  /** Most submodules taken from one repository. */
  submoduleLimit: number;
}

/** The Git extension's defaults, for hosts that ship without it. */
export const DEFAULT_SCAN_SETTINGS: ScanSettings = {
  maxDepth: 1,
  ignoredFolders: ['node_modules'],
  detectSubmodules: true,
  submoduleLimit: 10,
};

/** Bound on the directories one folder scan lists, whatever the depth. */
export const MAX_SCANNED_DIRECTORIES = 10_000;

/** Bound on the repositories one workspace discovery registers with the
 *  engine and reports. */
export const MAX_WORKSPACE_REPOSITORIES = 200;

/** A repository as discovery found it. */
export interface FoundRepository {
  repoId: string;
  /** The root in the spelling of the path it was found from, which the
   *  injected filesystem calls can read. */
  rootPath: string;
}

export interface DiscoveryHost {
  /** The repository containing `dir`, from the engine; undefined when none.
   *  `watch` is false for a repository that is only being listed: the
   *  engine registers it without watching it. */
  discover(dir: string, watch: boolean): Promise<FoundRepository | undefined>;
  readDirectory(dir: string): Promise<DirectoryEntry[]>;
  /** A file's text, or undefined when it cannot be read. */
  readFile(file: string): Promise<string | undefined>;
  /** Scan settings for a workspace folder. */
  settings(folder: string): ScanSettings;
  join(...parts: string[]): string;
  caseInsensitive: boolean;
}

/**
 * Directories below `root` (not `root` itself) that hold a `.git` file or
 * folder, breadth-first to `settings.maxDepth` levels. Like the Git
 * extension's scan it skips `.git` itself, ignored folder names and symbolic
 * links, which could otherwise loop.
 */
export async function findRepositoryFolders(
  root: string,
  host: Pick<DiscoveryHost, 'readDirectory' | 'join' | 'caseInsensitive'>,
  settings: Pick<ScanSettings, 'maxDepth' | 'ignoredFolders'>,
): Promise<string[]> {
  if (settings.maxDepth === 0) return [];
  const fold = (name: string): string => (host.caseInsensitive ? name.toLowerCase() : name);
  const ignored = new Set(settings.ignoredFolders.map(fold));
  const found: string[] = [];
  const queue: { dir: string; depth: number }[] = [{ dir: root, depth: 0 }];
  for (let next = 0; next < queue.length && next < MAX_SCANNED_DIRECTORIES; next++) {
    const { dir, depth } = queue[next];
    let entries: DirectoryEntry[];
    try {
      entries = await host.readDirectory(dir);
    } catch {
      continue;
    }
    if (depth > 0 && entries.some((entry) => entry.name === '.git')) found.push(dir);
    if (settings.maxDepth !== -1 && depth >= settings.maxDepth) continue;
    for (const entry of entries) {
      if (!entry.isDirectory || entry.isSymbolicLink) continue;
      if (entry.name === '.git' || ignored.has(fold(entry.name))) continue;
      queue.push({ dir: host.join(dir, entry.name), depth: depth + 1 });
    }
  }
  return found;
}

/** The submodule paths a .gitmodules file declares, in order. Paths that are
 *  absolute or climb out of the repository are dropped. */
export function parseGitmodulePaths(text: string): string[] {
  const paths: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*path\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[1].trim();
    if (value.startsWith('"')) {
      const end = value.indexOf('"', 1);
      value = end > 0 ? value.slice(1, end) : value.slice(1);
    } else {
      // An unquoted value ends at a comment.
      value = value.replace(/\s*[#;].*$/, '');
    }
    value = value.replace(/\\/g, '/').replace(/\/+$/, '');
    if (value === '' || value.startsWith('/') || /^[A-Za-z]:/.test(value)) continue;
    if (value.split('/').includes('..')) continue;
    paths.push(value);
  }
  return paths;
}

/**
 * Every repository the workspace folders hold, each once: the repositories
 * the folders are in (in folder order, so the first folder's stays the
 * default), then repositories found below the folders, then the submodules of
 * everything found so far, nested submodules included.
 *
 * At most `limit` repositories are registered with the engine: lookups are
 * issued in batches no larger than the room left, so a folder holding
 * thousands of clones costs no more than the list shows. Only the folders'
 * own repositories are watched; the rest are watched once used.
 */
export async function collectWorkspaceRepos(
  folders: readonly string[],
  host: DiscoveryHost,
  limit: number = MAX_WORKSPACE_REPOSITORIES,
): Promise<FoundRepository[]> {
  const found: FoundRepository[] = [];
  // The workspace folder each repository was found from, whose settings
  // govern its submodules.
  const folderOf = new Map<string, string>();
  const add = (repo: FoundRepository | undefined, folder: string): void => {
    if (!repo || folderOf.has(repo.repoId) || found.length >= limit) return;
    folderOf.set(repo.repoId, folder);
    found.push(repo);
  };
  const discover = (dir: string, watch: boolean): Promise<FoundRepository | undefined> =>
    host.discover(dir, watch).catch(() => undefined);
  // Looks up candidate directories, never more at once than there is room
  // left: each lookup can register a repository the engine then holds.
  const discoverWithin = async (candidates: { dir: string; folder: string }[]): Promise<void> => {
    for (let next = 0; next < candidates.length && found.length < limit; ) {
      const batch = candidates.slice(next, next + limit - found.length);
      next += batch.length;
      const repos = await Promise.all(batch.map((candidate) => discover(candidate.dir, false)));
      repos.forEach((repo, index) => add(repo, batch[index].folder));
    }
  };

  const own = await Promise.all(folders.slice(0, limit).map((folder) => discover(folder, true)));
  own.forEach((repo, index) => add(repo, folders[index]));

  const below = await Promise.all(
    folders.map((folder) => findRepositoryFolders(folder, host, host.settings(folder))),
  );
  await discoverWithin(
    below.flatMap((dirs, index) => dirs.map((dir) => ({ dir, folder: folders[index] }))),
  );

  // Submodules are read from every repository found, including the ones this
  // loop adds; an uninitialized submodule resolves to its parent, which is
  // already listed.
  for (let index = 0; index < found.length && found.length < limit; index++) {
    const repo = found[index];
    const folder = folderOf.get(repo.repoId) ?? repo.rootPath;
    const settings = host.settings(folder);
    if (!settings.detectSubmodules) continue;
    const text = await host
      .readFile(host.join(repo.rootPath, '.gitmodules'))
      .catch(() => undefined);
    if (!text) continue;
    const paths = parseGitmodulePaths(text).slice(0, Math.max(0, settings.submoduleLimit));
    await discoverWithin(
      paths.map((relative) => ({ dir: host.join(repo.rootPath, ...relative.split('/')), folder })),
    );
  }
  return found;
}
