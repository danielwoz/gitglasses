// The gitglasses MCP server: tool handlers over the engine client plus the
// hosting-provider integrations, and their registration on an McpServer.

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { BlameHunk, CommitSummaryInfo, PatchEnvelope } from '@gitglasses/protocol';
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
  formatBlame,
  formatCommitShow,
  formatCommits,
  formatGraph,
  formatHistory,
  formatLaunchpad,
  formatPatchEnvelope,
  formatStatus,
  parsePatchEnvelopeText,
  parsePatchSource,
  truncateText,
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

/** The character limit for one call, clamped to MAX_RESULT_CHARS. */
function resultChars(maxChars: number | undefined): number {
  return Math.min(maxChars ?? DEFAULT_RESULT_CHARS, MAX_RESULT_CHARS);
}

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
  const repoIds = new Map<string, Promise<string>>();
  const MAX_REPO_IDS = 64;

  const allowedRoots = parseAllowedRoots(env.GITGLASSES_ALLOWED_ROOTS);

  function repoIdFor(repoPath: string): Promise<string> {
    const key = canonicalPath(repoPath);
    if (!isWithinAllowedRoots(key, allowedRoots)) {
      throw new Error(
        `path is outside GITGLASSES_ALLOWED_ROOTS: ${key}. ` +
          'Set GITGLASSES_ALLOWED_ROOTS to the directories this server may read.',
      );
    }
    let repoId = repoIds.get(key);
    if (!repoId) {
      repoId = client.request('repo/discover', { path: key }).then((info) => info.repoId);
      repoId.catch(() => repoIds.delete(key));
      if (repoIds.size >= MAX_REPO_IDS) {
        const oldest = repoIds.keys().next().value;
        if (oldest !== undefined) repoIds.delete(oldest);
      }
      repoIds.set(key, repoId);
    }
    return repoId;
  }

  return {
    async git_blame(args: {
      repoPath: string;
      file: string;
      line?: number;
      limit?: number;
    }): Promise<string> {
      const repoId = await repoIdFor(args.repoPath);
      const streamId = randomUUID();
      // Every other tool caps its result. Without a cap a large file streamed
      // megabytes of text straight into the agent's context: a 200k-line file
      // produced ~6.7MB and over 100MB of heap.
      const limit = Math.min(args.limit ?? DEFAULT_BLAME_HUNKS, MAX_BLAME_HUNKS);
      const hunks: BlameHunk[] = [];
      let truncated = false;
      const sub = client.onNotification('blame/hunks', (params) => {
        if (params.streamId !== streamId) return;
        for (const hunk of params.hunks) {
          // A single-line request only needs the hunk covering that line, so
          // the filter runs here instead of after collecting the whole stream.
          if (
            args.line !== undefined &&
            !(args.line >= hunk.resultLine && args.line < hunk.resultLine + hunk.lineCount)
          ) {
            continue;
          }
          if (hunks.length >= limit) {
            truncated = true;
            return;
          }
          hunks.push(hunk);
        }
      });
      try {
        const result = await client.request('blame/file', {
          repoId,
          path: args.file,
          streamId,
        });
        const rendered = formatBlame(args.file, hunks, result.commits, args.line);
        return truncated
          ? `${rendered}\n\n(truncated to ${limit} hunks; pass a higher "limit" or a "line" to narrow)`
          : rendered;
      } finally {
        sub.dispose();
      }
    },

    async git_log_search(args: {
      repoPath: string;
      text?: string;
      author?: string;
      sha?: string;
      limit: number;
    }): Promise<string> {
      const repoId = await repoIdFor(args.repoPath);
      const hasQuery =
        args.text !== undefined || args.author !== undefined || args.sha !== undefined;
      if (!hasQuery) {
        const page = await client.request('log/commits', { repoId, limit: args.limit });
        return formatCommits(page.commits);
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
        return result.truncated ? `${rendered}\n(truncated at ${args.limit})` : rendered;
      } finally {
        sub.dispose();
      }
    },

    async git_file_history(args: {
      repoPath: string;
      file: string;
      limit: number;
    }): Promise<string> {
      const repoId = await repoIdFor(args.repoPath);
      const result = await client.request('history/file', {
        repoId,
        path: args.file,
        limit: args.limit,
      });
      return formatHistory(args.file, result.entries);
    },

    async git_commit_show(args: {
      repoPath: string;
      sha: string;
      maxChars?: number;
    }): Promise<string> {
      const repoId = await repoIdFor(args.repoPath);
      const [page, diff] = await Promise.all([
        client.request('log/commits', { repoId, ref: args.sha, limit: 1 }),
        client.request('diff/commit', { repoId, sha: args.sha }),
      ]);
      const commit = page.commits[0];
      if (!commit) throw new Error(`Commit ${args.sha} not found`);
      return truncateText(
        formatCommitShow(commit, diff.files),
        resultChars(args.maxChars),
        'a commit touching this many files; pass a higher "maxChars"',
      );
    },

    async git_graph_summary(args: { repoPath: string; limit: number }): Promise<string> {
      const repoId = await repoIdFor(args.repoPath);
      const result = await client.request('graph/rows', {
        repoId,
        limit: args.limit,
        include: { stashes: true, wip: true },
      });
      return formatGraph(result.rows);
    },

    async git_status(args: { repoPath: string; maxChars?: number }): Promise<string> {
      const repoId = await repoIdFor(args.repoPath);
      const status = await client.request('status/summary', { repoId });
      return truncateText(
        formatStatus(status),
        resultChars(args.maxChars),
        'pass a higher "maxChars"',
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
      return truncateText(
        formatPatchEnvelope(result.envelope),
        resultChars(args.maxChars),
        'a truncated patch cannot be applied; pass a higher "maxChars"',
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
          throw new Error('envelopeJson is not valid JSON');
        }
      } else {
        try {
          envelope = parsePatchEnvelopeText(args.envelopeJson);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          throw new Error(`envelopeJson is not create_patch output: ${message}`);
        }
      }
      // The envelope is agent-supplied and was forwarded to the engine after a
      // single format check. The engine rejects a malformed one, but a local
      // schema check names the offending field instead of surfacing a round
      // trip's -32602.
      const envelopeError = patchEnvelopeError(envelope);
      if (envelopeError) {
        throw new Error(`envelopeJson is not a valid patch envelope: ${envelopeError}`);
      }
      const repoId = await repoIdFor(args.repoPath);
      const result = await client.request('patch/apply', { repoId, envelope });
      return [
        `applied: ${result.applied}`,
        `conflicts: ${result.conflicts}`,
        `base found: ${result.baseFound}`,
      ].join('\n');
    },

    async list_my_prs(_args: { provider: 'github' }): Promise<string> {
      const token = env.GITHUB_TOKEN ?? env.GITGLASSES_GITHUB_TOKEN;
      if (!token) {
        throw new Error('No GitHub token; set GITHUB_TOKEN or GITGLASSES_GITHUB_TOKEN');
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

const repoPath = z.string().describe('Absolute path to (or inside) the git repository');

const maxChars = z
  .number()
  .int()
  .min(1)
  .max(MAX_RESULT_CHARS)
  .optional()
  .describe(
    `Maximum characters to return before truncation (default ${DEFAULT_RESULT_CHARS}, max ${MAX_RESULT_CHARS})`,
  );

/** Tools that only read the repository and the hosting provider. */
const readOnly = { readOnlyHint: true } as const;

export function createServer(context: ToolContext): McpServer {
  const handlers = createToolHandlers(context);
  const server = new McpServer({ name: 'gitglasses', version: '0.1.0' });

  server.registerTool(
    'git_blame',
    {
      description:
        'Blame a file (or a single line): per-hunk author, date, sha and commit summary.',
      inputSchema: {
        repoPath,
        file: z.string().describe('File path relative to the repository root'),
        line: z.number().int().min(1).optional().describe('1-based line to blame'),
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
      description: 'Search commits by message text, author or sha; without filters, list recent commits.',
      inputSchema: {
        repoPath,
        text: z.string().optional().describe('Substring to match in commit messages'),
        author: z.string().optional().describe('Author name/email filter'),
        sha: z.string().optional().describe('Commit sha (prefix) filter'),
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
        limit: z.number().int().min(1).max(500).default(20),
      },
      annotations: readOnly,
    },
    asToolResult(handlers.git_file_history),
  );

  server.registerTool(
    'git_commit_show',
    {
      description: 'Commit metadata plus changed files with addition/deletion counts.',
      inputSchema: {
        repoPath,
        sha: z.string().describe('Commit sha (or unique prefix)'),
        maxChars,
      },
      annotations: readOnly,
    },
    asToolResult(handlers.git_commit_show),
  );

  server.registerTool(
    'git_graph_summary',
    {
      description: 'Text rendering of the commit graph: lane-indented sha, summary and refs.',
      inputSchema: { repoPath, limit: z.number().int().min(1).max(500).default(30) },
      annotations: readOnly,
    },
    asToolResult(handlers.git_graph_summary),
  );

  server.registerTool(
    'git_status',
    {
      description: 'Branch, ahead/behind, staged, unstaged, untracked and conflicted files.',
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
        'Open pull requests involving you, grouped into launchpad buckets (blocked, needs-your-review, ...). Token from GITHUB_TOKEN or GITGLASSES_GITHUB_TOKEN; GitHub Enterprise host from GITGLASSES_GITHUB_HOST.',
      inputSchema: {
        provider: z.literal('github'),
      },
      annotations: readOnly,
    },
    asToolResult(handlers.list_my_prs),
  );

  return server;
}
