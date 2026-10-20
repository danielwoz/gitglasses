// The Worktrees view's rows and actions against a scripted engine: rows that
// fill in as statuses load, Remove Worktree and Branch with its one (or, for
// uncommitted work, two) confirmations, Compare with Base, and the chosen
// base reaching every status request.

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', async () => {
  const fake = await import('./support/fakeVscodeUi');
  return {
    ...fake,
    Uri: {
      ...fake.Uri,
      from: (parts: { scheme: string; path: string; query?: string }) => ({
        ...parts,
        fsPath: parts.path,
        toString: () => `${parts.scheme}:${parts.path}?${parts.query ?? ''}`,
      }),
    },
    QuickPickItemKind: { Separator: -1, Default: 0 },
  };
});

import type { WorktreeEntry, WorktreeStatus } from '@gitglasses/protocol';
import { ui } from './support/fakeVscodeUi';
import { WorktreesViewProvider, registerWorktreeCommands } from '../src/views/worktreesView';
import { setActiveRepoResolver } from '../src/views/viewBase';

const SHA = '1'.repeat(40);
const BASE_SHA = '2'.repeat(40);
const MERGE_BASE = '3'.repeat(40);

const REPO = { repoId: 'r1', rootPath: '/repos/app' };

const MAIN: WorktreeEntry = {
  path: '/repos/app',
  branch: 'main',
  sha: BASE_SHA,
  bare: false,
  locked: false,
  prunable: false,
  missing: false,
  current: true,
};

const AGENT: WorktreeEntry = {
  path: '/repos/app/.claude/worktrees/auth',
  branch: 'worktree-auth',
  sha: SHA,
  bare: false,
  locked: false,
  prunable: false,
  missing: false,
  current: false,
};

interface Request {
  method: string;
  params: Record<string, unknown>;
}

function agentStatus(overrides: Partial<WorktreeStatus> = {}): WorktreeStatus {
  return {
    path: AGENT.path,
    dirty: 0,
    base: {
      ref: 'main',
      sha: BASE_SHA,
      ahead: 2,
      behind: 1,
      mergeBase: MERGE_BASE,
      mergesCleanly: true,
    },
    agent: { name: 'Claude Code', evidence: 'path' },
    ...overrides,
  };
}

/** A locked worktree whose directory is gone: git keeps its entry. */
const UNMOUNTED: WorktreeEntry = {
  path: '/media/usb/app-review',
  branch: 'review',
  sha: SHA,
  bare: false,
  locked: true,
  prunable: false,
  missing: true,
  current: false,
};

function harness(
  status: WorktreeStatus = agentStatus(),
  worktrees: WorktreeEntry[] = [MAIN, AGENT],
  wip = { staged: [], unstaged: [], untracked: [] as string[] },
) {
  const requests: Request[] = [];
  const answers: Record<string, (params: Record<string, unknown>) => unknown> = {
    'worktree/list': () => ({ worktrees }),
    'status/summary': () => wip,
    'worktree/status': (params) =>
      params.path === AGENT.path
        ? status
        : { path: MAIN.path, dirty: 0, base: { ...status.base!, ahead: 0, behind: 0 } },
    'worktree/remove': () => ({}),
    'mutate/branchDelete': () => ({}),
    'diff/refs': () => ({
      files: [{ path: 'src/session.ts', status: 'A', additions: 1, deletions: 0 }],
    }),
    'refs/list': () => ({
      branches: [
        { name: 'main', sha: BASE_SHA, current: true },
        { name: 'develop', sha: BASE_SHA, current: false },
      ],
      remotes: [{ name: 'origin', branches: [{ name: 'main', sha: BASE_SHA }] }],
      tags: [],
    }),
  };
  const engine = {
    capabilities: () => ({ gitCli: true, watch: true, threads: true }),
    onNotification: () => ({ dispose: () => undefined }),
    onDidChangeCapabilities: () => ({ dispose: () => undefined }),
    async request(method: string, params: Record<string, unknown>) {
      requests.push({ method, params });
      const answer = answers[method];
      if (!answer) throw new Error(`unexpected ${method}`);
      return answer(params);
    },
  };
  const stored = new Map<string, unknown>();
  const state = {
    get: <T>(key: string) => stored.get(key) as T | undefined,
    update: async (key: string, value: unknown) => {
      stored.set(key, value);
    },
    keys: () => [...stored.keys()],
  };
  const repos = { locateOrDiscover: async () => ({ repoId: 'r2', rootPath: AGENT.path }) };
  const view = new WorktreesViewProvider(engine as never, repos as never, state as never);
  const log = vi.fn();
  registerWorktreeCommands(engine as never, repos as never, view, log);
  const run = (command: string, ...args: unknown[]) => ui.commands.get(command)!(...args);
  const node = (entry: WorktreeEntry) => ({
    item: {},
    worktree: entry,
    worktreePath: entry.path,
    repo: REPO,
  });
  const sent = (method: string) => requests.filter((request) => request.method === method);
  const render = () =>
    (
      view as unknown as {
        getRootNodes(
          r: unknown,
        ): Promise<{ item: { label: string; description: string; contextValue: string } }[]>;
      }
    ).getRootNodes(REPO);
  return { view, run, node, sent, requests, log, render };
}

