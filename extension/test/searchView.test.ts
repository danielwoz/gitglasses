// The Search & Compare view's search lifecycle against a scripted engine:
// progress while results stream in, a newer search replacing one still
// running, Cancel on the long-search notification, and a date search
// answered without git saying how much history it covered.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CommitSummaryInfo, ErrorCodes } from '@gitglasses/protocol';
import { EngineError } from '@gitglasses/rpc';

const fake = vi.hoisted(() => {
  type Listener = () => void;
  class CancellationTokenSource {
    private readonly listeners = new Set<Listener>();
    readonly token: {
      isCancellationRequested: boolean;
      onCancellationRequested(listener: Listener): { dispose(): void };
    };
    constructor() {
      const listeners = this.listeners;
      this.token = {
        isCancellationRequested: false,
        onCancellationRequested: (listener) => {
          listeners.add(listener);
          return { dispose: () => listeners.delete(listener) };
        },
      };
    }
    cancel(): void {
      if (this.token.isCancellationRequested) return;
      this.token.isCancellationRequested = true;
      for (const listener of [...this.listeners]) listener();
    }
    dispose(): void {
      this.listeners.clear();
    }
  }
  const state = {
    progress: [] as {
      options: { location: unknown; title?: string; cancellable?: boolean };
      cancel: Listener;
    }[],
    warnings: [] as string[],
  };
  class EventEmitter<T> {
    private listeners = new Set<(value: T) => void>();
    readonly event = (listener: (value: T) => void) => {
      this.listeners.add(listener);
      return { dispose: () => this.listeners.delete(listener) };
    };
    fire(value: T): void {
      for (const listener of [...this.listeners]) listener(value);
    }
    dispose(): void {
      this.listeners.clear();
    }
  }
  const vscode = {
    EventEmitter,
    CancellationTokenSource,
    TreeItem: class {
      iconPath?: unknown;
      tooltip?: unknown;
      description?: unknown;
      contextValue?: string;
      command?: unknown;
      constructor(
        public label: string,
        public collapsibleState: number,
      ) {}
    },
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    ThemeIcon: class {
      constructor(public id: string) {}
    },
    ProgressLocation: { SourceControl: 1, Window: 10, Notification: 15 },
    Uri: { from: (parts: { scheme: string; path?: string }) => parts },
    commands: { executeCommand: async () => undefined },
    window: {
      withProgress: async <T>(
        options: { location: unknown; title?: string; cancellable?: boolean },
        task: (progress: unknown, token: unknown) => Promise<T>,
      ) => {
        const tokenSource = new CancellationTokenSource();
        state.progress.push({ options, cancel: () => tokenSource.cancel() });
        return task({ report: () => undefined }, tokenSource.token);
      },
      showWarningMessage: async (text: string) => {
        state.warnings.push(text);
        return undefined;
      },
      showInputBox: async () => undefined,
    },
  };
  return { state, vscode };
});

vi.mock('vscode', () => fake.vscode);

import { SearchViewProvider } from '../src/views/searchView';
import { setActiveRepoResolver } from '../src/views/viewBase';

const { state } = fake;

interface Pending {
  method: string;
  params: { streamId: string; limit: number; query: Record<string, unknown> };
  resolve(result: { streamId: string; total: number; truncated: boolean }): void;
  reject(error: Error): void;
}

/** An engine whose searches stay open until the test answers them. */
function scriptedEngine() {
  const handlers = new Set<(params: { streamId: string; matches: CommitSummaryInfo[] }) => void>();
  const pending: Pending[] = [];
  const engine = {
    // The handshake is done, so the view renders without waiting for it.
    capabilities: () => ({ gitCli: true, watch: true }),
    onNotification: (_method: string, handler: (params: never) => void) => {
      handlers.add(handler);
      return { dispose: () => handlers.delete(handler) };
    },
    request: (
      method: string,
      params: Pending['params'],
      token?: { onCancellationRequested(listener: () => void): unknown },
    ) =>
      new Promise((resolve, reject) => {
        pending.push({ method, params, resolve, reject });
        token?.onCancellationRequested(() =>
          reject(new EngineError(ErrorCodes.Cancelled, 'request cancelled')),
        );
      }),
  };
  const stream = (entry: Pending, summaries: string[], time = 1_700_000_000): void => {
    const matches = summaries.map((summary, i) => ({
      sha: `${i}`.padStart(40, 'a'),
      parents: [],
      author: { name: 'alice', email: 'alice@example.invalid', time },
      committer: { name: 'alice', email: 'alice@example.invalid', time },
      summary,
    }));
    for (const handler of handlers) handler({ streamId: entry.params.streamId, matches });
  };
  return { engine: engine as never, pending, stream };
}

