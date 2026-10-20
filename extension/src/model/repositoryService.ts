import * as vscode from 'vscode';
import * as path from 'node:path';
import { ErrorCodes } from '@gitglasses/protocol';
import { EngineClient, EngineError, EngineRestartedError } from '@gitglasses/rpc';
import type { AliasResolver, PathFlavor } from './pathAliases';

export interface LocatedFile {
  repoId: string;
  /** The repository root in the spelling of the located path, so joining
   *  relativePath onto it names the file the editor has open. */
  rootPath: string;
  relativePath: string;
}

// The web worker host has no `process`.
const hostPlatform = typeof process === 'undefined' ? '' : process.platform;

/** Whether paths compare without regard to letter case by default: NTFS on
 *  Windows and APFS on macOS are case-insensitive unless formatted otherwise. */
export function defaultCaseInsensitive(platform: string = hostPlatform): boolean {
  return platform === 'win32' || platform === 'darwin';
}

function comparable(value: string, caseInsensitive: boolean): string {
  const slashed = value.replace(/\\/g, '/').replace(/\/+$/, '');
  return caseInsensitive ? slashed.toLowerCase() : slashed;
}

/**
 * The repo-relative path of `fsPath` inside `rootPath`, or undefined when it
 * lies outside.
 *
 * The two sides come from different worlds, so both are normalized before
 * comparison. rootPath is libgit2's git_repository_workdir(), which uses
 * forward slashes on every platform; fsPath is VS Code's, which uses
 * backslashes on Windows. Drive letters also vary in case between the two,
 * and NTFS and APFS are case-insensitive.
 */
export function relativeWithinRoot(
  rootPath: string,
  fsPath: string,
  caseInsensitive: boolean = defaultCaseInsensitive(),
): string | undefined {
  const root = comparable(rootPath, caseInsensitive);
  const target = comparable(fsPath, caseInsensitive);
  if (root === '') return undefined;
  if (target === root) return '';
  if (!target.startsWith(`${root}/`)) return undefined;

  // Take the remainder from the original (not the case-folded copy) so the
  // path keeps its case. It is cut by segment count, not by length: folding
  // can change a string's length ('İ' lower-cases to two code units) but
  // never adds or removes a '/'.
  const rootSegments = root.split('/').length;
  return fsPath.replace(/\\/g, '/').split('/').slice(rootSegments).join('/');
}

/** Whether two repository roots are the same path, ignoring a trailing
 *  separator, separator style, and case where the platform ignores it. */
export function sameRoot(
  a: string,
  b: string,
  caseInsensitive: boolean = defaultCaseInsensitive(),
): boolean {
  return comparable(a, caseInsensitive) === comparable(b, caseInsensitive);
}

/** A repository's display name: the last segment of its root path. */
export function repoName(rootPath: string): string {
  const parts = rootPath.replace(/\\/g, '/').replace(/\/+$/, '').split('/');
  return parts[parts.length - 1] || rootPath;
}

/** A repository the service has registered. */
export interface KnownRepository {
  repoId: string;
  /** The root as the engine reports it. */
  rootPath: string;
  /** Other spellings of the same directory that editor paths use. */
  aliases: readonly string[];
}

export interface RepositoryServiceOptions {
  /** Finds the editor's spelling of a root the engine reports under another
   *  name (symlink, 8.3 short name, letter case). Hosts with a real
   *  filesystem supply one; without it such files go unmatched, with a
   *  warning in the log. */
  resolveAlias?: AliasResolver;
  /** Writes a line to the host's log. */
  log?: (line: string) => void;
  /** Path comparison mode; defaults to the platform's. */
  caseInsensitive?: boolean;
  /** Path operations on editor paths; defaults to the platform's. */
  pathFlavor?: PathFlavor;
  /** Clock for expiring "in no repository" answers. */
  now?: () => number;
}

/** How long the engine's "in no repository" answer for a directory is reused
 *  before the engine is asked again. A repository created inside the
 *  workspace drops it sooner, through forgetDirectories(). */