beforeEach(() => {
  ui.reset();
  setActiveRepoResolver(async () => REPO);
});

describe('worktree rows', () => {
  it('fill in each row once its status loads', async () => {
    const { view, sent } = harness();
    const rendered = (
      view as unknown as {
        getRootNodes(r: unknown): Promise<{ item: { label: string; description: string } }[]>;
      }
    ).getRootNodes(REPO);
    const rows = await rendered;
    expect(rows.map((row) => [row.item.label, row.item.description])).toEqual([
      ['main', 'current'],
      ['worktree-auth', ''],
    ]);
    await vi.waitFor(() =>
      expect(rows[1].item.description).toBe('↑2 ↓1 · merges cleanly · Claude Code'),
    );
    expect(rows[0].item.description).toBe('current · base');
    expect(sent('worktree/status')).toHaveLength(2);
  });

  it('read no status for a worktree whose directory is missing', async () => {
    const { render, sent } = harness(agentStatus(), [MAIN, AGENT, UNMOUNTED]);
    const rows = await render();
    await vi.waitFor(() => expect(sent('worktree/status')).toHaveLength(2));
    expect(sent('worktree/status').map((request) => request.params.path)).not.toContain(
      UNMOUNTED.path,
    );
    expect(rows[2].item.description).toBe('missing · locked');
    expect(rows[2].item.contextValue).toBe('gitglassesMissingWorktree');
  });
});

describe('Remove Worktree and Branch', () => {
  it('removes the worktree and its branch after one confirmation', async () => {
    const { run, node, requests } = harness();
    ui.messageChoices = ['Proceed'];
    await run('gitglasses.worktrees.removeWithBranch', node(AGENT));
    expect(ui.messages).toHaveLength(1);
    expect(ui.messages[0].text).toBe("Remove worktree 'auth' and delete branch 'worktree-auth'?");
    expect(requests.map((request) => request.method)).toEqual([
      'worktree/status',
      'worktree/remove',
      'mutate/branchDelete',
    ]);
    expect(requests[1].params).toEqual({ repoId: 'r1', path: AGENT.path, force: false });
    expect(requests[2].params).toEqual({ repoId: 'r1', name: 'worktree-auth', force: true });
  });

  it('changes nothing when the confirmation is dismissed', async () => {
    const { run, node, requests } = harness();
    ui.messageChoices = [undefined];
    await run('gitglasses.worktrees.removeWithBranch', node(AGENT));
    expect(requests.map((request) => request.method)).toEqual(['worktree/status']);
  });

  it('asks again before discarding uncommitted work, and forces only then', async () => {
    const dirty = harness(agentStatus({ dirty: 3 }));
    ui.messageChoices = ['Proceed', undefined];
    await dirty.run('gitglasses.worktrees.removeWithBranch', dirty.node(AGENT));
    expect(ui.messages.map((message) => message.text)).toEqual([
      "Remove worktree 'auth' and delete branch 'worktree-auth'?",
      "Discard 3 uncommitted changes in 'auth'?",
    ]);
    expect(dirty.sent('worktree/remove')).toEqual([]);

    ui.reset();
    const agreed = harness(agentStatus({ dirty: 3 }));
    ui.messageChoices = ['Proceed', 'Proceed'];
    await agreed.run('gitglasses.worktrees.removeWithBranch', agreed.node(AGENT));
    expect(agreed.sent('worktree/remove')[0].params.force).toBe(true);
    expect(agreed.sent('mutate/branchDelete')).toHaveLength(1);
  });

  it('never offers to remove the current worktree', async () => {
    const { run, node, requests } = harness();
    await run('gitglasses.worktrees.removeWithBranch', node(MAIN));
    expect(requests).toEqual([]);
    expect(ui.messages).toEqual([]);
  });
});

