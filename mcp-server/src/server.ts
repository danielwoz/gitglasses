// The gitglasses MCP server: tool handlers over the engine client plus the
// hosting-provider integrations, and their registration on an McpServer.

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type {
  BlameHunk,
  CommitSummaryInfo,
  FileChange,
  PatchEnvelope,
  RepoInfo,
} from '@gitglasses/protocol';
import { patchEnvelopeError } from '@gitglasses/protocol';
import {
  GitHubProvider,
  createGitHubEnterpriseProvider,
  groupItems,
  type FetchLike,
  type HostingProvider,
} from '@gitglasses/integrations';
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
  formatLaunchpad,
  formatPatchEnvelope,
  formatRefs,
  formatStatus,
  looksBinary,
  parsePatchEnvelopeText,
  parsePatchSource,
  truncateText,
  type DiffFileEntry,
} from './format.js';

/**
 * A bare hostname, optionally with a port: letters, digits, hyphens and dots.
 *
 * Anything that could redirect an authenticated request elsewhere is rejected:
 * userinfo ("api.github.com@attacker.example" reads as GitHub but resolves to
 * the attacker), a scheme, a path, or whitespace.
 */
export function isPlainHostname(value: string): boolean {
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d{1,5})?$/i.test(
    value,
  );
}

/**
 * The GitHub host this server talks to, from operator configuration only.
 *
 * A token and the host it is valid for are inseparable, and the token comes
 * from the environment — so the host must too. It was previously a tool
 * argument, which let a prompt-injected agent name any host and have the
 * user's PAT sent there in a single request.
 */
export function configuredGitHubHost(
  env: Record<string, string | undefined>,
): string | undefined {
  const host = env.GITGLASSES_GITHUB_HOST?.trim();
  if (!host || host === 'github.com') return undefined;
  if (!isPlainHostname(host)) {
    throw new Error(
      `GITGLASSES_GITHUB_HOST is not a plain hostname: ${JSON.stringify(host)}`,
    );
  }
  return host;
}

/**
 * Directories this server may read, from GITGLASSES_ALLOWED_ROOTS
 * (path-separator delimited). An empty list means unrestricted.
 *
 * Tools take an absolute repoPath and repo/discover walks *upwards*, so
 * without a bound any path on the machine grants the repository containing
 * it — a prompt-injected agent could read commit messages and diffs out of
 * unrelated private repositories. Unrestricted stays the default so existing
 * setups keep working, but it is now a stated choice rather than an
 * unexamined one.
 */
export function parseAllowedRoots(raw: string | undefined): string[] {
  if (!raw?.trim()) return [];
  return raw
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
    .map((entry) => canonicalPath(entry));
}

/**
 * `target` as an absolute path with every symlink resolved. When the path does
 * not exist, the deepest existing ancestor is resolved and the remaining
 * segments appended, so a symlinked parent directory is still followed.
 *
 * Containment compares canonical paths on both sides: a lexical comparison
 * accepts a symlink inside a root that points outside it.
 */
export function canonicalPath(target: string): string {
  const resolved = path.resolve(target);
  const remainder: string[] = [];
  let current = resolved;
  for (;;) {
    try {
      return path.join(fs.realpathSync(current), ...remainder);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return resolved;
      remainder.unshift(path.basename(current));
      current = parent;
    }
  }
}

/**
 * True when `target` is one of `roots` or sits inside one.
 *
 * Both sides are canonicalised here: a symlink under an allowed root resolves
 * outside it, and a lexical comparison would admit it.
 */
export function isWithinAllowedRoots(target: string, roots: readonly string[]): boolean {
  if (roots.length === 0) return true;
  const resolved = canonicalPath(target);
  return roots.some((root) => {
    const relative = path.relative(canonicalPath(root), resolved);
    // Empty means target === root; a leading ".." or an absolute result means
    // it escaped. path.relative already normalises the "repoA/../secret" case.
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  });
}

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
  client: EngineClient;
  /** Environment for tokens; defaults to process.env. */
  env?: Record<string, string | undefined>;
  /** HTTP transport for hosting providers; tests inject a stub. */
  fetchFn?: FetchLike;
}

/**
 * Tool handlers returning plain text. Kept separate from MCP registration so
 * integration tests can drive them directly against a live engine.
 */
