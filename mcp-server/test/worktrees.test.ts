// git_worktrees: the formatter, the bounded status collection, and the tool
// against the real engine, trusted and restricted.

import { execFileSync } from 'node:child_process';
import { appendFile, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { WorktreeEntry, WorktreeStatus } from '@gitglasses/protocol';
import type { EngineClient } from '@gitglasses/rpc';
import { createEngineClient, resolveEnginePath } from '../src/engine.js';
import { createToolHandlers, type ToolHandlers } from '../src/server.js';
import {
  MAX_WORKTREE_STATUSES,
  collectWorktrees,
  formatWorktrees,
  type WorktreeReport,
} from '../src/tools/worktrees.js';

const SHA = '1234567890abcdef1234567890abcdef12345678';

function entry(overrides: Partial<WorktreeEntry> = {}): WorktreeEntry {
  return {
    path: '/repos/app',
    branch: 'main',
    sha: SHA,
    bare: false,
    locked: false,
    prunable: false,
    missing: false,
    current: false,
    ...overrides,
  };
}

function base(overrides: Partial<NonNullable<WorktreeStatus['base']>> = {}) {
  return {
    ref: 'main',
    sha: SHA,
    ahead: 0,
    behind: 0,
    mergesCleanly: true as boolean | null,
    ...overrides,
  };
}

describe('formatWorktrees', () => {
  it('reports each worktree with its status', () => {
    const reports: WorktreeReport[] = [
      {
        entry: entry({ current: true }),
        status: { path: '/repos/app', dirty: 0, base: base(), lastActivity: 1_800_000_000 },
      },
      {
        entry: entry({ path: '/repos/app/.claude/worktrees/auth', branch: 'worktree-auth' }),
        status: {
          path: '/repos/app/.claude/worktrees/auth',
          dirty: 3,
          base: base({ ahead: 2, behind: 1 }),
          upstream: { ref: 'origin/worktree-auth', ahead: 1, behind: 0 },
          agent: { name: 'Claude Code', evidence: 'path' },
        },
      },
      {
        entry: entry({ path: '/repos/app-fix', branch: 'fix' }),
        status: {
          path: '/repos/app-fix',
          dirty: 0,
          base: base({ ahead: 1, behind: 1, mergesCleanly: false, conflicts: ['a.ts', 'b.ts'] }),
        },
      },
    ];
    expect(formatWorktrees(reports)).toBe(
      [
        '3 worktrees, compared with main:',
        '/repos/app',
        '  branch: main at 1234567',
        '  the repository this call named',
        '  uncommitted paths: 0',
        '  is the base (main)',
        '  last activity: 2027-01-15T08:00:00Z',
        '/repos/app/.claude/worktrees/auth',
        '  branch: worktree-auth at 1234567',
        '  agent: "Claude Code" (from its worktree location)',
        '  uncommitted paths: 3',
        '  vs main: 2 ahead, 1 behind; merges cleanly',
        '  upstream origin/worktree-auth: 1 ahead, 0 behind',
        '/repos/app-fix',
        '  branch: fix at 1234567',
        '  uncommitted paths: 0',
        '  vs main: 1 ahead, 1 behind; conflicts in a.ts, b.ts',
      ].join('\n'),
    );
  });

  it('says why a merge was not checked and what could not be read', () => {
    const text = formatWorktrees([
      {
        entry: entry({ path: '/repos/app-x', branch: 'x' }),
        status: {
          path: '/repos/app-x',
          dirty: 1,
          base: base({ ahead: 1, behind: 2, mergesCleanly: null, mergeSkipped: 'restricted' }),
        },
      },
      { entry: entry({ path: '/repos/app-y', branch: undefined }), error: 'boom' },
      { entry: entry({ path: '/repos/gone', branch: 'gone', prunable: true, missing: true }) },
      { entry: entry({ path: '/repos/unlinked', branch: 'unlinked', prunable: true }) },
    ]);
    expect(text).toContain('vs main: 1 ahead, 2 behind; not checked: this repository is served');
    expect(text).toContain('detached HEAD at 1234567');
    expect(text).toContain('status unavailable: boom');
    expect(text).toContain('directory missing (git worktree prune would remove it)');
    expect(text).toContain('no longer a worktree: its .git file is gone');
  });

  it('quotes agent names, which come from commit trailers', () => {
    const text = formatWorktrees([
      {
        entry: entry({ path: '/repos/app-z', branch: 'z' }),
        status: { path: '/repos/app-z', agent: { name: 'Kiro', evidence: 'trailer' } },
      },
    ]);
    expect(text).toContain('agent: "Kiro" (from its commit trailer)');
  });

  it('says when there is nothing to list', () => {
    expect(formatWorktrees([])).toBe('No worktrees.');
  });
});

/** An engine double answering worktree/list and worktree/status. */
function fakeEngine(count: number, failing = new Set<string>()) {
  let inFlight = 0;
  let peak = 0;
  const asked: string[] = [];
  const client = {
    async request(method: string, params: { path?: string; base?: string }) {
      if (method === 'worktree/list') {
        return {
          worktrees: Array.from({ length: count }, (_, i) =>
            entry({ path: `/wt/${i}`, branch: `b${i}`, prunable: i === 1, missing: i === 1 }),
          ),
        };
      }
      asked.push(params.path!);
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      if (params.base === 'nope') {
        throw Object.assign(new Error("base 'nope' names no commit"), { code: -32602 });
      }
      if (failing.has(params.path!)) throw new Error('no worktree there');
      return { path: params.path, dirty: 0 };
    },
  };
  return { client: client as unknown as EngineClient, asked, peak: () => peak };
}

describe('collectWorktrees', () => {
  it('reads statuses a few at a time and only for the first worktrees', async () => {
    const engine = fakeEngine(MAX_WORKTREE_STATUSES + 5);
    const reports = await collectWorktrees({ client: engine.client, repoId: 'r1' }, undefined);
    expect(reports).toHaveLength(MAX_WORKTREE_STATUSES + 5);
    // The missing directory (index 1) is not asked about.
    expect(engine.asked).toHaveLength(MAX_WORKTREE_STATUSES - 1);
    expect(engine.peak()).toBeLessThanOrEqual(4);
    expect(reports[MAX_WORKTREE_STATUSES].status).toBeUndefined();
    expect(formatWorktrees(reports)).toContain(
      `(status read for the first ${MAX_WORKTREE_STATUSES} worktrees only)`,
    );
  });

  it('reports a failed status on its worktree', async () => {
    const engine = fakeEngine(3, new Set(['/wt/2']));
    const reports = await collectWorktrees({ client: engine.client, repoId: 'r1' }, undefined);
    expect(reports[2].error).toBe('no worktree there');
    expect(reports[0].status).toBeDefined();
  });

  it('leaves worktrees outside the served directories unread', async () => {
    const engine = fakeEngine(3);
    const reports = await collectWorktrees(
      { client: engine.client, repoId: 'r1' },
      undefined,
      async (worktreePath) => worktreePath !== '/wt/2',
    );
    expect(engine.asked).toEqual(['/wt/0']);
    expect(reports[2].outside).toBe(true);
    expect(formatWorktrees(reports)).toContain(
      'status not read: outside the directories this server serves',
    );
  });

  it('reads no status for a locked worktree whose directory is gone', async () => {
    const asked: string[] = [];
    const client = {
      async request(method: string, params: { path?: string }) {
        if (method === 'worktree/list') {
          return {
            worktrees: [
              entry({ path: '/wt/0' }),
              entry({ path: '/media/usb/review', branch: 'review', locked: true, missing: true }),
            ],
          };
        }
        asked.push(params.path!);
        return { path: params.path, dirty: 0 };
      },
    };
    const reports = await collectWorktrees(
      { client: client as unknown as EngineClient, repoId: 'r1' },
      undefined,
    );
    expect(asked).toEqual(['/wt/0']);
    const text = formatWorktrees(reports);
    expect(text).toContain('locked; directory missing (locked, so git worktree prune keeps it)');
    expect(text).not.toContain('would remove it');
    expect(text).not.toContain('status not read');
  });

  it('fails the call for a base that names nothing', async () => {
    const engine = fakeEngine(3);
    await expect(collectWorktrees({ client: engine.client, repoId: 'r1' }, 'nope')).rejects.toThrow(
      "base 'nope' names no commit",
    );
  });
});

const enginePath = resolveEnginePath({ packageRoot: path.resolve(import.meta.dirname, '..') });

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

describe.skipIf(!enginePath)('git_worktrees against the engine', () => {
  let parent: string;
  let repoDir: string;
  let full: EngineClient;
  let restricted: EngineClient;
  let trusted: ToolHandlers;
  let untrusted: ToolHandlers;

  beforeAll(async () => {
    parent = await mkdtemp(path.join(os.tmpdir(), 'gitglasses-mcp-worktrees-'));
    repoDir = path.join(parent, 'app');
    git(parent, 'init', '-q', '-b', 'main', 'app');
    git(repoDir, 'config', 'user.name', 'Test Author');
    git(repoDir, 'config', 'user.email', 'test@example.com');
    git(repoDir, 'config', 'core.autocrlf', 'false');
    await writeFile(path.join(repoDir, 'shared.txt'), 'one\n');
    git(repoDir, 'add', '.');
    git(repoDir, 'commit', '-q', '-m', 'Initial commit');

    // An agent's worktree with a committed change and uncommitted work, and
    // a second whose change conflicts with main.
    const agent = path.join(repoDir, '.claude', 'worktrees', 'auth');
    git(repoDir, 'worktree', 'add', '-q', '-b', 'worktree-auth', agent, 'main');
    await writeFile(path.join(agent, 'auth.txt'), 'auth\n');
    git(agent, 'add', 'auth.txt');
    git(agent, 'commit', '-q', '-m', 'Add auth');
    await writeFile(path.join(agent, 'wip.txt'), 'wip\n');

    const fix = path.join(parent, 'app-fix');
    git(repoDir, 'worktree', 'add', '-q', '-b', 'fix', fix, 'main');
    await writeFile(path.join(fix, 'shared.txt'), 'fix\n');
    git(fix, 'commit', '-q', '-am', 'Fix shared');

    await writeFile(path.join(repoDir, 'shared.txt'), 'main\n');
    git(repoDir, 'commit', '-q', '-am', 'Main moves on');

    full = createEngineClient({ enginePath });
    restricted = createEngineClient({ enginePath, restricted: true });
    trusted = createToolHandlers({ client: full, allow: [parent], env: {} });
    untrusted = createToolHandlers({
      client: full,
      restrictedClient: restricted,
      clientRoots: async () => [parent],
      env: {},
    });
  }, 30000);

  afterAll(async () => {
    full?.dispose();
    restricted?.dispose();
    if (parent) await rm(parent, { recursive: true, force: true });
  });

  it('reports each worktree, its agent and whether it merges cleanly', async () => {
    const text = await trusted.git_worktrees({ repoPath: repoDir });
    expect(text).toContain('3 worktrees, compared with main:');
    expect(text).toMatch(/\.claude\/worktrees\/auth\n {2}branch: worktree-auth/);
    expect(text).toContain('agent: "Claude Code" (from its worktree location)');
    expect(text).toContain('uncommitted paths: 1');
    expect(text).toContain('vs main: 1 ahead, 1 behind; merges cleanly');
    expect(text).toContain('vs main: 1 ahead, 1 behind; conflicts in shared.txt');
    expect(text).toContain('is the base (main)');
  });

  it('compares with a chosen base', async () => {
    const text = await trusted.git_worktrees({ repoPath: repoDir, base: 'fix' });
    expect(text).toContain('compared with fix:');
    expect(text).toContain('is the base (fix)');
    await expect(
      trusted.git_worktrees({ repoPath: repoDir, base: 'no-such-branch' }),
    ).rejects.toThrow(/no-such-branch/);
  });

  it('reads only worktrees inside the directories it serves', async () => {
    const narrow = createToolHandlers({ client: full, allow: [repoDir], env: {} });
    const text = await narrow.git_worktrees({ repoPath: repoDir });
    expect(text).toMatch(
      /app-fix\n {2}branch: fix at [0-9a-f]{7}\n {2}status not read: outside the directories/,
    );
    expect(text).toContain('agent: "Claude Code"');
  });

  it('bounds its output', async () => {
    const text = await trusted.git_worktrees({ repoPath: repoDir, maxChars: 120 });
    expect(text).toMatch(/\(truncated to 120 characters; /);
  });

  it('reads an untrusted repository without running git, leaving the merge unchecked', async () => {
    const text = await untrusted.git_worktrees({ repoPath: repoDir });
    expect(text).toContain('agent: "Claude Code"');
    expect(text).toContain('uncommitted paths: 1');
    expect(text).toContain(
      'vs main: 1 ahead, 1 behind; not checked: this repository is served without running git',
    );
  });
});

// The restricted engine reads worktrees without running anything the
// repository names (core.fsmonitor here).
describe.skipIf(!enginePath || process.platform === 'win32')(
  'git_worktrees in an untrusted repository',
  () => {
    let parent: string;
    let markers: string;
    let restricted: EngineClient;
    let full: EngineClient;
    let handlers: ToolHandlers;

    beforeAll(async () => {
      parent = await mkdtemp(path.join(os.tmpdir(), 'gitglasses-mcp-wt-planted-'));
      markers = await mkdtemp(path.join(os.tmpdir(), 'gitglasses-mcp-wt-markers-'));
      const repoDir = path.join(parent, 'app');
      git(parent, 'init', '-q', '-b', 'main', 'app');
      git(repoDir, 'config', 'user.name', 'Test Author');
      git(repoDir, 'config', 'user.email', 'test@example.com');
      await writeFile(path.join(repoDir, 'a.txt'), 'a\n');
      git(repoDir, 'add', '.');
      git(repoDir, 'commit', '-q', '-m', 'Initial commit');
      git(repoDir, 'worktree', 'add', '-q', '-b', 'side', path.join(parent, 'side'), 'main');
      await appendFile(
        path.join(repoDir, '.git', 'config'),
        `[core]\n\tfsmonitor = "touch ${markers}/fsmonitor; false #"\n`,
      );
      full = createEngineClient({ enginePath });
      restricted = createEngineClient({ enginePath, restricted: true });
      handlers = createToolHandlers({
        client: full,
        restrictedClient: restricted,
        clientRoots: async () => [parent],
        env: {},
      });
    }, 30000);

    afterAll(async () => {
      full?.dispose();
      restricted?.dispose();
      for (const dir of [parent, markers]) if (dir) await rm(dir, { recursive: true, force: true });
    });

    it('runs nothing the repository configures', async () => {
      const text = await handlers.git_worktrees({ repoPath: path.join(parent, 'app') });
      expect(text).toContain('2 worktrees');
      expect(await readdir(markers)).toEqual([]);
    });
  },
);