describe('Compare with Base', () => {
  it('opens the commits since the merge base in one multi-file diff', async () => {
    const { run, node, sent } = harness();
    await run('gitglasses.worktrees.compareWithBase', node(AGENT));
    expect(sent('diff/refs')[0].params).toEqual({ repoId: 'r1', base: MERGE_BASE, head: SHA });
    const changes = ui.executed.find((call) => call.command === 'vscode.changes');
    expect(changes?.args[0]).toBe('main ↔ worktree-auth');
    const [resources] = changes!.args.slice(1) as [unknown[][]];
    expect(resources).toHaveLength(1);
    // An added file has no left side.
    expect(resources[0][1]).toBeUndefined();
  });

  it('gives files new in the working tree no side at the base', async () => {
    const { run, node, sent } = harness(agentStatus({ dirty: 2 }), [MAIN, AGENT], {
      staged: [],
      unstaged: [{ path: 'README.md', status: 'M' }],
      untracked: ['notes.txt'],
    } as never);
    const compared = (await run('gitglasses.worktrees.compareWithBase', node(AGENT))) as [
      { path: string },
      { path: string } | undefined,
      { path: string } | undefined,
    ][];
    expect(sent('status/summary')[0].params).toEqual({ repoId: 'r2' });
    const changes = ui.executed.find((call) => call.command === 'vscode.changes');
    expect(changes?.args[0]).toBe('main ↔ worktree-auth (Working Tree)');
    expect(changes?.args[1]).toBe(compared);
    const byPath = new Map(compared.map(([label, left, right]) => [label.path, { left, right }]));
    expect(byPath.get(`${AGENT.path}/notes.txt`)?.left).toBeUndefined();
    expect(byPath.get(`${AGENT.path}/notes.txt`)?.right?.path).toBe(`${AGENT.path}/notes.txt`);
    expect(byPath.get(`${AGENT.path}/README.md`)?.left).toBeDefined();
    expect(byPath.get(`${AGENT.path}/src/session.ts`)?.left).toBeUndefined();
  });

  it('explains when there is no base to compare with', async () => {
    const { run, node } = harness(agentStatus({ base: undefined }));
    await run('gitglasses.worktrees.compareWithBase', node(AGENT));
    expect(ui.messages[0].text).toContain('no base to compare with');
    expect(ui.executed.find((call) => call.command === 'vscode.changes')).toBeUndefined();
  });
});

describe('Choose Base for Worktrees', () => {
  it('sends the chosen base with every status request, until reset', async () => {
    const { run, node, sent, view } = harness();
    // Items: default, separator, main, develop, separator, origin/main.
    ui.answers = [(shown) => shown.accept(3)];
    await run('gitglasses.worktrees.chooseBase');
    expect(view.baseFor(REPO)).toBe('develop');
    await run('gitglasses.worktrees.compareWithBase', node(AGENT));
    expect(sent('worktree/status').at(-1)?.params.base).toBe('develop');

    ui.answers = [(shown) => shown.accept(0)];
    await run('gitglasses.worktrees.chooseBase');
    expect(view.baseFor(REPO)).toBeUndefined();
  });
});