export const NO_REPOSITORY_TTL_MS = 30_000;

/** Bound on the set of log lines already written once. */
const MAX_REMEMBERED_REPORTS = 500;

interface Registered {
  repoId: string;
  rootPath: string;
  aliases: string[];
}

interface DirectoryAnswer {
  /** Undefined when the directory is in no repository. */
  repoId?: string;
  /** Expiry of a negative answer. */
  expires?: number;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Maps workspace files to engine repo ids. The engine is asked once per
// directory which repository contains it, so a file inside a submodule or a
// nested clone resolves to that inner repository even when its parent is
// already known; later lookups in the directory are answered locally.
export class RepositoryService {
  private registered = new Map<string, Registered>();
  /** (repoId, spelling) for every spelling of every root, longest first, so
   *  nested repos match before their parents. Rebuilt on mutation, not per
   *  lookup. */
  private sortedRoots: [string, string][] = [];
  /** The engine's answer per directory, keyed by its comparable form. */
  private directories = new Map<string, DirectoryAnswer>();
  private discovering = new Map<string, Promise<void>>();
  private listeners = new Set<() => void>();
  /** Raised while rediscoverAll re-registers, which reports one change. */
  private quiet = 0;
  /** Directory lookups the engine did not answer. */
  private unanswered = 0;
  private reported = new Set<string>();
  private readonly caseInsensitive: boolean;
  private readonly flavor: PathFlavor;
  private readonly now: () => number;

  constructor(
    private readonly engine: EngineClient,
    private readonly options: RepositoryServiceOptions = {},
  ) {
    this.caseInsensitive = options.caseInsensitive ?? defaultCaseInsensitive();
    this.flavor = options.pathFlavor ?? path;
    this.now = options.now ?? Date.now;
  }

  /** Synchronous lookup against already-discovered repos. Once the engine
   *  has answered for the file's directory, that answer decides; before then
   *  the innermost known root containing the file is the best guess, which
   *  is the parent for a file in a not yet discovered submodule, so callers
   *  that can wait use locateOrDiscover. */
  locate(uri: vscode.Uri): LocatedFile | undefined {
    if (uri.scheme !== 'file') return undefined;
    return this.match(uri.fsPath, this.flavor.dirname(uri.fsPath));
  }

  /** Asks the engine which repository contains the file's directory, unless
   *  it already answered for that directory, then locates the file. */
  async locateOrDiscover(uri: vscode.Uri): Promise<LocatedFile | undefined> {
    if (uri.scheme !== 'file') return undefined;
    const dir = this.flavor.dirname(uri.fsPath);
    if (!this.answered(dir)) await this.discoverDirectory(dir);
    return this.locate(uri);
  }

  /** Re-register all known repos (after an engine respawn: ids are stale). */
  async rediscoverAll(): Promise<void> {
    const previous = [...this.registered.values()];
    const before = this.rootsKey();
    this.registered.clear();
    this.directories.clear();
    this.rebuild();
    this.quiet++;
    try {
      for (const repo of previous) {
        try {
          const info = await this.engine.request('repo/discover', { path: repo.rootPath });
          this.register(info.repoId, info.rootPath);
          // The editor's spellings of the root carry over to the new id.
          const current = this.registered.get(info.repoId);
          if (current) for (const alias of repo.aliases) this.addAlias(current, alias);
        } catch (error) {
          // The repository may have vanished; drop it.
          this.log(`dropped ${repo.rootPath} after the engine restarted: ${errorText(error)}`);
        }
      }
      this.rebuild();
    } finally {
      this.quiet--;
    }
    if (this.rootsKey() !== before) this.fireChanged();
  }

  /** Every registered repository, in registration order. */
  repositories(): KnownRepository[] {
    return [...this.registered.values()].map((repo) => ({
      repoId: repo.repoId,
      rootPath: repo.rootPath,
      aliases: [...repo.aliases],
    }));
  }

  /** The engine's spelling of a registered repository's root. */
  rootOf(repoId: string): string | undefined {
    return this.registered.get(repoId)?.rootPath;
  }

