// The gitglasses MCP server: tool handlers over the engine client plus the
// hosting-provider integrations, and their registration on an McpServer.

import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { BlameHunk, CommitSummaryInfo, PatchEnvelope } from '@gitglasses/protocol';
import {
  GitHubProvider,
  createGitHubEnterpriseProvider,
  groupItems,
  type FetchLike,
  type HostingProvider,
} from '@gitglasses/integrations';
import type { EngineClient } from './engine.js';
import {
  formatBlame,
  formatCommitShow,
  formatCommits,
  formatGraph,
  formatHistory,
  formatLaunchpad,
  formatStatus,
  parsePatchSource,
} from './format.js';

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
  const repoIds = new Map<string, Promise<string>>();

  function repoIdFor(repoPath: string): Promise<string> {
    const key = path.resolve(repoPath);
    let repoId = repoIds.get(key);
    if (!repoId) {
      repoId = client.request('repo/discover', { path: key }).then((info) => info.repoId);
      repoId.catch(() => repoIds.delete(key));
      repoIds.set(key, repoId);
    }
    return repoId;
  }

  return {
    async git_blame(args: { repoPath: string; file: string; line?: number }): Promise<string> {
      const repoId = await repoIdFor(args.repoPath);
      const streamId = randomUUID();
      const hunks: BlameHunk[] = [];
      const sub = client.onNotification('blame/hunks', (params) => {
        if (params.streamId === streamId) hunks.push(...params.hunks);
      });
      try {
        const result = await client.request('blame/file', {
          repoId,
          path: args.file,
          streamId,
        });
        return formatBlame(args.file, hunks, result.commits, args.line);
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

    async git_commit_show(args: { repoPath: string; sha: string }): Promise<string> {
      const repoId = await repoIdFor(args.repoPath);
      const [page, diff] = await Promise.all([
        client.request('log/commits', { repoId, ref: args.sha, limit: 1 }),
        client.request('diff/commit', { repoId, sha: args.sha }),
      ]);
      const commit = page.commits[0];
      if (!commit) throw new Error(`Commit ${args.sha} not found`);
      return formatCommitShow(commit, diff.files);
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

    async git_status(args: { repoPath: string }): Promise<string> {
      const repoId = await repoIdFor(args.repoPath);
      const status = await client.request('status/summary', { repoId });
      return formatStatus(status);
    },

    async create_patch(args: { repoPath: string; source: string }): Promise<string> {
      const source = parsePatchSource(args.source);
      const repoId = await repoIdFor(args.repoPath);
      const result = await client.request('patch/create', { repoId, source });
      return JSON.stringify(result.envelope, null, 2);
    },

    async apply_patch(args: { repoPath: string; envelopeJson: string }): Promise<string> {
      let envelope: PatchEnvelope;
      try {
        envelope = JSON.parse(args.envelopeJson) as PatchEnvelope;
      } catch {
        throw new Error('envelopeJson is not valid JSON');
      }
      if (envelope?.format !== 'gitglasses-patch') {
        throw new Error('envelopeJson is not a gitglasses-patch envelope');
      }
      const repoId = await repoIdFor(args.repoPath);
      const result = await client.request('patch/apply', { repoId, envelope });
      return [
        `applied: ${result.applied}`,
        `conflicts: ${result.conflicts}`,
        `base found: ${result.baseFound}`,
      ].join('\n');
    },

    async list_my_prs(args: { provider: 'github'; host?: string }): Promise<string> {
      const token = env.GITHUB_TOKEN ?? env.GITGLASSES_GITHUB_TOKEN;
      if (!token) {
        throw new Error('No GitHub token; set GITHUB_TOKEN or GITGLASSES_GITHUB_TOKEN');
      }
      const provider: HostingProvider =
        args.host !== undefined && args.host !== 'github.com'
          ? createGitHubEnterpriseProvider(args.host, context.fetchFn)
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
      },
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
    },
    asToolResult(handlers.git_file_history),
  );

  server.registerTool(
    'git_commit_show',
    {
      description: 'Commit metadata plus changed files with addition/deletion counts.',
      inputSchema: { repoPath, sha: z.string().describe('Commit sha (or unique prefix)') },
    },
    asToolResult(handlers.git_commit_show),
  );

  server.registerTool(
    'git_graph_summary',
    {
      description: 'Text rendering of the commit graph: lane-indented sha, summary and refs.',
      inputSchema: { repoPath, limit: z.number().int().min(1).max(500).default(30) },
    },
    asToolResult(handlers.git_graph_summary),
  );

  server.registerTool(
    'git_status',
    {
      description: 'Branch, ahead/behind, staged, unstaged, untracked and conflicted files.',
      inputSchema: { repoPath },
    },
    asToolResult(handlers.git_status),
  );

  server.registerTool(
    'create_patch',
    {
      description:
        "Create a shareable gitglasses patch envelope (JSON) from 'wip', 'stash:<n>' or 'commit:<sha>'.",
      inputSchema: {
        repoPath,
        source: z.string().describe("Patch source: 'wip', 'stash:<n>' or 'commit:<sha>'"),
      },
    },
    asToolResult(handlers.create_patch),
  );

  server.registerTool(
    'apply_patch',
    {
      description: 'Apply a gitglasses patch envelope (JSON string) to the repository.',
      inputSchema: {
        repoPath,
        envelopeJson: z.string().describe('Patch envelope JSON produced by create_patch'),
      },
    },
    asToolResult(handlers.apply_patch),
  );

  server.registerTool(
    'list_my_prs',
    {
      description:
        'Open pull requests involving you, grouped into launchpad buckets (blocked, needs-your-review, ...). Token from GITHUB_TOKEN or GITGLASSES_GITHUB_TOKEN.',
      inputSchema: {
        provider: z.literal('github'),
        host: z.string().optional().describe('GitHub Enterprise host; defaults to github.com'),
      },
    },
    asToolResult(handlers.list_my_prs),
  );

  return server;
}
