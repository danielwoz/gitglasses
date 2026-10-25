// Views render their empty and error states as tree items, so hosts that
// show contributed welcome content in place of the tree (Eclipse Theia)
// still show the data, and a request one view cannot make never changes
// what the others show.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => import('./support/fakeVscode'));

import { EngineError } from '@gitglasses/rpc';
import { ErrorCodes } from '@gitglasses/protocol';
import { EventEmitter, controls } from './support/fakeVscode';
import {
  ViewBase,
  ViewNode,
  ViewWithStates,
  currentViewState,
  setActiveRepoResolver,
  setViewState,
} from '../src/views/viewBase';
import { failureLines, stateLines } from '../src/views/viewStateContent';

const host = { hasBuiltinGit: true, trusted: true };

function engine() {
  const capabilities = new EventEmitter<void>();
  return {
    capabilities: () => ({ gitCli: true, watch: true }),
    onDidChangeCapabilities: capabilities.event,
    request: vi.fn(async () => ({ repos: [] })),
  };
}

class FakeView extends ViewBase {
  rootNodes: () => Promise<ViewNode[]> = async () => [];
  renders = 0;
  protected async getRootNodes(): Promise<ViewNode[]> {
    this.renders += 1;
    return this.rootNodes();
  }
  change(): void {
    this.fireChange();
  }
}

function labels(nodes: ViewNode[]): string[] {
  return nodes.map((node) => String(node.item.label));
}

describe('state lines', () => {
  it('offer a way out of each workspace state', () => {
    expect(
      stateLines('gitglasses.views.commits', 'noRepository', host).map((l) => l.command),
    ).toEqual([undefined, 'workbench.action.files.openFolder', 'git.clone']);
    expect(
      stateLines('gitglasses.views.commits', 'noRepository', { ...host, hasBuiltinGit: false }).map(
        (line) => line.command,
      ),
    ).not.toContain('git.clone');
    expect(stateLines('gitglasses.views.tags', 'engineUnavailable', host)[1].command).toBe(
      'gitglasses.restartEngine',
    );
  });

  it('give each view its own empty state', () => {
    expect(stateLines('gitglasses.views.searchCompare', 'ready', host)[0].command).toBe(
      'gitglasses.searchCommits',
    );
    expect(stateLines('gitglasses.views.stashes', 'ready', host)[0].label).toBe('No stashes');
    expect(
      stateLines('gitglasses.views.worktrees', 'ready', { ...host, trusted: false }).some(
        (line) => line.command,
      ),
    ).toBe(false);
  });

  it('explain a refusal in Restricted Mode with a way to trust the folder', () => {
    expect(failureLines({ restricted: true, message: 'x' })[1].command).toBe(
      'workbench.trust.manage',
    );
    expect(failureLines({ restricted: false, message: 'boom' })[0].tooltip).toBe('boom');
  });
});

describe('ViewWithStates', () => {
  beforeEach(() => {
    controls.reset();
    setActiveRepoResolver(async () => ({ repoId: 'r1', rootPath: '/w/repo' }));
  });
  afterEach(() => setActiveRepoResolver(undefined));

  it('shows the view’s nodes when it has some, and its empty state when not', async () => {
    const view = new FakeView(engine() as never, {} as never);
    const wrapped = new ViewWithStates('gitglasses.views.stashes', view, () => host);
    expect(labels(await wrapped.getChildren())).toEqual(['No stashes']);
    view.rootNodes = async () => [{ item: { label: 'stash@{0}' } as never }];
    expect(labels(await wrapped.getChildren())).toEqual(['stash@{0}']);
  });

  it('keeps a failed request to the view that made it', async () => {
    const failing = new FakeView(engine() as never, {} as never);
    failing.rootNodes = async () => {
      throw new EngineError(ErrorCodes.Restricted, 'refused in Restricted Mode');
    };
    const healthy = new FakeView(engine() as never, {} as never);
    const failingView = new ViewWithStates('gitglasses.views.worktrees', failing, () => host);
    const healthyView = new ViewWithStates('gitglasses.views.stashes', healthy, () => host);
    let healthyChanges = 0;
    healthyView.onDidChangeTreeData(() => (healthyChanges += 1));

    expect(labels(await healthyView.getChildren())).toEqual(['No stashes']);
    expect(labels(await failingView.getChildren())).toEqual([
      'Needs a trusted workspace',
      'Manage Workspace Trust',
    ]);
    expect(currentViewState()).toBe('ready');
    expect(healthyChanges).toBe(0);
  });

  it('renders again when the workspace state it shows moves on, and only then', async () => {
    setViewState('noRepository');
    const view = new FakeView(engine() as never, {} as never);
    const wrapped = new ViewWithStates('gitglasses.views.commits', view, () => host);
    setActiveRepoResolver(async () => undefined);
    expect(labels(await wrapped.getChildren())[0]).toBe('No git repository in this workspace');
    let changes = 0;
    wrapped.onDidChangeTreeData(() => (changes += 1));

    setViewState('ready');
    expect(changes).toBe(1);
    setActiveRepoResolver(async () => ({ repoId: 'r1', rootPath: '/w/repo' }));
    view.rootNodes = async () => [{ item: { label: 'commit' } as never }];
    expect(labels(await wrapped.getChildren())).toEqual(['commit']);
    setViewState('noRepository');
    setViewState('ready');
    expect(changes).toBe(1);
  });

  it('passes the view’s own change events through', () => {
    const view = new FakeView(engine() as never, {} as never);
    const wrapped = new ViewWithStates('gitglasses.views.commits', view, () => host);
    let changes = 0;
    wrapped.onDidChangeTreeData(() => (changes += 1));
    view.change();
    expect(changes).toBe(1);
  });
});
