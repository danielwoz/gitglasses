// The commit graph host's guards: commit actions never run on the
// uncommitted-changes row or a stash, and actions from a snapshot of another
// repository are dropped.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';

vi.mock('vscode', () => import('./support/fakeWebviewVscode'));

import { UNCOMMITTED_SHA } from '@gitglasses/protocol/sha';
import type { EngineClient } from '@gitglasses/rpc';
import type { GraphRow } from '@gitglasses/protocol';
import {
  EventEmitter,
  FakeWebviewPanel,
  Uri,
  controls,
  recorded,
} from './support/fakeWebviewVscode';
import { runRefAction, runRowAction } from '../src/webviews/graphActions';
import { GraphWebviewHost } from '../src/webviews/graphHost';
import { setActiveRepoResolver, type ActiveRepo } from '../src/views/viewBase';
import type { RepositoryService } from '../src/model/repositoryService';

const COMMIT = 'c'.repeat(40);
const STASH = '5'.repeat(40);

interface Request {
  method: string;
  params: Record<string, unknown>;
}

/** An engine that answers the reads the graph host makes and records every
 *  request. Mutations succeed without doing anything. */
function graphEngine() {
  const requests: Request[] = [];
  const row = (sha: string, kind: GraphRow['kind']): GraphRow => ({
    sha,
    parents: [],
    lane: 0,
    laneEdges: [],
    kind,
    author: { name: 'A', email: 'a@example.com', time: 1 },
    time: 1,
    summary: kind,
    refs: [],
  });
  const engine = {
    async request(method: string, params: Record<string, unknown>) {
      requests.push({ method, params });
      switch (method) {
        case 'graph/rows':
          return {
            rows: [row(UNCOMMITTED_SHA, 'wip'), row(STASH, 'stash'), row(COMMIT, 'commit')],
            refsFingerprint: 1,
          };
        case 'refs/list':
          return { branches: [], remotes: [], tags: [] };
        case 'status/summary':
          return { staged: [], unstaged: [], untracked: [], conflicted: [] };
        case 'repo/state':
          return { head: { detached: false, branch: 'main' } };
        default:
          return {};
      }
    },
    capabilities: () => ({ gitCli: true, watch: true, threads: true }),
    onNotification: () => ({ dispose: () => undefined }),
    onDidChangeCapabilities: () => ({ dispose: () => undefined }),
  };
  const mutations = (): Request[] =>
    requests.filter((request) => /^(mutate|tag|branch|stash|rebase)\//.test(request.method));
  return { engine: engine as unknown as EngineClient, requests, mutations };
}

const KINDS = new Map<string, GraphRow['kind']>([
  [UNCOMMITTED_SHA, 'wip'],
  [STASH, 'stash'],
  [COMMIT, 'commit'],
]);

beforeEach(() => recorded.reset());
afterEach(() => setActiveRepoResolver(undefined));

describe('runRowAction', () => {
  it('refuses commit actions on the uncommitted-changes row and on stashes', async () => {
    const { engine, requests } = graphEngine();
    const ctx = { engine, repoId: 'r1', openRebase: vi.fn() };
    await runRowAction(ctx, 'reset', [STASH], KINDS);
    await runRowAction(ctx, 'merge', [STASH], KINDS);
    await runRowAction(ctx, 'cherryPick', [UNCOMMITTED_SHA], KINDS);
    await runRowAction(ctx, 'revert', [COMMIT, STASH], KINDS);
    await runRowAction(ctx, 'rebase', [UNCOMMITTED_SHA], KINDS);
    expect(requests).toEqual([]);
    expect(ctx.openRebase).not.toHaveBeenCalled();
    expect(controls.messages).toHaveLength(5);
    expect(controls.messages[0]).toMatch(/commits only/);
  });

  it('refuses commits the graph never showed, and stash actions on commits', async () => {
    const { engine, requests } = graphEngine();
    const ctx = { engine, repoId: 'r1', openRebase: vi.fn() };
    await runRowAction(ctx, 'switchDetached', ['d'.repeat(40)], KINDS);
    await runRowAction(ctx, 'stashDrop', [COMMIT], KINDS);
    expect(requests).toEqual([]);
  });

  it('runs a commit action on a commit row', async () => {
    const { engine, mutations } = graphEngine();
    await runRowAction(
      { engine, repoId: 'r1', openRebase: vi.fn() },
      'switchDetached',
      [COMMIT],
      KINDS,
    );
    expect(mutations()).toEqual([
      { method: 'mutate/switch', params: { repoId: 'r1', ref: COMMIT } },
    ]);
  });
});

describe('runRefAction', () => {
  it('still pushes the checked-out branch', async () => {
    const { engine, mutations } = graphEngine();
    await runRefAction(
      { engine, repoId: 'r1', openRebase: vi.fn() },
      'push',
      { name: 'main', kind: 'branch', upstream: { name: 'origin/main', ahead: 1, behind: 0 } },
      COMMIT,
    );
    expect(mutations()).toEqual([
      { method: 'mutate/push', params: { repoId: 'r1', setUpstream: false } },
    ]);
  });
});

describe('GraphWebviewHost', () => {
  function setup() {
    const engine = graphEngine();
    const activeRepoChanged = new EventEmitter<void>();
    let active: ActiveRepo = { repoId: 'r1', rootPath: '/repos/one' };
    setActiveRepoResolver(async () => active);
    const repos = {
      isRootOf: (repoId: string, root: string) =>
        (repoId === 'r1' && root === '/repos/one') || (repoId === 'r2' && root === '/repos/two'),
      locate: () => undefined,
    } as unknown as RepositoryService;
    const host = new GraphWebviewHost({
      context: { extensionUri: Uri.file('/ext') } as unknown as vscode.ExtensionContext,
      engine: engine.engine,
      repos,
      onDidChangeActiveRepo: activeRepoChanged.event,
      onDidReload: new EventEmitter<void>().event,
      openRebase: vi.fn(),
      log: () => undefined,
    });
    const panel = new FakeWebviewPanel();
    host.adopt(panel as unknown as vscode.WebviewPanel);
    const switchTo = async (repo: ActiveRepo): Promise<void> => {
      active = repo;
      activeRepoChanged.fire();
      // The host re-resolves and resets asynchronously.
      await vi.waitFor(() => {
        const resets = panel.postedOfType<{ type: 'reset'; repoRoot: string }>('reset');
        expect(resets[resets.length - 1]?.repoRoot).toBe(repo.rootPath);
      });
    };
    return { ...engine, host, panel, switchTo };
  }

  const generationOf = (panel: FakeWebviewPanel): number => {
    const resets = panel.postedOfType<{ type: 'reset'; generation: number }>('reset');
    return resets[resets.length - 1].generation;
  };

  it('runs actions that carry a generation issued for the shown repository', async () => {
    const { panel, mutations, host } = setup();
    await panel.deliver({ type: 'ready' });
    const generation = generationOf(panel);
    await panel.deliver({ type: 'action', generation, action: 'switchDetached', shas: [COMMIT] });
    expect(mutations()).toEqual([
      { method: 'mutate/switch', params: { repoId: 'r1', ref: COMMIT } },
    ]);
    host.dispose();
  });

  it('drops actions from before the graph switched repositories', async () => {
    const { panel, mutations, switchTo, host } = setup();
    await panel.deliver({ type: 'ready' });
    const before = generationOf(panel);
    await switchTo({ repoId: 'r2', rootPath: '/repos/two' });
    expect(generationOf(panel)).toBeGreaterThan(before);

    await panel.deliver({
      type: 'action',
      generation: before,
      action: 'switchDetached',
      shas: [COMMIT],
    });
    await panel.deliver({
      type: 'refAction',
      generation: before,
      action: 'checkout',
      ref: { name: 'feature', kind: 'branch' },
      sha: COMMIT,
    });
    // A generation that was never issued is no better.
    await panel.deliver({
      type: 'action',
      generation: 999,
      action: 'switchDetached',
      shas: [COMMIT],
    });
    expect(mutations()).toEqual([]);

    await panel.deliver({
      type: 'action',
      generation: generationOf(panel),
      action: 'switchDetached',
      shas: [COMMIT],
    });
    expect(mutations()).toEqual([
      { method: 'mutate/switch', params: { repoId: 'r2', ref: COMMIT } },
    ]);
    host.dispose();
  });

  it('refuses a commit action on a stash shown in the graph', async () => {
    const { panel, mutations, host } = setup();
    await panel.deliver({ type: 'ready' });
    await panel.deliver({
      type: 'action',
      generation: generationOf(panel),
      action: 'reset',
      shas: [STASH],
    });
    expect(mutations()).toEqual([]);
    expect(controls.messages.some((message) => /commits only/.test(message))).toBe(true);
    host.dispose();
  });
});
