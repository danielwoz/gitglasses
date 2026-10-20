// The gitglasses MCP server: tool handlers over the engine client plus the
// hosting-provider integrations, and their registration on an McpServer.

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { RootsListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type {
  BlameHunk,
  CommitSummaryInfo,
  FileChange,
  PatchEnvelope,
  RepoInfo,
} from '@gitglasses/protocol';
import { ErrorCodes, patchEnvelopeError } from '@gitglasses/protocol';
import type { FetchLike } from '@gitglasses/integrations';
import type { EngineClient } from '@gitglasses/rpc';
import {
  binaryPathsInPatch,
  emptyRepositoryMessage,
  explainEngineError,
  formatBlame,
  formatCommitShow,
  formatCommits,
  formatDiff,
  formatGraph,
  formatHistory,
  formatLineHistory,
  formatPatchEnvelope,
  formatRefs,
  formatStatus,
  parsePatchEnvelopeText,
  parsePatchSource,
  truncateText,
  type DiffFileEntry,
} from './format.js';
import {
  COMPARE_DESCRIPTION,
  compareInputSchema,
  compareRevisions,
  type CompareArgs,
} from './tools/compare.js';
import {
  HOST_SETTINGS,
  configuredHosts,
  fetchMyPullRequests,
  formatHostResults,
} from './tools/myPrs.js';
import { SERVER_VERSION } from './version.js';

export { configuredGitHubHost, isPlainHostname } from './tools/myPrs.js';

/**
 * The working directory as the workspace root of a client that offers no MCP
 * roots. A filesystem root, the home directory or any directory that holds it
 * (such as /home, /Users or C:\Users) would admit every repository the user
 * has, so none of them counts.
 */
export function workingDirectoryRoot(
  cwd: string = process.cwd(),
  home: string = os.homedir(),
): string[] {
  const resolved = canonicalPath(cwd);
  if (path.parse(resolved).root === resolved || isWithinAllowedRoots(home, [resolved])) return [];
  return [resolved];
}

/** The allow-list entry that admits every path. */
export const ALLOW_ANY = '*';

/**
 * The operator's allow list: GITGLASSES_ALLOWED_ROOTS (path-separator
 * delimited) followed by the directories passed with --allow. The server reads
 * repositories inside these directories and runs git in them with each
 * repository's own configuration. "*" admits every path.
 *
 * Each --allow value is one directory taken exactly as given, neither split
 * nor trimmed, so a directory whose name holds the separator or ends in a
 * space names that directory and no other.
 */
export function parseAllowedRoots(
  raw: string | undefined,
  extra: readonly string[] = [],
): string[] {
  const listed = (raw ?? '').split(path.delimiter).map((entry) => entry.trim());
  return [...listed, ...extra]
    .filter((entry) => entry !== '')
    .map((entry) => (entry === ALLOW_ANY ? ALLOW_ANY : canonicalPath(entry)));
}

/**
 * `target` as an absolute path with every symlink resolved. When the path does
 * not exist, the deepest existing ancestor is resolved and the remaining
 * segments appended, so a symlinked parent directory is still followed.
 */
export function canonicalPath(target: string): string {
  const resolved = path.resolve(target);
  const remainder: string[] = [];
  let current = resolved;
  for (;;) {
    try {
      // The native realpath also expands Windows 8.3 short names (RUNNER~1),
      // which the engine reports in their long form.
      return path.join(fs.realpathSync.native(current), ...remainder);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return resolved;
      remainder.unshift(path.basename(current));
      current = parent;
    }
  }
}

/**
 * True when `target` is one of `roots` or sits inside one, or `roots` holds
 * "*". An empty list admits nothing. Both sides are canonicalised first, so a
 * symlink that sits under a root but resolves outside it falls outside.
 */
export function isWithinAllowedRoots(target: string, roots: readonly string[]): boolean {
  if (roots.includes(ALLOW_ANY)) return true;
  const resolved = canonicalPath(target);
  return roots.some((root) => {
    const relative = path.relative(canonicalPath(root), resolved);
    // Empty means target === root; a leading ".." or an absolute result means
    // it escaped. path.relative already normalises the "repoA/../secret" case.
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  });
}

/** Most commits one git_file_history call lists. */
export const MAX_HISTORY_ENTRIES = 500;

/** Blame hunks returned when the caller does not ask for a specific count. */
export const DEFAULT_BLAME_HUNKS = 200;
/** Hard ceiling, mirroring the limit the other tools accept. */
export const MAX_BLAME_HUNKS = 500;

/** Characters a text result carries when the caller does not ask for more. */
export const DEFAULT_RESULT_CHARS = 20_000;
/** Ceiling a caller may raise the character limit to. */
export const MAX_RESULT_CHARS = 200_000;

/** Files one git_diff call collects hunks for. */
export const MAX_DIFF_FILES = 100;

/** Files git_diff fetches concurrently before re-checking its character budget. */
const DIFF_FETCH_BATCH = 8;

/**
 * Files git_commit_show probes for binary content. Only files reported as
 * +0 -0 are probed, which is normally none.
 */
const MAX_BINARY_PROBES = 16;

/** The character limit for one call, clamped to MAX_RESULT_CHARS. */
function resultChars(maxChars: number | undefined): number {
  return Math.min(maxChars ?? DEFAULT_RESULT_CHARS, MAX_RESULT_CHARS);
}

/**
 * What to do about a truncated result. "Raise maxChars" is useless once the
 * caller is already at the ceiling, so at the ceiling the hint names a way to
 * ask for less instead.
 */
function charLimitHint(limit: number, narrow: string): string {
  return limit >= MAX_RESULT_CHARS
    ? narrow
    : `pass a higher "maxChars" (max ${MAX_RESULT_CHARS}), or ${narrow}`;
}

/**
 * An error whose message is already written for the agent. Engine failures are
 * restated by explainEngineError; these are not.
 */
class ToolError extends Error {}

export interface ToolContext {
  /**
   * Engine for repositories inside the operator's allow list (--allow,
   * GITGLASSES_ALLOWED_ROOTS): git runs there with each repository's own
   * configuration, hooks and filters.
   */
  client: EngineClient;
  /**
   * Engine started with --restricted, for every other repository served: it
   * runs no git, so nothing a repository's config, attributes or hooks name
   * can run. Without it, only allow-listed repositories are served.
   */
  restrictedClient?: EngineClient;
  /** Directories passed with --allow; merged with GITGLASSES_ALLOWED_ROOTS. */
  allow?: readonly string[];
  /**
   * Directories passed with --read: served like the client's roots, by the
   * engine that runs no git, for clients that share no folders.
   */
  read?: readonly string[];
  /**
   * The client's MCP roots as local directories, or undefined when the client
   * offers none. createServer supplies this from the MCP session.
   */
  clientRoots?: () => Promise<readonly string[] | undefined>;
  /** Environment for tokens; defaults to process.env. */
  env?: Record<string, string | undefined>;
  /** HTTP transport for hosting providers; tests inject a stub. */
  fetchFn?: FetchLike;
}

/** A discovered repository and the engine that serves it. */
interface ServedRepo extends RepoInfo {
  client: EngineClient;
}

/** What a tool's refusal in Restricted Mode needs explained. */
const NEEDS_GIT: Record<string, string> = {
  git_file_history: 'following a file or its lines through history',
  git_log_search: 'searching code changes, paths and dates',
  git_compare: 'rendering the diff',
  create_patch: 'creating a patch',
  apply_patch: 'applying a patch',
  git_commit_show: 'rendering the diff',
};

/**
 * Tool handlers returning plain text. Kept separate from MCP registration so
 * integration tests can drive them directly against a live engine.
 */
export function createToolHandlers(context: ToolContext) {
  const env = context.env ?? process.env;
  // Discovered repositories, keyed by resolved path and capped at
  // MAX_REPO_IDS entries; the oldest is dropped on overflow.
  const repos = new Map<string, Promise<ServedRepo>>();
  const MAX_REPO_IDS = 64;

  const allowedRoots = parseAllowedRoots(env.GITGLASSES_ALLOWED_ROOTS, context.allow);
  // Like --allow values, each --read value is one directory, taken whole.
  const readRoots = (context.read ?? [])
    .filter((entry) => entry !== '')
    .map((entry) => canonicalPath(entry));

  /**
   * The directories served without git: those passed with --read, and the
   * client's MCP roots, or this process's working directory when the client
   * offers none (see workingDirectoryRoot). An allow list replaces the
   * client's roots and the working directory, not --read.
   */
  async function workspaceRoots(): Promise<readonly string[]> {
    if (!context.restrictedClient) return [];
    if (allowedRoots.length > 0) return readRoots;
    return [...readRoots, ...((await context.clientRoots?.()) ?? workingDirectoryRoot())];
  }

  /**
   * How `target` may be served: 'trusted' inside the allow list (git runs),
   * 'restricted' inside the workspace roots (no git runs), undefined when it
   * may not be read at all.
   */
  async function accessFor(target: string): Promise<'trusted' | 'restricted' | undefined> {
    if (isWithinAllowedRoots(target, allowedRoots)) return 'trusted';
    if (isWithinAllowedRoots(target, await workspaceRoots())) return 'restricted';
    return undefined;
  }

  async function outsideRootsError(target: string, repoRoot?: string): Promise<ToolError> {
    const readable = await workspaceRoots();
    const where =
      allowedRoots.length > 0 || !context.restrictedClient
        ? `the directories this server was started with (${[...allowedRoots, ...readable].join(', ') || 'none'})`
        : readRoots.length > 0
          ? `the directories this server was started with and the client's workspace roots (${readable.join(', ')})`
          : `the client's workspace roots (${readable.join(', ') || 'none'})`;
    const subject =
      repoRoot === undefined
        ? `${target} is outside ${where}`
        : `${target} belongs to the repository at ${repoRoot}, which extends outside ${where}`;
    return new ToolError(
      `${subject}. Start the server with --read <dir> to read repositories elsewhere ` +
        'without git, or with --allow <dir> or GITGLASSES_ALLOWED_ROOTS to let git run there too.',
    );
  }

  async function repoFor(repoPath: string): Promise<ServedRepo> {
    const key = canonicalPath(repoPath);
    const access = await accessFor(key);
    if (access === undefined) throw await outsideRootsError(key);
    const client = access === 'trusted' ? context.client : context.restrictedClient;
    if (!client) throw await outsideRootsError(key);
    let pending = repos.get(key);
    if (!pending) {
      pending = client
        .request('repo/discover', { path: key })
        .then((info) => ({ ...info, client }));
      pending.catch(() => repos.delete(key));
      if (repos.size >= MAX_REPO_IDS) {
        const oldest = repos.keys().next().value;
        if (oldest !== undefined) repos.delete(oldest);
      }
      repos.set(key, pending);
    }
    const repo = await pending;
    // repo/discover walks upwards, so a path inside a root can belong to a
    // repository that is mostly outside it; that repository is not served.
    if ((await accessFor(repo.rootPath)) !== access) {
      repos.delete(key);
      throw await outsideRootsError(key, repo.rootPath);
    }
    return repo;
  }

  /**
   * The already-discovered repository for `repoPath`, without discovering one.
   * Failed discoveries leave no entry, so the error path never retries them.
   */
  async function discoveredRepo(repoPath: string): Promise<ServedRepo | undefined> {
    try {
      return await repos.get(canonicalPath(repoPath));
    } catch {
      return undefined;
    }
  }

  /** True when HEAD points at no commit; false when that cannot be determined. */
  async function hasNoCommits(repo: ServedRepo): Promise<boolean> {
    try {
      return (await repo.client.request('repo/state', { repoId: repo.repoId })).head.unborn;
    } catch {
      return false;
    }
  }

  /** True for an engine refusal caused by Restricted Mode. */
  function hunklessReason(error: unknown): string | undefined {
    switch ((error as { code?: unknown } | undefined)?.code) {
      case ErrorCodes.FilterNeedsGitCli:
        return 'a filter or working-tree-encoding that needs git applies to it';
      case ErrorCodes.WholeFileOnly:
        return 'a submodule or Git LFS file, changed as a whole';
      default:
        return undefined;
    }
  }

  function isRestrictedRefusal(error: unknown): boolean {
    return (error as { code?: unknown } | undefined)?.code === ErrorCodes.Restricted;
  }

  /** Why `tool` cannot run in a repository served without git. */
  function restrictedMessage(tool: string, repoPath: string): string {
    const purpose = NEEDS_GIT[tool] ?? 'this';
    return (
      `${tool} needs git for ${purpose}, and this server runs git only in repositories ` +
      'inside the directories it was started with (--allow or GITGLASSES_ALLOWED_ROOTS). ' +
      `${repoPath} is read without running git (it is in the client's workspace roots or a ` +
      "--read directory), because git would run programs that the repository's own " +
      'configuration names.'
    );
  }

  /** git_file_history for a range of lines: the commits that changed them. */
  async function lineHistory(args: {
    repoPath: string;
    file: string;
    cursor?: string;
    limit: number;
    startLine?: number;
    endLine?: number;
  }): Promise<string> {
    if (args.startLine === undefined) throw new ToolError('"endLine" needs "startLine"');
    const startLine = args.startLine;
    const endLine = args.endLine ?? startLine;
    if (endLine < startLine) throw new ToolError('"endLine" must not be before "startLine"');
    if (args.cursor !== undefined) {
      throw new ToolError(
        '"cursor" pages the history of a whole file; for a range of lines raise "limit" instead',
      );
    }
    const repo = await repoFor(args.repoPath);
    const { entries } = await repo.client.request('history/line', {
      repoId: repo.repoId,
      path: args.file,
      startLine,
      endLine,
    });
    const shown = entries.slice(0, args.limit);
    let rendered = formatLineHistory(args.file, startLine, endLine, shown);
    if (entries.length > shown.length) {
      rendered +=
        `\n\n(${entries.length - shown.length} older commits also changed these lines; ` +
        `raise "limit" (max ${MAX_HISTORY_ENTRIES}) to list them)`;
    }
    return orEmptyRepository(repo, args.repoPath, rendered, entries.length === 0);
  }

  /**
   * `rendered` unless the repository has no commits, in which case that is the
   * fact the caller needs: "nothing found" invites a retry, "no commits yet"
   * does not. Costs one request, and only when a result came back empty.
   */
  async function orEmptyRepository(
    repo: ServedRepo,
    repoPath: string,
    rendered: string,
    isEmpty: boolean,
  ): Promise<string> {
    if (!isEmpty || !(await hasNoCommits(repo))) return rendered;
    return emptyRepositoryMessage(repoPath);
  }

  /**
   * An engine failure rewritten for the agent: the empty-repository case is
   * confirmed against repo/state where the repository is known, and the rest
   * goes through explainEngineError.
   */
  async function describeFailure(
    tool: string,
    repoPath: string | undefined,
    error: unknown,
  ): Promise<Error> {
    if (error instanceof ToolError) return error;
    const message = error instanceof Error ? error.message : String(error);
    if (repoPath === undefined) return new ToolError(message);
    const repo = await discoveredRepo(repoPath);
    if (repo && (await hasNoCommits(repo))) {
      return new ToolError(emptyRepositoryMessage(repoPath));
    }
    if (isRestrictedRefusal(error)) return new ToolError(restrictedMessage(tool, repoPath));
    return new ToolError(
      explainEngineError(message, {
        repoPath,
        resolvedPaths: [canonicalPath(repoPath), repo?.rootPath].filter(
          (value): value is string => value !== undefined,
        ),
      }),
    );
  }

  /**
   * Working-tree file content holds a NUL byte, as git's own binary test does.
   * `file` reaches this from a tool argument, so the resolved path must stay
   * inside the repository and inside the allowed roots; anything else reads as
   * not binary and the rendering omits the marker.
   */
  async function isBinaryInWorkingTree(rootPath: string, file: string): Promise<boolean> {
    const resolved = canonicalPath(path.join(rootPath, file));
    if (!isWithinAllowedRoots(resolved, [rootPath])) return false;
    if ((await accessFor(resolved)) === undefined) return false;
    let handle: fs.promises.FileHandle | undefined;
    try {
      handle = await fs.promises.open(resolved, 'r');
      const { buffer, bytesRead } = await handle.read(Buffer.alloc(8000), 0, 8000, 0);
      return buffer.subarray(0, bytesRead).includes(0);
    } catch {
      return false;
    } finally {
      await handle?.close();
    }
  }

  /**
   * Paths in `files` whose change is binary. git reports binary changes as
   * +0 -0, so only those files are probed; a mode-only change reports the same
   * counts and is not binary.
   */
  async function binaryPathsInCommit(
    repo: ServedRepo,
    sha: string,
    files: readonly FileChange[],
  ): Promise<Set<string>> {
    const candidates = files
      .filter((file) => file.additions === 0 && file.deletions === 0)
      .slice(0, MAX_BINARY_PROBES);
    const found = await Promise.all(
      candidates.map(async (file) => {
        // A deleted file exists only in the parent commit.
        const rev = file.status === 'D' ? `${sha}^` : sha;
        try {
          const { binary } = await repo.client.request('rev/fileAtRev', {
            repoId: repo.repoId,
            path: file.path,
            rev,
          });
          return binary ? file.path : undefined;
        } catch {
          return undefined;
        }
      }),
    );
    return new Set(found.filter((path): path is string => path !== undefined));
  }

  const handlers = {
    async git_blame(args: {
      repoPath: string;
      file: string;
      line?: number;
      startLine?: number;
      limit?: number;
    }): Promise<string> {
      const repo = await repoFor(args.repoPath);
      const streamId = randomUUID();
      // Caps the hunks held in memory and returned to the caller.
      const limit = Math.min(args.limit ?? DEFAULT_BLAME_HUNKS, MAX_BLAME_HUNKS);
      const startLine = args.startLine ?? 1;
      // The engine streams hunks in blame order, not line order, so the lowest
      // `limit` lines are selected by ordered insertion: bounded memory, and a
      // page that really is the next one by line.
      const hunks: BlameHunk[] = [];
      let truncated = false;
      const sub = repo.client.onNotification('blame/hunks', (params) => {
        if (params.streamId !== streamId) return;
        for (const hunk of params.hunks) {
          const lastLine = hunk.resultLine + hunk.lineCount - 1;
          // A single-line or paged request only needs the hunks it covers.
          if (lastLine < startLine) continue;
          if (
            args.line !== undefined &&
            !(args.line >= hunk.resultLine && args.line < hunk.resultLine + hunk.lineCount)
          ) {
            continue;
          }
          let low = 0;
          let high = hunks.length;
          while (low < high) {
            const mid = (low + high) >>> 1;
            if (hunks[mid].resultLine < hunk.resultLine) low = mid + 1;
            else high = mid;
          }
          hunks.splice(low, 0, hunk);
          if (hunks.length > limit) {
            hunks.pop();
            truncated = true;
          }
        }
      });
      try {
        const result = await repo.client.request('blame/file', {
          repoId: repo.repoId,
          path: args.file,
          streamId,
        });
        const binary = await isBinaryInWorkingTree(repo.rootPath, args.file);
        const rendered = formatBlame(args.file, hunks, result.commits, args.line, binary);
        if (!truncated) {
          return orEmptyRepository(repo, args.repoPath, rendered, hunks.length === 0);
        }
        const last = hunks[hunks.length - 1];
        const nextLine = last.resultLine + last.lineCount;
        return (
          `${rendered}\n\n(showing ${limit} hunks of ${result.totalLines} lines; ` +
          `pass startLine: ${nextLine} for the next page, or "line" to blame one line)`
        );
      } finally {
        sub.dispose();
      }
    },

    async git_log_search(args: {
      repoPath: string;
      text?: string;
      author?: string;
      sha?: string;
      content?: string;
      regex?: boolean;
      path?: string;
      since?: string;
      until?: string;
      cursor?: string;
      limit: number;
    }): Promise<string> {
      if (args.regex && args.content === undefined) {
        throw new ToolError('regex applies to "content"; pass the expression as "content"');
      }
      const repo = await repoFor(args.repoPath);
      const { client, repoId } = repo;
      // Code changes, paths and dates are git log's to answer; message text,
      // author and sha are read straight from the repository.
      const needsLog =
        args.content !== undefined ||
        args.path !== undefined ||
        args.since !== undefined ||
        args.until !== undefined;
      const hasQuery =
        needsLog || args.text !== undefined || args.author !== undefined || args.sha !== undefined;
      if (!hasQuery) {
        const page = await client.request('log/commits', {
          repoId,
          cursor: args.cursor,
          limit: args.limit,
        });
        const rendered =
          page.nextCursor === undefined
            ? formatCommits(page.commits, 'No commits on this branch')
            : `${formatCommits(page.commits)}\n\n(more commits: call again with cursor: ${JSON.stringify(page.nextCursor)})`;
        return orEmptyRepository(repo, args.repoPath, rendered, page.commits.length === 0);
      }
      if (args.cursor !== undefined) {
        throw new ToolError(
          'cursor only pages the unfiltered log; with filters, raise "limit" (max 500) or narrow the query',
        );
      }
      if (needsLog && args.sha !== undefined) {
        throw new ToolError(
          'sha cannot be combined with content, path, since or until; call git_commit_show for one commit',
        );
      }
      const streamId = randomUUID();
      const matches: CommitSummaryInfo[] = [];
      const sub = client.onNotification('search/matches', (params) => {
        if (params.streamId === streamId) matches.push(...params.matches);
      });
      try {
        const result = needsLog
          ? await client.request('search/log', {
              repoId,
              streamId,
              limit: args.limit,
              query: {
                text: args.text,
                author: args.author,
                content: args.content,
                contentMode:
                  args.content === undefined ? undefined : args.regex ? 'regex' : 'string',
                path: args.path,
                since: args.since,
                until: args.until,
              },
            })
          : await client.request('search/commits', {
              repoId,
              streamId,
              limit: args.limit,
              query: { text: args.text, author: args.author, sha: args.sha },
            });
        const rendered = formatCommits(matches);
        // The engine caps `total` at `limit`, so the count of matches beyond
        // the limit is not available to report.
        if (result.truncated) {
          return `${rendered}\n\n(showing the first ${matches.length} matches; more exist — raise "limit" (max 500) or add filters)`;
        }
        return orEmptyRepository(repo, args.repoPath, rendered, matches.length === 0);
      } finally {
        sub.dispose();
      }
    },

    async git_file_history(args: {
      repoPath: string;
      file: string;
      cursor?: string;
      limit: number;
      startLine?: number;
      endLine?: number;
    }): Promise<string> {
      if (args.startLine !== undefined || args.endLine !== undefined) {
        return lineHistory(args);
      }
      const repo = await repoFor(args.repoPath);
      const result = await repo.client.request('history/file', {
        repoId: repo.repoId,
        path: args.file,
        cursor: args.cursor,
        limit: args.limit,
      });
      const rendered =
        result.nextCursor === undefined
          ? formatHistory(args.file, result.entries)
          : `${formatHistory(args.file, result.entries)}\n\n(more commits: call again with cursor: ${JSON.stringify(result.nextCursor)})`;
      return orEmptyRepository(repo, args.repoPath, rendered, result.entries.length === 0);
    },

    async git_commit_show(args: {
      repoPath: string;
      sha: string;
      includeDiff?: boolean;
      maxChars?: number;
    }): Promise<string> {
      const repo = await repoFor(args.repoPath);
      const { client, repoId } = repo;
      const [page, diff] = await Promise.all([
        client.request('log/commits', { repoId, ref: args.sha, limit: 1 }),
        client.request('diff/commit', { repoId, sha: args.sha }),
      ]);
      const commit = page.commits[0];
      if (!commit) {
        throw new ToolError(
          `no commit at "${args.sha}"; call git_refs for branches and tags or git_log_search for shas`,
        );
      }
      // The patch already labels its binary files, so the stat block only
      // needs its own probe when the patch was not fetched.
      let patch: string | undefined;
      let omitted: string | undefined;
      if (args.includeDiff) {
        try {
          const result = await client.request('patch/create', {
            repoId,
            source: { kind: 'commit', sha: commit.sha },
          });
          patch = result.envelope.patch;
        } catch (error) {
          // Served without git: the file list still stands, so the diff is
          // left out with the reason rather than failing the whole call.
          if (!isRestrictedRefusal(error)) throw error;
          omitted = restrictedMessage('git_commit_show', args.repoPath);
        }
      }
      const binaryPaths =
        patch === undefined
          ? await binaryPathsInCommit(repo, commit.sha, diff.files)
          : binaryPathsInPatch(patch);
      const rendered = formatCommitShow(commit, diff.files, { binaryPaths, diff: patch });
      const limit = resultChars(args.maxChars);
      return truncateText(
        omitted === undefined ? rendered : `${rendered}\n\n(diff omitted: ${omitted})`,
        limit,
        charLimitHint(
          limit,
          args.includeDiff
            ? 'omit "includeDiff" for the file list alone'
            : 'the commit touches this many files',
        ),
      );
    },

    async git_graph_summary(args: {
      repoPath: string;
      cursor?: string;
      limit: number;
    }): Promise<string> {
      const repo = await repoFor(args.repoPath);
      const result = await repo.client.request('graph/rows', {
        repoId: repo.repoId,
        cursor: args.cursor,
        limit: args.limit,
        include: { stashes: true, wip: true },
      });
      const rendered =
        result.nextCursor === undefined
          ? formatGraph(result.rows)
          : `${formatGraph(result.rows)}\n\n(more rows: call again with cursor: ${JSON.stringify(result.nextCursor)})`;
      return orEmptyRepository(repo, args.repoPath, rendered, result.rows.length === 0);
    },

    async git_status(args: { repoPath: string; maxChars?: number }): Promise<string> {
      const { client, repoId } = await repoFor(args.repoPath);
      const [status, state] = await Promise.all([
        client.request('status/summary', { repoId }),
        client.request('repo/state', { repoId }),
      ]);
      const limit = resultChars(args.maxChars);
      return truncateText(
        formatStatus(status, state.head),
        limit,
        charLimitHint(limit, 'the working tree has this many changed files'),
      );
    },

    async git_diff(args: {
      repoPath: string;
      file?: string;
      staged?: boolean;
      maxChars?: number;
    }): Promise<string> {
      const repo = await repoFor(args.repoPath);
      const staged = args.staged ?? false;
      const scope = staged ? 'staged' : 'unstaged';
      const status = await repo.client.request('status/summary', { repoId: repo.repoId });
      // Untracked files are uncommitted work too, and the working-tree diff is
      // the only place an agent would look for them.
      const changed: { path: string; status: string; origPath?: string }[] = staged
        ? status.staged.map((f) => ({ path: f.path, status: f.status, origPath: f.origPath }))
        : [
            ...status.unstaged.map((f) => ({
              path: f.path,
              status: f.status,
              origPath: f.origPath,
            })),
            ...status.conflicted.map((path) => ({ path, status: 'U' })),
            ...status.untracked.map((path) => ({ path, status: '?' })),
          ];
      const selected =
        args.file === undefined
          ? changed.slice(0, MAX_DIFF_FILES)
          : changed.filter((f) => f.path === args.file);
      const limit = resultChars(args.maxChars);
      // Files are fetched in batches until the character budget is spent, so
      // only as many diffs as the result can hold are read.
      const entries: DiffFileEntry[] = [];
      let budget = limit;
      for (let start = 0; start < selected.length && budget > 0; start += DIFF_FETCH_BATCH) {
        const batch = await Promise.all(
          selected.slice(start, start + DIFF_FETCH_BATCH).map(async (file) => {
            let hunks;
            try {
              ({ hunks } = await repo.client.request('diff/fileHunks', {
                repoId: repo.repoId,
                path: file.path,
                staged,
              }));
            } catch (error) {
              // A path whose content only the git CLI can clean, or whose change
              // can't be split into hunks, is listed with the reason instead of
              // failing the whole diff.
              const omitted = hunklessReason(error);
              if (omitted === undefined) throw error;
              return { ...file, hunks: [], omitted };
            }
            return {
              ...file,
              hunks,
              binary: hunks.length === 0 && (await isBinaryInWorkingTree(repo.rootPath, file.path)),
            };
          }),
        );
        for (const entry of batch) {
          entries.push(entry);
          for (const hunk of entry.hunks) {
            budget -= hunk.header.length + hunk.lines.reduce((n, l) => n + l.length + 1, 0);
          }
        }
      }
      return truncateText(
        formatDiff(
          scope,
          entries,
          args.file,
          args.file === undefined ? changed.length : entries.length,
        ),
        limit,
        charLimitHint(limit, 'pass "file" to diff one file at a time'),
      );
    },

    async git_refs(args: { repoPath: string; maxChars?: number }): Promise<string> {
      const repo = await repoFor(args.repoPath);
      const refs = await repo.client.request('refs/list', { repoId: repo.repoId });
      const limit = resultChars(args.maxChars);
      const empty =
        refs.branches.length === 0 && refs.tags.length === 0 && refs.remotes.length === 0;
      return orEmptyRepository(
        repo,
        args.repoPath,
        truncateText(
          formatRefs(refs),
          limit,
          charLimitHint(limit, 'the repository has this many refs'),
        ),
        empty,
      );
    },

    async git_compare(args: CompareArgs): Promise<string> {
      const { client, repoId } = await repoFor(args.repoPath);
      const limit = resultChars(args.maxChars);
      return compareRevisions(args, {
        client,
        repoId,
        maxChars: limit,
        truncationHint: (narrow) => charLimitHint(limit, narrow),
        diffUnavailable: (error) =>
          isRestrictedRefusal(error) ? restrictedMessage('git_compare', args.repoPath) : undefined,
      });
    },

    async create_patch(args: {
      repoPath: string;
      source: string;
      maxChars?: number;
    }): Promise<string> {
      const source = parsePatchSource(args.source);
      const { client, repoId } = await repoFor(args.repoPath);
      const result = await client.request('patch/create', { repoId, source });
      const limit = resultChars(args.maxChars);
      return truncateText(
        formatPatchEnvelope(result.envelope),
        limit,
        `a truncated patch cannot be applied; ${charLimitHint(
          limit,
          "narrow the source to a single commit with 'commit:<revision>'",
        )}`,
      );
    },

    async apply_patch(args: { repoPath: string; envelopeJson: string }): Promise<string> {
      let envelope: PatchEnvelope;
      // Two accepted forms: a JSON envelope, or the metadata lines plus raw
      // patch that create_patch returns.
      if (args.envelopeJson.trimStart().startsWith('{')) {
        try {
          envelope = JSON.parse(args.envelopeJson) as PatchEnvelope;
        } catch {
          throw new ToolError('envelopeJson is not valid JSON');
        }
      } else {
        try {
          envelope = parsePatchEnvelopeText(args.envelopeJson);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          throw new ToolError(`envelopeJson is not create_patch output: ${message}`);
        }
      }
      // The engine rejects a malformed envelope too; checking it here names
      // the offending field instead of surfacing a round trip's -32602.
      const envelopeError = patchEnvelopeError(envelope);
      if (envelopeError) {
        throw new ToolError(`envelopeJson is not a valid patch envelope: ${envelopeError}`);
      }
      const { client, repoId } = await repoFor(args.repoPath);
      const result = await client.request('patch/apply', { repoId, envelope });
      const lines = [
        `applied: ${result.applied}`,
        `conflicts: ${result.conflicts}`,
        `base found: ${result.baseFound}`,
      ];
      // git's explanation of a patch it did not apply; its later lines are
      // indented under the first.
      if (result.message) {
        const [first, ...rest] = result.message.split(/\r?\n/);
        lines.push(`message: ${first}`, ...rest.map((line) => `  ${line}`));
      }
      return lines.join('\n');
    },

    // Takes no arguments: the hosts and their tokens all come from the
    // environment (see configuredHosts).
    async list_my_prs(_args?: Record<string, never>): Promise<string> {
      const hosts = configuredHosts(env, context.fetchFn);
      if (hosts.length === 0) {
        throw new ToolError(
          `No hosting service is configured; set ${HOST_SETTINGS} in the server environment`,
        );
      }
      const results = await fetchMyPullRequests(hosts);
      const failures = results.filter((result) => 'error' in result);
      if (failures.length === results.length) {
        throw new ToolError(
          failures
            .map((failure) =>
              results.length > 1 ? `${failure.label}: ${failure.error}` : failure.error,
            )
            .join('; '),
        );
      }
      return formatHostResults(results);
    },
  };

  // Every handler reports failures through describeFailure, so a direct caller
  // and an MCP client see the same restated message.
  const explained = {} as Record<string, (args: never) => Promise<string>>;
  for (const [name, handler] of Object.entries(handlers)) {
    explained[name] = async (args: { repoPath?: string }) => {
      try {
        return await (handler as (a: unknown) => Promise<string>)(args);
      } catch (error) {
        throw await describeFailure(name, args?.repoPath, error);
      }
    };
  }
  return explained as typeof handlers;
}

export type ToolHandlers = ReturnType<typeof createToolHandlers>;

type ToolResult = {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
};

function asToolResult<A>(fn: (args: A) => Promise<string>): (args: A) => Promise<ToolResult> {
  return async (args) => {
    try {
      return { content: [{ type: 'text', text: await fn(args) }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { content: [{ type: 'text', text: message }], isError: true };
    }
  };
}

const repoPath = z
  .string()
  .describe(
    "Absolute path to (or inside) the git repository. Only repositories inside the client's " +
      'workspace roots, or inside the directories the server was started with (--read, ' +
      '--allow, GITGLASSES_ALLOWED_ROOTS), are served; other paths are rejected.',
  );

const maxChars = z
  .number()
  .int()
  .min(1)
  .max(MAX_RESULT_CHARS)
  .optional()
  .describe(
    `Maximum characters to return before truncation (default ${DEFAULT_RESULT_CHARS}, max ${MAX_RESULT_CHARS})`,
  );

const isoDate = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(Z|[+-]\d{2}:\d{2})?)?$/,
    'expected YYYY-MM-DD, or YYYY-MM-DDTHH:MM:SS with an optional Z or UTC offset',
  )
  .optional();

const cursor = z
  .string()
  .optional()
  .describe('Opaque cursor from a previous call\'s "(more ...)" footer; fetches the next page');

/** Tools that only read the repository and the hosting provider. */
const readOnly = { readOnlyHint: true } as const;

/** How long a roots/list request may take before the client counts as offering none. */
const LIST_ROOTS_TIMEOUT_MS = 10_000;

/**
 * The client's MCP roots as canonical local directories, re-read after every
 * notifications/roots/list_changed. Resolves to undefined when the client does
 * not offer roots, and to an empty list when it does but the request fails or
 * no root is a local directory, so a misbehaving client is served nothing
 * rather than everything.
 */
export function trackClientRoots(server: McpServer): () => Promise<readonly string[] | undefined> {
  let current: Promise<readonly string[] | undefined> | undefined;
  const fetchRoots = async (): Promise<readonly string[] | undefined> => {
    if (!server.server.getClientCapabilities()?.roots) return undefined;
    try {
      const { roots } = await server.server.listRoots(undefined, {
        timeout: LIST_ROOTS_TIMEOUT_MS,
      });
      return roots.flatMap((root) => {
        if (!root.uri.startsWith('file:')) return [];
        try {
          return [canonicalPath(fileURLToPath(root.uri))];
        } catch {
          return [];
        }
      });
    } catch {
      return [];
    }
  };
  server.server.setNotificationHandler(RootsListChangedNotificationSchema, async () => {
    current = fetchRoots();
  });
  // Capabilities are known once the client has initialized; a read before
  // that would cache "no roots".
  server.server.oninitialized = () => {
    current = undefined;
  };
  return () => (current ??= fetchRoots());
}

export function createServer(context: ToolContext): McpServer {
  const server = new McpServer({ name: 'gitglasses', version: SERVER_VERSION });
  const handlers = createToolHandlers({
    ...context,
    clientRoots: context.clientRoots ?? trackClientRoots(server),
  });

  server.registerTool(
    'git_blame',
    {
      description:
        'Who last changed each line of a file: per-hunk author, date, sha and commit summary. ' +
        'Pass "line" for one line, or "startLine" to page through a long file.',
      inputSchema: {
        repoPath,
        file: z.string().describe('File path relative to the repository root'),
        line: z.number().int().min(1).optional().describe('1-based line to blame'),
        startLine: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe('1-based line to start from, skipping earlier hunks (default 1)'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_BLAME_HUNKS)
          .optional()
          .describe(`Maximum blame hunks to return (default ${DEFAULT_BLAME_HUNKS})`),
      },
      annotations: readOnly,
    },
    asToolResult(handlers.git_blame),
  );

  server.registerTool(
    'git_log_search',
    {
      description:
        "Search the current branch's commits by message text, author, sha, code change " +
        '(content, like git log -S/-G), path or date; without filters, list recent commits ' +
        'newest first. Filters are combined with AND. content, path, since and until run git, ' +
        'so they work only in repositories inside the directories the server was started ' +
        'with (--allow).',
      inputSchema: {
        repoPath,
        text: z.string().optional().describe('Case-insensitive substring of the commit message'),
        author: z
          .string()
          .optional()
          .describe('Case-insensitive substring of the author name or email'),
        sha: z.string().optional().describe('Commit sha, or a prefix of one'),
        content: z
          .string()
          .min(1)
          .optional()
          .describe(
            'Code a commit added or removed: commits that change how often this exact string ' +
              'occurs (git log -S), or with regex:true, commits whose added or removed lines ' +
              'match this extended regular expression (git log -G). Use it to find when a ' +
              'function, setting or message was introduced or removed.',
          ),
        regex: z
          .boolean()
          .optional()
          .describe('Treat "content" as an extended regular expression (default false)'),
        path: z
          .string()
          .min(1)
          .optional()
          .describe(
            'Only commits that touch this path, relative to the repository root (a git ' +
              'pathspec: a file, a directory or a glob such as "src/*.ts")',
          ),
        since: isoDate.describe('Only commits committed on or after this date (YYYY-MM-DD)'),
        until: isoDate.describe('Only commits committed before this date (YYYY-MM-DD)'),
        cursor: cursor.describe(
          'Opaque cursor from a previous unfiltered call\'s "(more commits ...)" footer. ' +
            'Filtered searches cannot be paged; raise "limit" instead.',
        ),
        limit: z.number().int().min(1).max(500).default(20),
      },
      annotations: readOnly,
    },
    asToolResult(handlers.git_log_search),
  );

  server.registerTool(
    'git_file_history',
    {
      description:
        'Commit history of a file, following renames, newest first. With startLine (and ' +
        'endLine), only the commits that changed those lines, followed through moves and ' +
        'renames (git log -L): when and why a function or block changed. Runs git, so it ' +
        'works only in repositories inside the directories the server was started with (--allow).',
      inputSchema: {
        repoPath,
        file: z.string().describe('File path relative to the repository root'),
        cursor,
        limit: z.number().int().min(1).max(MAX_HISTORY_ENTRIES).default(20),
        startLine: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe('1-based first line of a range to follow instead of the whole file'),
        endLine: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe('1-based last line of the range (default startLine)'),
      },
      annotations: readOnly,
    },
    asToolResult(handlers.git_file_history),
  );

  server.registerTool(
    'git_commit_show',
    {
      description:
        'What one commit changed: metadata, changed files with addition/deletion counts, ' +
        'and with includeDiff the full patch text.',
      inputSchema: {
        repoPath,
        sha: z
          .string()
          .describe(
            'Any revision git resolves: a full sha, a unique prefix, a branch or tag name, ' +
              'HEAD, or an expression such as HEAD~3',
          ),
        includeDiff: z
          .boolean()
          .optional()
          .describe(
            'Append the unified diff of the commit (default false). Binary files are ' +
              'reported as differing rather than shown. The diff needs git, so outside the ' +
              'directories the server was started with (--allow) it is omitted with a note.',
          ),
        maxChars,
      },
      annotations: readOnly,
    },
    asToolResult(handlers.git_commit_show),
  );

  server.registerTool(
    'git_diff',
    {
      description:
        'Uncommitted changes as unified diff text: unstaged by default, staged with staged:true. ' +
        'Pass "file" for one file. Use git_commit_show for a committed change.',
      inputSchema: {
        repoPath,
        file: z
          .string()
          .optional()
          .describe('Limit the diff to this path, relative to the repository root'),
        staged: z
          .boolean()
          .optional()
          .describe(
            'Diff the index against HEAD instead of the working tree against the index ' +
              '(default false). Untracked files appear only in the unstaged diff.',
          ),
        maxChars,
      },
      annotations: readOnly,
    },
    asToolResult(handlers.git_diff),
  );

  server.registerTool(
    'git_refs',
    {
      description:
        'Branches, remote-tracking branches and tags with the sha each points at. ' +
        'Use it to find a valid ref for git_commit_show or git_log_search.',
      inputSchema: { repoPath, maxChars },
      annotations: readOnly,
    },
    asToolResult(handlers.git_refs),
  );

  server.registerTool(
    'git_compare',
    {
      description: COMPARE_DESCRIPTION,
      inputSchema: compareInputSchema({ repoPath, maxChars }),
      annotations: readOnly,
    },
    asToolResult(handlers.git_compare),
  );

  server.registerTool(
    'git_graph_summary',
    {
      description: 'Text rendering of the commit graph: lane-indented sha, summary and refs.',
      inputSchema: {
        repoPath,
        cursor,
        limit: z.number().int().min(1).max(500).default(30),
      },
      annotations: readOnly,
    },
    asToolResult(handlers.git_graph_summary),
  );

  server.registerTool(
    'git_status',
    {
      description:
        'Branch, ahead/behind, staged, unstaged, untracked and conflicted files. ' +
        'Names an unborn or detached HEAD explicitly.',
      inputSchema: { repoPath, maxChars },
      annotations: readOnly,
    },
    asToolResult(handlers.git_status),
  );

  server.registerTool(
    'create_patch',
    {
      description:
        "Create a shareable gitglasses patch from 'wip', 'stash:<n>' or 'commit:<revision>': envelope metadata lines followed by the raw patch. Runs git, so it works only in repositories inside the directories the server was started with (--allow).",
      inputSchema: {
        repoPath,
        source: z
          .string()
          .describe(
            "Patch source: 'wip', 'stash:<n>' or 'commit:<revision>', where the revision is a " +
              'sha, HEAD, HEAD~2, a branch or a tag',
          ),
        maxChars,
      },
      annotations: readOnly,
    },
    asToolResult(handlers.create_patch),
  );

  server.registerTool(
    'apply_patch',
    {
      description:
        'Apply a gitglasses patch to the repository, writing to the working tree. Runs git, ' +
        'so it works only in repositories inside the directories the server was started with ' +
        '(--allow).',
      inputSchema: {
        repoPath,
        envelopeJson: z
          .string()
          .describe('create_patch output, or an equivalent patch envelope as JSON'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    asToolResult(handlers.apply_patch),
  );

  server.registerTool(
    'list_my_prs',
    {
      description:
        'Open pull requests involving you on each hosting service the server environment has a ' +
        'token for (GitHub, GitLab, Bitbucket, Azure DevOps), grouped into launchpad buckets ' +
        '(blocked, needs-your-review, ...). Takes no arguments: hosts and tokens come only from ' +
        'the environment.',
      inputSchema: {},
      annotations: readOnly,
    },
    asToolResult(handlers.list_my_prs),
  );

  return server;
}
