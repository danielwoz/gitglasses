// The commit graph's branch and tag actions run the protocol's branch and tag
// methods through the same flows as the Branches and Tags views: renaming,
// pushing and deleting a branch, and creating, pushing and deleting a tag.

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => import('./support/fakeVscodeUi'));

import type { GraphRef } from '@gitglasses/protocol';
import { ErrorCodes } from '@gitglasses/protocol';
import { EngineError } from '@gitglasses/rpc';
import { ui, type ShownInput } from './support/fakeVscodeUi';
import { runRefAction, runRowAction } from '../src/webviews/graphActions';
import { registerRefCommands } from '../src/views/refCommands';

const COMMIT = 'c'.repeat(40);

interface Request {
  method: string;
  params: Record<string, unknown>;
}

/** An engine with one remote, `origin`, that records every request. */
function refsEngine(overrides: Record<string, (params: Record<string, unknown>) => unknown> = {}) {
  const requests: Request[] = [];
  const answers: Record<string, (params: Record<string, unknown>) => unknown> = {
    'refs/list': () => ({
      branches: [{ name: 'main', current: true, sha: COMMIT, upstream: 'origin/main' }],
      remotes: [{ name: 'origin', branches: [{ name: 'main', sha: COMMIT }] }],
      tags: [],
    }),
    'status/summary': () => ({ staged: [], unstaged: [], untracked: [], conflicted: [] }),
    'repo/state': () => ({ head: { detached: false, branch: 'main' } }),
    'branch/push': (params) => ({ remote: params.remote ?? 'origin', branch: params.name }),
    ...overrides,
  };
  const engine = {
    capabilities: () => ({ gitCli: true, watch: true, threads: true }),
    onNotification: () => ({ dispose: () => undefined }),
    async request(method: string, params: Record<string, unknown>) {
      requests.push({ method, params });
      return answers[method]?.(params) ?? {};
    },
  };
  const mutations = (): Request[] =>
    requests.filter((request) => /^(mutate|tag|branch)\//.test(request.method));
  return { engine: engine as never, requests, mutations };
}

function contextFor(engine: never) {
  return { engine, repoId: 'r1', log: () => undefined, openRebase: vi.fn() };
}

const typeIn =
  (value: string) =>
  (shown: ShownInput): void =>
    shown.accept(value);

const feature: GraphRef = { name: 'feature', kind: 'branch' };
const tag: GraphRef = { name: 'v1.0', kind: 'tag' };

beforeEach(() => ui.reset());

describe('the graph ref chips', () => {
  it('rename a branch with branch/rename', async () => {
    const { engine, mutations } = refsEngine();
    ui.answers.push(typeIn('feature-2'));
    await runRefAction(contextFor(engine), 'rename', feature, COMMIT);
    expect(mutations()).toEqual([
      { method: 'branch/rename', params: { repoId: 'r1', name: 'feature', newName: 'feature-2' } },
    ]);
    expect(ui.status).toContain("GitGlasses: Renamed 'feature' to 'feature-2'");
  });

  it('create a tag at the commit with tag/create', async () => {
    const { engine, mutations } = refsEngine();
    ui.answers.push(typeIn('v2.0'), typeIn('Release 2.0'));
    await runRowAction(
      contextFor(engine),
      'createTag',
      [COMMIT],
      new Map([[COMMIT, 'commit' as const]]),
    );
    expect(mutations()).toEqual([
      {
        method: 'tag/create',
        params: { repoId: 'r1', name: 'v2.0', ref: COMMIT, message: 'Release 2.0' },
      },
    ]);
  });

  it('push and delete a tag with tag/push and tag/delete', async () => {
    const { engine, mutations } = refsEngine();
    await runRefAction(contextFor(engine), 'pushTag', tag, COMMIT);
    ui.messageChoices.push('Proceed');
    await runRefAction(contextFor(engine), 'deleteTag', tag, COMMIT);
    expect(mutations()).toEqual([
      { method: 'tag/push', params: { repoId: 'r1', name: 'v1.0', remote: 'origin' } },
      { method: 'tag/delete', params: { repoId: 'r1', name: 'v1.0' } },
    ]);
  });

  it('push the checked-out branch to where git would push it', async () => {
    const { engine, mutations } = refsEngine();
    await runRefAction(
      contextFor(engine),
      'push',
      { name: 'main', kind: 'branch', upstream: { name: 'origin/main', ahead: 1, behind: 0 } },
      COMMIT,
    );
    expect(mutations()).toEqual([
      { method: 'branch/push', params: { repoId: 'r1', name: 'main', dryRun: true } },
      { method: 'branch/push', params: { repoId: 'r1', name: 'main', remote: 'origin' } },
    ]);
    expect(ui.status).toContain("GitGlasses: Pushed 'main' to origin/main");
  });

  it('publish a branch that tracks nothing to the only remote', async () => {
    const { engine, mutations } = refsEngine();
    await runRefAction(contextFor(engine), 'push', feature, COMMIT);
    expect(mutations().at(-1)).toEqual({
      method: 'branch/push',
      params: { repoId: 'r1', name: 'feature', remote: 'origin', setUpstream: true },
    });
  });

  it('offer a forced delete only for a branch git calls not fully merged', async () => {
    let attempts = 0;
    const { engine, mutations } = refsEngine({
      'mutate/branchDelete': () => {
        if (attempts++ === 0) {
          throw new EngineError(
            ErrorCodes.GitError,
            "error: the branch 'feature' is not fully merged",
          );
        }
        return {};
      },
    });
    ui.messageChoices.push('Proceed', 'Proceed');
    await runRefAction(contextFor(engine), 'delete', feature, COMMIT);
    expect(mutations().map((request) => request.params.force)).toEqual([false, true]);
  });
});

describe('the Branches view', () => {
  it('renames a branch with the same request as the graph', async () => {
    const { engine, mutations } = refsEngine();
    registerRefCommands({
      engine,
      repos: {} as never,
      integrations: {} as never,
      log: () => undefined,
      refresh: () => undefined,
      openRebase: () => undefined,
    });
    ui.answers.push(typeIn('feature-2'));
    await ui.commands.get('gitglasses.branch.rename')!({
      repo: { repoId: 'r1', rootPath: '/repo' },
      ref: { kind: 'branch', name: 'feature', current: false },
    });
    expect(mutations()).toEqual([
      { method: 'branch/rename', params: { repoId: 'r1', name: 'feature', newName: 'feature-2' } },
    ]);
  });
});
