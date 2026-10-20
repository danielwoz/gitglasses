// The Line Story panel's actions follow the story on show: when an earlier,
// slower story arrives after a newer one, Go to Line and the other actions
// still act on the newer line.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  shownDocuments: [] as unknown[],
}));

vi.mock('vscode', async () => {
  const base = await import('./support/fakeWebviewVscode');
  const parse = (value: string) => {
    const fsPath = value.replace(/^file:\/\//, '');
    return { ...base.Uri.file(fsPath), toString: () => value };
  };
  class Position {
    constructor(
      readonly line: number,
      readonly character: number,
    ) {}
  }
  class Range {
    constructor(
      readonly start: Position,
      readonly end: Position,
    ) {}
  }
  return {
    ...base,
    Uri: { ...base.Uri, parse },
    Position,
    Range,
    ViewColumn: { ...base.ViewColumn, Beside: -2 },
    env: { openExternal: async () => true },
    workspace: {
      ...base.workspace,
      isTrusted: true,
      asRelativePath: (uri: { fsPath: string }) => uri.fsPath.replace(/^\/repo\//, ''),
      openTextDocument: async (uri: { fsPath: string }) => ({
        uri,
        lineCount: 3,
        lineAt: (line: number) => ({ text: `${uri.fsPath} line ${line + 1}` }),
      }),
    },
    window: {
      ...base.window,
      activeTextEditor: undefined,
      showTextDocument: async (uri: unknown) => {
        hoisted.shownDocuments.push(uri);
        return undefined;
      },
    },
    commands: {
      ...base.commands,
      registerCommand: (id: string, handler: (...args: unknown[]) => unknown) => {
        hoisted.handlers.set(id, handler);
        return { dispose: () => undefined };
      },
    },
  };
});

import type { BlameCommit } from '@gitglasses/protocol';
import { recorded, Uri } from './support/fakeWebviewVscode';
import { registerLineStory, type LineStoryDeps } from '../src/lineStory/lineStory';
import { LINE_STORY_COMMAND } from '../src/lineStory/lineStoryLogic';

const SHA = '1'.repeat(40);

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

function blameOf(path: string) {
  const author = { name: 'Ada', email: 'ada@example.invalid', time: 100 };
  const commit: BlameCommit = {
    author,
    committer: author,
    summary: `change ${path}`,
    boundary: false,
  };
  return {
    kind: 'blame' as const,
    blame: {
      hunks: [{ sha: SHA, resultLine: 1, originalLine: 1, lineCount: 3, path }],
      commits: { [SHA]: commit },
      totalLines: 3,
      lfs: false,
    },
    target: { repoId: 'r1', rootPath: '/repo', relativePath: path },
  };
}

beforeEach(() => {
  recorded.reset();
  hoisted.handlers.clear();
  hoisted.shownDocuments.length = 0;
});

describe('Line Story panel', () => {
  it('acts on the newer line when an earlier story finishes last', async () => {
    const blames = new Map([
      ['/repo/slow.ts', deferred<ReturnType<typeof blameOf>>()],
      ['/repo/fast.ts', deferred<ReturnType<typeof blameOf>>()],
    ]);
    const deps = {
      context: { extensionUri: Uri.file('/ext') },
      engine: {
        capabilities: () => ({ gitCli: false }),
        request: async () => ({ sha: SHA, subject: 's', body: '', trailers: [], parents: [] }),
      },
      blame: {
        supports: () => true,
        blameDocument: (document: { uri: { fsPath: string } }) =>
          blames.get(document.uri.fsPath)!.promise,
      },
      integrations: {
        onDidChange: () => ({ dispose: () => undefined }),
        getHostingFor: async () => undefined,
        getConnectedHostingFor: async () => undefined,
        autolinkPatterns: async () => [],
      },
      log: () => undefined,
    } as unknown as LineStoryDeps;
    registerLineStory(deps);
    const tell = hoisted.handlers.get(LINE_STORY_COMMAND)!;

    const slow = tell({ uri: 'file:///repo/slow.ts', line: 1 });
    const fast = tell({ uri: 'file:///repo/fast.ts', line: 2 });
    blames.get('/repo/fast.ts')!.resolve(blameOf('fast.ts'));
    expect(await fast).toMatchObject({ file: 'fast.ts', line: 2 });
    blames.get('/repo/slow.ts')!.resolve(blameOf('slow.ts'));
    expect(await slow).toBeUndefined();

    const [panel] = recorded.panels;
    await panel.deliver({ type: 'openLine' });
    expect(hoisted.shownDocuments).toHaveLength(1);
    expect(String(hoisted.shownDocuments[0])).toBe('file:///repo/fast.ts');
    const stories = panel.postedOfType<{ type: 'story'; view: { file: string } }>('story');
    expect(stories.at(-1)?.view.file).toBe('fast.ts');
    expect(stories.some((story) => story.view.file === 'slow.ts')).toBe(false);
  });
});
