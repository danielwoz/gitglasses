// The commit graph host's guards: commit actions never run on the
// uncommitted-changes row or a stash, actions from a snapshot of another
// repository are dropped, and branch and tag actions an engine that cannot
// run git (Restricted Mode, no git CLI) cannot serve are refused before
// anything reaches it.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';

vi.mock('vscode', () => import('./support/fakeWebviewVscode'));

import { UNCOMMITTED_SHA } from '@gitglasses/protocol/sha';
import type { EngineClient } from '@gitglasses/rpc';
import type { GraphRef, GraphRow } from '@gitglasses/protocol';
import {
  EventEmitter,
  FakeWebviewPanel,
  Uri,
  controls,
  recorded,
} from './support/fakeWebviewVscode';
import { runRefAction, runRowAction } from '../src/webviews/graphActions';
import { CLI_UNAVAILABLE_MESSAGE, RESTRICTED_MESSAGE } from '../src/engine/capabilityGate';
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
function graphEngine(caps: Record<string, unknown> = { gitCli: true, watch: true, threads: true }) {
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
          return {
            branches: [{ name: 'main', current: true, sha: COMMIT }],
            remotes: [],
            tags: [],
          };
        case 'status/summary':
          return { staged: [], unstaged: [], untracked: [], conflicted: [] };
        case 'repo/state':
          return { head: { detached: false, branch: 'main' } };
        default:
          return {};
      }
    },
    capabilities: () => caps,
    onNotification: () => ({ dispose: () => undefined }),
    onDidChangeCapabilities: () => ({ dispose: () => undefined }),
  };
  const mutations = (): Request[] =>
    requests.filter((request) => /^(mutate|tag|branch|stash|rebase)\//.test(request.method));
  return { engine: engine as unknown as EngineClient, requests, mutations };
}

/** The action context the graph host passes, for repository r1. */
function contextFor(engine: EngineClient) {
  return { engine, repoId: 'r1', log: () => undefined, openRebase: vi.fn() };
}

const RESTRICTED = { gitCli: false, restricted: true, watch: true, threads: true };
const NO_GIT_CLI = { gitCli: false, restricted: false, watch: true, threads: true };

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
    const ctx = contextFor(engine);
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
    const ctx = contextFor(engine);
    await runRowAction(ctx, 'switchDetached', ['d'.repeat(40)], KINDS);
    await runRowAction(ctx, 'stashDrop', [COMMIT], KINDS);
    expect(requests).toEqual([]);
  });

  it('runs a commit action on a commit row', async () => {
    const { engine, mutations } = graphEngine();
    await runRowAction(contextFor(engine), 'switchDetached', [COMMIT], KINDS);
    expect(mutations()).toEqual([
      { method: 'mutate/switch', params: { repoId: 'r1', ref: COMMIT } },
    ]);
  });

  it('refuses to create a tag where the engine cannot run git', async () => {
    for (const [caps, explanation] of [
      [RESTRICTED, RESTRICTED_MESSAGE],
      [NO_GIT_CLI, CLI_UNAVAILABLE_MESSAGE],
    ] as const) {
      recorded.reset();
      const { engine, requests } = graphEngine(caps);
      await runRowAction(contextFor(engine), 'createTag', [COMMIT], KINDS);
      expect(requests).toEqual([]);
      expect(controls.messages).toEqual([`GitGlasses: cannot create tag. ${explanation}.`]);
    }
  });
});

describe('runRefAction', () => {
  const tag: GraphRef = { name: 'v1.0', kind: 'tag' };
  const branch: GraphRef = { name: 'feature', kind: 'branch' };

  it('refuses branch and tag management where the engine cannot run git', async () => {
    const main: GraphRef = { name: 'main', kind: 'branch' };
    for (const [caps, explanation] of [
      [RESTRICTED, RESTRICTED_MESSAGE],
      [NO_GIT_CLI, CLI_UNAVAILABLE_MESSAGE],
    ] as const) {
      recorded.reset();
      const { engine, requests } = graphEngine(caps);
      const ctx = contextFor(engine);
      await runRefAction(ctx, 'pushTag', tag, COMMIT);
      await runRefAction(ctx, 'deleteTag', tag, COMMIT);
      await runRefAction(ctx, 'rename', branch, COMMIT);
      await runRefAction(ctx, 'delete', branch, COMMIT);
      await runRefAction(ctx, 'push', branch, COMMIT);
      // The checked-out branch is refused alike.
      await runRefAction(ctx, 'push', main, COMMIT);
      expect(requests).toEqual([]);
      expect(controls.messages).toHaveLength(6);
      for (const message of controls.messages) expect(message).toContain(explanation);
    }
  });
});

describe('GraphWebviewHost', () => {
  function setup() {
    const engine = graphEngine();
    const activeRepoChanged = new EventEmitter<void>();
    const reloaded = new EventEmitter<void>();
    let active: ActiveRepo = { repoId: 'r1', rootPath: '/repos/one' };
    setActiveRepoResolver(async () => active);
    const repos = {
      // r3 is the first repository again, as an engine restart registers it.
      isRootOf: (repoId: string, root: string) =>
        ((repoId === 'r1' || repoId === 'r3') && root === '/repos/one') ||
        (repoId === 'r2' && root === '/repos/two'),
      locate: () => undefined,
    } as unknown as RepositoryService;
    const host = new GraphWebviewHost({
      context: { extensionUri: Uri.file('/ext') } as unknown as vscode.ExtensionContext,
      engine: engine.engine,
      repos,
      onDidChangeActiveRepo: activeRepoChanged.event,
      onDidReload: reloaded.event,
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
    /** An engine restart that registers the repositories again. */
    const restartAs = async (repo: ActiveRepo): Promise<void> => {
      const before = panel.postedOfType('reset').length;
      active = repo;
      reloaded.fire();
      await vi.waitFor(() => expect(panel.postedOfType('reset').length).toBeGreaterThan(before));
    };
    return { ...engine, host, panel, switchTo, restartAs };
  }

  const lastReset = (panel: FakeWebviewPanel) =>
    panel.postedOfType<{ type: 'reset'; restore?: boolean; filter?: string[] }>('reset').at(-1);

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

  it('tells a reloaded webview to restore its place only in the same repository', async () => {
    const same = setup();
    await same.panel.deliver({
      type: 'ready',
      state: { repoRoot: '/repos/one', topSha: COMMIT, loaded: 600, filter: ['refs/heads/main'] },
    });
    expect(lastReset(same.panel)).toMatchObject({ restore: true, filter: ['refs/heads/main'] });
    same.host.dispose();

    const other = setup();
    await other.panel.deliver({
      type: 'ready',
      state: { repoRoot: '/repos/two', topSha: COMMIT, filter: ['refs/heads/main'] },
    });
    const reset = lastReset(other.panel);
    expect(reset?.restore).toBe(false);
    expect(reset?.filter).toBeUndefined();
    other.host.dispose();
  });

  it('keeps the branch filter across an engine restart only for the same repository', async () => {
    const { panel, host, restartAs, switchTo } = setup();
    await panel.deliver({ type: 'ready' });
    await panel.deliver({ type: 'setFilter', refs: ['refs/heads/main'] });
    expect(lastReset(panel)?.filter).toEqual(['refs/heads/main']);

    // The same repository under a new id, its root spelled another way.
    await restartAs({ repoId: 'r3', rootPath: '/repos/one/' });
    expect(lastReset(panel)?.filter).toEqual(['refs/heads/main']);

    await switchTo({ repoId: 'r2', rootPath: '/repos/two' });
    expect(lastReset(panel)?.filter).toBeUndefined();
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