export function createToolHandlers(context: ToolContext) {
  const { client } = context;
  const env = context.env ?? process.env;
  // Bounded: keyed by resolved path, so an agent walking many paths would
  // otherwise grow it without limit. Oldest entry is dropped on overflow.
  const repos = new Map<string, Promise<RepoInfo>>();
  const MAX_REPO_IDS = 64;

  const allowedRoots = parseAllowedRoots(env.GITGLASSES_ALLOWED_ROOTS);

  function repoFor(repoPath: string): Promise<RepoInfo> {
    const key = canonicalPath(repoPath);
    if (!isWithinAllowedRoots(key, allowedRoots)) {
      throw new ToolError(
        `path is outside GITGLASSES_ALLOWED_ROOTS: ${key}. ` +
          'Set GITGLASSES_ALLOWED_ROOTS to the directories this server may read.',
      );
    }
    let info = repos.get(key);
    if (!info) {
      info = client.request('repo/discover', { path: key });
      info.catch(() => repos.delete(key));
      if (repos.size >= MAX_REPO_IDS) {
        const oldest = repos.keys().next().value;
        if (oldest !== undefined) repos.delete(oldest);
      }
      repos.set(key, info);
    }
    return info;
  }

  async function repoIdFor(repoPath: string): Promise<string> {
    return (await repoFor(repoPath)).repoId;
  }

  /**
   * The already-discovered repository for `repoPath`, without discovering one.
   * Failed discoveries leave no entry, so the error path never retries them.
   */
  async function discoveredRepo(repoPath: string): Promise<RepoInfo | undefined> {
    try {
      return await repos.get(canonicalPath(repoPath));
    } catch {
      return undefined;
    }
  }

  /** True when HEAD points at no commit; false when that cannot be determined. */
  async function hasNoCommits(repoId: string): Promise<boolean> {
    try {
      return (await client.request('repo/state', { repoId })).head.unborn;
    } catch {
      return false;
    }
  }

  /**
   * `rendered` unless the repository has no commits, in which case that is the
   * fact the caller needs: "nothing found" invites a retry, "no commits yet"
   * does not. Costs one request, and only when a result came back empty.
   */
  async function orEmptyRepository(
    repoId: string,
    repoPath: string,
    rendered: string,
    isEmpty: boolean,
  ): Promise<string> {
    if (!isEmpty || !(await hasNoCommits(repoId))) return rendered;
    return emptyRepositoryMessage(repoPath);
  }

  /**
   * An engine failure rewritten for the agent: the empty-repository case is
   * confirmed against repo/state where the repository is known, and the rest
   * goes through explainEngineError.
   */
  async function describeFailure(repoPath: string | undefined, error: unknown): Promise<Error> {
    if (error instanceof ToolError) return error;
    const message = error instanceof Error ? error.message : String(error);
    if (repoPath === undefined) return new ToolError(message);
    const repo = await discoveredRepo(repoPath);
    if (repo && (await hasNoCommits(repo.repoId))) {
      return new ToolError(emptyRepositoryMessage(repoPath));
    }
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
    if (!isWithinAllowedRoots(resolved, allowedRoots)) return false;
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
    repoId: string,
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
          const { contents } = await client.request('rev/fileAtRev', {
            repoId,
            path: file.path,
            rev,
          });
          return looksBinary(contents) ? file.path : undefined;
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
      // Every other tool caps its result. Without a cap a large file streamed
      // megabytes of text straight into the agent's context: a 200k-line file
      // produced ~6.7MB and over 100MB of heap.
      const limit = Math.min(args.limit ?? DEFAULT_BLAME_HUNKS, MAX_BLAME_HUNKS);
      const startLine = args.startLine ?? 1;
      // The engine streams hunks in blame order, not line order, so the lowest
      // `limit` lines are selected by ordered insertion: bounded memory, and a
      // page that really is the next one by line.
      const hunks: BlameHunk[] = [];
      let truncated = false;
      const sub = client.onNotification('blame/hunks', (params) => {
        if (params.streamId !== streamId) return;
        for (const hunk of params.hunks) {
          const lastLine = hunk.resultLine + hunk.lineCount - 1;
          // A single-line or paged request only needs the hunks it covers, so
          // the filter runs here instead of after collecting the whole stream.
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
        const result = await client.request('blame/file', {
          repoId: repo.repoId,
          path: args.file,
          streamId,
        });
        const binary = await isBinaryInWorkingTree(repo.rootPath, args.file);
        const rendered = formatBlame(args.file, hunks, result.commits, args.line, binary);
        if (!truncated) return rendered;
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
      cursor?: string;
      limit: number;
    }): Promise<string> {
      const repoId = await repoIdFor(args.repoPath);
      const hasQuery =
        args.text !== undefined || args.author !== undefined || args.sha !== undefined;
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
        return orEmptyRepository(repoId, args.repoPath, rendered, page.commits.length === 0);
      }
      if (args.cursor !== undefined) {
        throw new ToolError(
          'cursor only pages the unfiltered log; with text, author or sha, raise "limit" (max 500) or narrow the query',
        );
      }
      const streamId = randomUUID();
      const matches: CommitSummaryInfo[] = [];
      const sub = client.onNotification('search/matches', (params) => {
        if (params.streamId === streamId) matches.push(...params.matches);
      });
      try {
        const result = await client.request('search/commits', {
          repoId,
          streamId,
          limit: args.limit,
          query: { text: args.text, author: args.author, sha: args.sha },
        });
        const rendered = formatCommits(matches);
        // The engine caps `total` at `limit`, so the count of matches beyond
        // the limit is not available to report.
        if (result.truncated) {
          return `${rendered}\n\n(showing the first ${matches.length} matches; more exist — raise "limit" (max 500) or add author/sha filters)`;
        }
        return orEmptyRepository(repoId, args.repoPath, rendered, matches.length === 0);
      } finally {
        sub.dispose();
      }
    },

    async git_file_history(args: {
      repoPath: string;
      file: string;
      cursor?: string;
      limit: number;
    }): Promise<string> {
      const repoId = await repoIdFor(args.repoPath);
      const result = await client.request('history/file', {
        repoId,
        path: args.file,
        cursor: args.cursor,
        limit: args.limit,
      });
      const rendered =
        result.nextCursor === undefined
          ? formatHistory(args.file, result.entries)
          : `${formatHistory(args.file, result.entries)}\n\n(more commits: call again with cursor: ${JSON.stringify(result.nextCursor)})`;
      return orEmptyRepository(repoId, args.repoPath, rendered, result.entries.length === 0);
    },

    async git_commit_show(args: {
      repoPath: string;
      sha: string;
      includeDiff?: boolean;
      maxChars?: number;
    }): Promise<string> {
      const repoId = await repoIdFor(args.repoPath);
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
      let binaryPaths: ReadonlySet<string>;
      if (args.includeDiff) {
        const result = await client.request('patch/create', {
          repoId,
          source: { kind: 'commit', sha: commit.sha },
        });
        patch = result.envelope.patch;
        binaryPaths = binaryPathsInPatch(patch);
      } else {
        binaryPaths = await binaryPathsInCommit(repoId, commit.sha, diff.files);
      }
      const limit = resultChars(args.maxChars);
      return truncateText(
        formatCommitShow(commit, diff.files, { binaryPaths, diff: patch }),
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
      const repoId = await repoIdFor(args.repoPath);
      const result = await client.request('graph/rows', {
        repoId,
        cursor: args.cursor,
        limit: args.limit,
        include: { stashes: true, wip: true },
      });
      const rendered =
        result.nextCursor === undefined
          ? formatGraph(result.rows)
          : `${formatGraph(result.rows)}\n\n(more rows: call again with cursor: ${JSON.stringify(result.nextCursor)})`;
      return orEmptyRepository(repoId, args.repoPath, rendered, result.rows.length === 0);
    },

    async git_status(args: { repoPath: string; maxChars?: number }): Promise<string> {
      const repoId = await repoIdFor(args.repoPath);
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
      const status = await client.request('status/summary', { repoId: repo.repoId });
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
      // Files are fetched in batches until the character budget is spent, so a
      // repository with many large diffs is not read in full to render 20k of it.
      const entries: DiffFileEntry[] = [];
      let budget = limit;
      for (let start = 0; start < selected.length && budget > 0; start += DIFF_FETCH_BATCH) {
        const batch = await Promise.all(
          selected.slice(start, start + DIFF_FETCH_BATCH).map(async (file) => {
            const { hunks } = await client.request('diff/fileHunks', {
              repoId: repo.repoId,
              path: file.path,
              staged,
            });
            return {
              ...file,
              hunks,
              binary:
                hunks.length === 0 && (await isBinaryInWorkingTree(repo.rootPath, file.path)),
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
      const repoId = await repoIdFor(args.repoPath);
      const refs = await client.request('refs/list', { repoId });
      const limit = resultChars(args.maxChars);
      const empty =
        refs.branches.length === 0 && refs.tags.length === 0 && refs.remotes.length === 0;
      return orEmptyRepository(
        repoId,
        args.repoPath,
        truncateText(
          formatRefs(refs),
          limit,
          charLimitHint(limit, 'the repository has this many refs'),
        ),
        empty,
      );
    },

    async create_patch(args: {
      repoPath: string;
      source: string;
      maxChars?: number;
    }): Promise<string> {
      const source = parsePatchSource(args.source);
      const repoId = await repoIdFor(args.repoPath);
      const result = await client.request('patch/create', { repoId, source });
      const limit = resultChars(args.maxChars);
      return truncateText(
        formatPatchEnvelope(result.envelope),
        limit,
        `a truncated patch cannot be applied; ${charLimitHint(
          limit,
          "narrow the source to a single commit with 'commit:<sha>'",
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
      // The envelope is agent-supplied and was forwarded to the engine after a
      // single format check. The engine rejects a malformed one, but a local
      // schema check names the offending field instead of surfacing a round
      // trip's -32602.
      const envelopeError = patchEnvelopeError(envelope);
      if (envelopeError) {
        throw new ToolError(`envelopeJson is not a valid patch envelope: ${envelopeError}`);
      }
      const repoId = await repoIdFor(args.repoPath);
      const result = await client.request('patch/apply', { repoId, envelope });
      return [
        `applied: ${result.applied}`,
        `conflicts: ${result.conflicts}`,
        `base found: ${result.baseFound}`,
      ].join('\n');
    },

    // Takes no arguments: the provider is GitHub and the host comes from the
    // environment, so there is nothing for a caller to choose.
    async list_my_prs(_args?: Record<string, never>): Promise<string> {
      const token = env.GITHUB_TOKEN ?? env.GITGLASSES_GITHUB_TOKEN;
      if (!token) {
        throw new ToolError(
          'No GitHub token; set GITHUB_TOKEN or GITGLASSES_GITHUB_TOKEN in the server environment',
        );
      }
      // Deliberately not from args: see configuredGitHubHost.
      const host = configuredGitHubHost(env);
      const provider: HostingProvider = host
        ? createGitHubEnterpriseProvider(host, context.fetchFn)
        : new GitHubProvider({ fetchFn: context.fetchFn });
      const prs = await provider.getMyPullRequests({ token });
      const viewer = prs.find((pr) => pr.viewerRole === 'author')?.author.username ?? '';
      return formatLaunchpad(groupItems(prs, viewer));
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
        throw await describeFailure(args?.repoPath, error);
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
    'Absolute path to (or inside) the git repository. The server may be confined to ' +
      'GITGLASSES_ALLOWED_ROOTS; paths outside those directories are rejected.',
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

const cursor = z
  .string()
  .optional()
  .describe('Opaque cursor from a previous call\'s "(more ...)" footer; fetches the next page');

/** Tools that only read the repository and the hosting provider. */
const readOnly = { readOnlyHint: true } as const;

export function createServer(context: ToolContext): McpServer {
  const handlers = createToolHandlers(context);
  const server = new McpServer({ name: 'gitglasses', version: '0.1.0' });

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
        'Search commits by message text, author or sha; without filters, list recent commits newest first. ' +
        'Filters are combined with AND.',
      inputSchema: {
        repoPath,
        text: z
          .string()
          .optional()
          .describe('Case-insensitive substring of the commit message'),
        author: z
          .string()
          .optional()
          .describe('Case-insensitive substring of the author name or email'),
        sha: z.string().optional().describe('Commit sha, or a prefix of one'),
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
      description: 'Commit history of a file, following renames, newest first.',
      inputSchema: {
        repoPath,
        file: z.string().describe('File path relative to the repository root'),
        cursor,
        limit: z.number().int().min(1).max(500).default(20),
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
              'reported as differing rather than shown.',
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
        "Create a shareable gitglasses patch from 'wip', 'stash:<n>' or 'commit:<sha>': envelope metadata lines followed by the raw patch.",
      inputSchema: {
        repoPath,
        source: z.string().describe("Patch source: 'wip', 'stash:<n>' or 'commit:<sha>'"),
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
        'Apply a gitglasses patch to the repository, writing to the working tree.',
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
        'Open GitHub pull requests involving you, grouped into launchpad buckets (blocked, needs-your-review, ...). Takes no arguments: the token comes from GITHUB_TOKEN or GITGLASSES_GITHUB_TOKEN and the GitHub Enterprise host from GITGLASSES_GITHUB_HOST.',
      inputSchema: {},
      annotations: readOnly,
    },
    asToolResult(handlers.list_my_prs),
  );

  return server;
}