  /** Whether `candidate` names the repository's root in any known spelling. */
  isRootOf(repoId: string, candidate: string): boolean {
    const repo = this.registered.get(repoId);
    if (!repo) return false;
    return [repo.rootPath, ...repo.aliases].some((spelling) =>
      sameRoot(spelling, candidate, this.caseInsensitive),
    );
  }

  /** Forgets every per-directory answer, so the next lookup in each directory
   *  asks the engine again: a repository appeared or vanished. */
  forgetDirectories(): void {
    this.directories.clear();
  }

  /** Drops the repositories rooted at `dir`, whose .git was removed: its files
   *  belong to an enclosing repository again. The engine releases them too,
   *  so a repository created there later is registered and watched afresh. */
  async forgetRepositoriesAt(dir: string): Promise<void> {
    const gone = [...this.registered.values()].filter((repo) =>
      [repo.rootPath, ...repo.aliases].some((spelling) =>
        sameRoot(spelling, dir, this.caseInsensitive),
      ),
    );
    if (gone.length === 0) return;
    for (const repo of gone) this.registered.delete(repo.repoId);
    this.directories.clear();
    this.rebuild();
    this.fireChanged();
    for (const repo of gone) {
      this.log(`repository ${repo.repoId} at ${repo.rootPath} is gone`);
      await this.engine
        .request('repo/close', { repoId: repo.repoId })
        .catch((error: unknown) =>
          this.log(`could not release ${repo.repoId}: ${errorText(error)}`),
        );
    }
  }

  /** How many directory lookups so far went unanswered (engine not started,
   *  restarting, timed out or unreachable). A workspace scan during which this
   *  grows missed repositories and is not worth keeping. An error the engine
   *  answered with is not counted: asking again would get the same one. */
  unansweredLookups(): number {
    return this.unanswered;
  }

