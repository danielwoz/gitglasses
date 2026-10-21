// The Git Commands palette names one repository, and Rebase must run there:
// the rebase editor previews, confirms and rebases in the repository the
// palette passed it, not the one the sidebar views follow.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EngineClient } from '@gitglasses/rpc';
import type { RepositoryService } from '../src/model/repositoryService';

interface Item {
  label: string;
  id?: string;
  repo?: { repoId: string };
}

/** What the next quick pick picks: an item matching the predicate. */
const picks: Array<(item: Item) => boolean> = [];
const commandHandlers = new Map<string, (...args: unknown[]) => unknown>();
const warnings: Array<{ message: string; detail?: string }> = [];
const panelMessages: Array<(message: unknown) => Promise<void>> = [];

vi.mock('vscode', async () => {
  const base = await import('./support/fakeVscode');
  const choose = (items: readonly Item[]): Item | undefined => {
    const predicate = picks.shift();
    if (!predicate) throw new Error(`no pick scripted for ${items.map((i) => i.label)}`);
    return items.find(predicate);
  };
  const disposable = { dispose: () => undefined };
  return {
    ...base,
    QuickInputButtons: { Back: { id: 'back' } },
    ViewColumn: { Active: -1 },
    commands: {
      ...base.commands,
      registerCommand(id: string, handler: (...args: unknown[]) => unknown) {
        commandHandlers.set(id, handler);
        return disposable;
      },
    },
    window: {
      ...base.window,
      async showQuickPick(items: readonly Item[]) {
        return choose(items);
      },
      createQuickPick() {
        let accept: () => void = () => undefined;
        const picker = {
          items: [] as Item[],
          selectedItems: [] as Item[],
          title: undefined as string | undefined,
          placeholder: undefined as string | undefined,
          buttons: [] as unknown[],
          onDidTriggerButton: () => disposable,
          onDidAccept: (listener: () => void) => {
            accept = listener;
            return disposable;
          },
          onDidHide: () => disposable,
          show() {
            queueMicrotask(() => {
              const picked = choose(picker.items);
              picker.selectedItems = picked ? [picked] : [];
              accept();
            });
          },
          dispose: () => undefined,
        };
        return picker;
      },
      async showWarningMessage(message: string, options?: { detail?: string }) {
        warnings.push({ message, detail: options?.detail });
        return undefined;
      },
      async showErrorMessage(message: string) {
        throw new Error(`unexpected error: ${message}`);
      },
      setStatusBarMessage: () => disposable,
      createWebviewPanel() {
        return {
          webview: {
            html: '',
            cspSource: 'test',
            asWebviewUri: (uri: unknown) => uri,
            onDidReceiveMessage(listener: (message: unknown) => Promise<void>) {
              panelMessages.push(listener);
              return disposable;
            },
            postMessage: async () => true,
          },
          onDidDispose: () => disposable,
          reveal: () => undefined,
          dispose: () => undefined,
        };
      },
    },
  };
});

import { registerGitPalette } from '../src/commands/gitPalette';
import { RebaseWebviewHost } from '../src/webviews/rebaseHost';
import { setActiveRepoResolver } from '../src/views/viewBase';

const app = { repoId: 'r1', rootPath: '/w/app', workspacePath: '/w/app', name: 'app' };
const lib = { repoId: 'r2', rootPath: '/w/lib', workspacePath: '/w/lib', name: 'lib' };

const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
const engine = {
  capabilities: () => undefined,
  onNotification: () => ({ dispose: () => undefined }),
  async request(method: string, params: Record<string, unknown>) {
    requests.push({ method, params });
    switch (method) {
      case 'status/summary':
        return { branch: 'feature', conflicted: [], staged: [], unstaged: [] };
      case 'refs/list':
        return {
          branches: [
            { name: 'feature', sha: 'a'.repeat(40), current: true },
            { name: 'main', sha: 'b'.repeat(40), current: false },
          ],
        };
      case 'rebase/preview':
        return {
          entries: [{ sha: 'c'.repeat(40), summary: 'work' }],
          headSha: 'a'.repeat(40),
          upstreamSha: 'b'.repeat(40),
          mergeCount: 0,
        };
      case 'repo/state':
        return { head: { branch: 'feature', detached: false }, sequencer: { operation: 'none' } };
      default:
        throw new Error(`unexpected ${method}`);
    }
  },
} as unknown as EngineClient;

// The file in the editor is in lib.
const repos = {
  locateOrDiscover: async () => ({ repoId: lib.repoId, rootPath: lib.rootPath }),
} as unknown as RepositoryService;

const context = { extensionUri: { fsPath: '/ext' } } as never;

beforeEach(() => {
  picks.length = 0;
  requests.length = 0;
  warnings.length = 0;
  panelMessages.length = 0;
  commandHandlers.clear();
  // The views follow app.
  setActiveRepoResolver(async () => app);
});

afterEach(() => setActiveRepoResolver(undefined));

describe('Rebase from the Git Commands palette', () => {
  it('opens the rebase editor on the repository the palette acts on', async () => {
    const opened: Array<{ upstream: string; repoId: string }> = [];
    registerGitPalette(
      engine,
      repos,
      (upstream, repo) => void opened.push({ upstream, repoId: repo.repoId }),
      {
        listRepos: async () => [app, lib],
        activeEditorUri: () => ({ fsPath: '/w/lib/src/a.ts' }) as never,
      },
    );
    picks.push(
      (item) => item.repo?.repoId === lib.repoId, // the editor's file's repository
      (item) => item.id === 'rebase',
      (item) => item.label === 'main',
    );
    await commandHandlers.get('gitglasses.gitCommands')!();

    expect(opened).toEqual([{ upstream: 'main', repoId: lib.repoId }]);
    const branchLists = requests.filter((request) => request.method === 'refs/list');
    expect(branchLists.map((request) => request.params.repoId)).toEqual([lib.repoId]);
  });
});

describe('RebaseWebviewHost', () => {
  it('previews, confirms and names the repository it was given', async () => {
    const host = new RebaseWebviewHost(context, engine, repos, () => undefined);
    await host.open('main', lib);

    const previews = requests.filter((request) => request.method === 'rebase/preview');
    expect(previews.map((request) => request.params.repoId)).toEqual([lib.repoId]);

    await panelMessages[0]({ type: 'start', plan: [] });
    const inspected = requests.filter(
      (r) => r.method === 'repo/state' || r.method === 'status/summary',
    );
    expect(inspected.length).toBeGreaterThan(0);
    expect(new Set(inspected.map((r) => r.params.repoId))).toEqual(new Set([lib.repoId]));
    expect(warnings).toEqual([
      {
        message: "Rebase 'feature' onto main in lib?",
        detail: expect.stringMatching(/^Repository: \/w\/lib\n/),
      },
    ]);
    host.dispose();
  });

  it('falls back to the repository the views follow', async () => {
    const host = new RebaseWebviewHost(context, engine, repos, () => undefined);
    await host.open('main');
    const previews = requests.filter((request) => request.method === 'rebase/preview');
    expect(previews.map((request) => request.params.repoId)).toEqual([app.repoId]);
    host.dispose();
  });
});