/** Lets the view's pending promise chains run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

async function labels(view: SearchViewProvider): Promise<string[]> {
  return (await view.getChildren()).map((node) => String(node.item.label));
}

beforeEach(() => {
  state.progress = [];
  state.warnings = [];
  setActiveRepoResolver(async () => ({ repoId: 'repo-1', rootPath: '/repo' }));
});

afterEach(() => {
  vi.useRealTimers();
  setActiveRepoResolver(undefined);
});

describe('Search & Compare', () => {
  it('shows progress in the view while matches stream in', async () => {
    const { engine, pending, stream } = scriptedEngine();
    const view = new SearchViewProvider(engine, {} as never);
    const search = view.runExternalSearch({ text: 'login' }, 'matching "login"');
    await settle();

    expect(state.progress[0].options.location).toEqual({
      viewId: 'gitglasses.views.searchCompare',
    });
    expect(pending[0].method).toBe('search/commits');
    stream(pending[0], ['fix login']);
    expect(await labels(view)).toEqual([
      'Searching commits matching "login"…, 1 found so far',
      'fix login',
    ]);

    pending[0].resolve({ streamId: pending[0].params.streamId, total: 1, truncated: false });
    await search;
    expect(await labels(view)).toEqual(['1 commit matching "login"', 'fix login']);
  });

  it('lets a newer search replace one still running', async () => {
    const { engine, pending, stream } = scriptedEngine();
    const view = new SearchViewProvider(engine, {} as never);
    const older = view.runExternalSearch({ text: 'old' }, 'matching "old"');
    await settle();
    stream(pending[0], ['old one']);

    const newer = view.runExternalSearch({ text: 'new' }, 'matching "new"');
    await settle();
    stream(pending[1], ['new one', 'new two']);
    // Late matches from the replaced search are dropped.
    stream(pending[0], ['old two']);
    pending[1].resolve({ streamId: pending[1].params.streamId, total: 2, truncated: false });
    await Promise.all([older, newer]);

    expect(await labels(view)).toEqual(['2 commits matching "new"', 'new one', 'new two']);
    expect(state.warnings).toEqual([]);
  });

  it('offers Cancel on a long search, and says it was cancelled', async () => {
    vi.useFakeTimers();
    const { engine, pending } = scriptedEngine();
    const view = new SearchViewProvider(engine, {} as never);
    const search = view.runExternalSearch(
      { content: 'parseConfig', contentMode: 'string' },
      'adding or removing "parseConfig"',
    );
    await vi.advanceTimersByTimeAsync(1500);

    expect(pending[0].method).toBe('search/log');
    const notification = state.progress.find((entry) => entry.options.cancellable);
    expect(notification?.options.title).toBe(
      'GitGlasses: searching commits adding or removing "parseConfig"',
    );
    notification!.cancel();
    await search;

    expect(await labels(view)).toEqual([
      'Search cancelled: commits adding or removing "parseConfig"',
    ]);
    expect(state.warnings).toEqual([]);
  });

  it('answers a date search without git, and says older history was not searched', async () => {
    const { engine, pending, stream } = scriptedEngine();
    const view = new SearchViewProvider(engine, {} as never);
    const search = view.runExternalSearch(
      { text: 'login', until: '2020-01-01' },
      'matching "login" before 2020-01-01',
    );
    await settle();
    pending[0].reject(new EngineError(ErrorCodes.MethodNotSupported, 'needs the git CLI'));
    await settle();

    expect(pending[1].method).toBe('search/commits');
    expect(pending[1].params.query).toEqual({ text: 'login', author: undefined });
    // Every match is newer than the window, and the scan stopped at its limit.
    stream(pending[1], ['fix login'], 1_700_000_000);
    pending[1].resolve({ streamId: pending[1].params.streamId, total: 5000, truncated: true });
    await search;

    expect(await labels(view)).toEqual([
      'No commits matching "login" before 2020-01-01 in recent history (older commits were not searched)',
    ]);
  });

  it('explains what needs git when a code search is refused', async () => {
    const { engine, pending } = scriptedEngine();
    const view = new SearchViewProvider(engine, {} as never);
    const search = view.runExternalSearch({ path: 'src/app.ts' }, 'in src/app.ts');
    await settle();
    pending[0].reject(new EngineError(ErrorCodes.Restricted, 'restricted'));
    await search;

    expect(pending).toHaveLength(1);
    expect(await labels(view)).toEqual([
      'Searching by code change or file runs git, which GitGlasses does not do in Restricted Mode. Trust this folder to use it; message, author, date and sha searches still work.',
    ]);
  });
});