  /** Called whenever a repository is registered or dropped. */
  onDidChangeRepositories(listener: () => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  private key(dir: string): string {
    return comparable(dir, this.caseInsensitive);
  }

  /** The engine's unexpired answer for `dir`, if it gave one. */
  private answerFor(dir: string): DirectoryAnswer | undefined {
    const key = this.key(dir);
    const answer = this.directories.get(key);
    if (answer?.expires !== undefined && answer.expires <= this.now()) {
      this.directories.delete(key);
      return undefined;
    }
    return answer;
  }

  private answered(dir: string): boolean {
    return this.answerFor(dir) !== undefined;
  }

  /** Locates `target`, which lies in directory `dir` (or is it). */
  private match(target: string, dir: string): LocatedFile | undefined {
    const answer = this.answerFor(dir);
    if (answer && answer.repoId === undefined) return undefined;
    for (const [repoId, rootPath] of this.sortedRoots) {
      if (answer && repoId !== answer.repoId) continue;
      const relative = relativeWithinRoot(rootPath, target, this.caseInsensitive);
      if (relative === undefined) continue;
      return { repoId, rootPath, relativePath: relative };
    }
    return undefined;
  }

  private discoverDirectory(dir: string): Promise<void> {
    const key = this.key(dir);
    let inflight = this.discovering.get(key);
    if (!inflight) {
      inflight = this.engine
        .request('repo/discover', { path: dir })
        .then(
          (info) => {
            this.register(info.repoId, info.rootPath, dir);
            this.directories.set(key, { repoId: info.repoId });
          },
          (error: unknown) => this.discoveryFailed(dir, key, error),
        )
        .finally(() => this.discovering.delete(key));
      this.discovering.set(key, inflight);
    }
    return inflight;
  }

  private discoveryFailed(dir: string, key: string, error: unknown): void {
    const code = (error as { code?: unknown } | undefined)?.code;
    if (code === ErrorCodes.RepoNotFound) {
      this.directories.set(key, { expires: this.now() + NO_REPOSITORY_TTL_MS });
      this.logOnce(`none\0${key}`, `no repository contains ${dir}`);
      return;
    }
    const message = errorText(error);
    const line = `repository discovery failed for ${dir}: ${message}`;
    if (error instanceof EngineError && code !== ErrorCodes.Cancelled) {
      // The engine looked and refused what it found: a repository format
      // libgit2 cannot open, an owner git does not trust. That is an answer,
      // kept as long as "no repository", so a lookup repeated on every
      // refresh does not ask again until the user had time to fix it.
      this.directories.set(key, { expires: this.now() + NO_REPOSITORY_TTL_MS });
      this.logOnce(`failed\0${key}\0${message}`, line);
      return;
    }
    // No answer: the engine is not started, restarting, wedged or gone. The
    // next lookup asks again.
    this.unanswered++;
    if (error instanceof EngineRestartedError) return;
    this.logOnce(`failed\0${key}\0${message}`, line);
  }

  /** Records a repository the engine reported, learning the editor's
   *  spelling of its root when `requestedDir` spells it differently. */
  private register(repoId: string, reportedRoot: string, requestedDir?: string): void {
    // The engine reports the root with a trailing slash; normalize.
    const rootPath = reportedRoot.replace(/[\\/]+$/, '') || reportedRoot;
    let repo = this.registered.get(repoId);
    const added = repo === undefined;
    if (!repo) {
      repo = { repoId, rootPath, aliases: [] };
      this.registered.set(repoId, repo);
    } else {
      repo.rootPath = rootPath;
    }
    if (added) this.log(`repository ${repoId} at ${rootPath}`);
    if (requestedDir !== undefined && !this.contains(repo, requestedDir)) {
      this.learnAlias(repo, requestedDir);
    }
    this.rebuild();
    if (added) this.fireChanged();
  }

  private contains(repo: Registered, dir: string): boolean {
    return [repo.rootPath, ...repo.aliases].some(
      (spelling) => relativeWithinRoot(spelling, dir, this.caseInsensitive) !== undefined,
    );
  }

  private learnAlias(repo: Registered, dir: string): void {
    const alias = this.options.resolveAlias?.(dir, repo.rootPath);
    if (alias === undefined) {
      this.logOnce(
        `unmatched\0${repo.repoId}\0${this.key(dir)}`,
        `warning: the engine places ${dir} in the repository at ${repo.rootPath}, ` +
          'but no directory on that path is the repository root, so files there ' +
          'cannot be matched to it',
      );
      return;
    }
    if (this.addAlias(repo, alias)) {
      this.log(`repository ${repo.repoId} at ${repo.rootPath} is open as ${alias}`);
    }
  }

  private addAlias(repo: Registered, alias: string): boolean {
    if (sameRoot(repo.rootPath, alias, this.caseInsensitive)) return false;
    if (repo.aliases.some((known) => sameRoot(known, alias, this.caseInsensitive))) return false;
    repo.aliases.push(alias);
    return true;
  }

  private rebuild(): void {
    const entries: [string, string][] = [];
    for (const repo of this.registered.values()) {
      entries.push([repo.repoId, repo.rootPath]);
      for (const alias of repo.aliases) entries.push([repo.repoId, alias]);
    }
    this.sortedRoots = entries.sort(
      (a, b) =>
        comparable(b[1], this.caseInsensitive).length -
        comparable(a[1], this.caseInsensitive).length,
    );
  }

  private rootsKey(): string {
    return [...this.registered.values()]
      .map((repo) => comparable(repo.rootPath, this.caseInsensitive))
      .sort()
      .join('\n');
  }

  private fireChanged(): void {
    if (this.quiet > 0) return;
    for (const listener of [...this.listeners]) listener();
  }

  private log(line: string): void {
    this.options.log?.(line);
  }

  /** Logs a line the first time its key is seen, so a lookup repeated on
   *  every cursor move reports its failure once. */
  private logOnce(key: string, line: string): void {
    if (this.reported.has(key)) return;
    if (this.reported.size >= MAX_REMEMBERED_REPORTS) this.reported.clear();
    this.reported.add(key);
    this.log(line);
  }
}
