import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import type * as vscode from 'vscode';
import { ErrorCodes } from '@gitglasses/protocol';
import { EngineError, EngineRestartedError, type EngineClient } from '@gitglasses/rpc';
import {
  NO_REPOSITORY_TTL_MS,
  RepositoryService,
  defaultCaseInsensitive,
  type RepositoryServiceOptions,
} from '../src/model/repositoryService';
import { identityAliasResolver, type IdentifyPath } from '../src/model/pathAliases';

function fileUri(fsPath: string): vscode.Uri {
  return { scheme: 'file', fsPath } as unknown as vscode.Uri;
}

interface Repo {
  root: string;
  id: string;
}

/**
 * Engine stand-in for repo/discover: answers with the innermost repository
 * whose `match` prefix contains the requested path (the engine's own upward
 * search), reporting `root` with a trailing slash as libgit2 does.
 */
function fakeEngine(
  repos: (Repo & { match: string })[],
  options: { fail?: (dir: string) => Error | undefined } = {},
) {
  const requests: { method: string; params: Record<string, string> }[] = [];
  const engine = {
    async request(method: string, params: Record<string, string>) {
      requests.push({ method, params });
      if (method === 'repo/close') return {};
      if (method !== 'repo/discover') throw new Error(`unexpected ${method}`);
      const failure = options.fail?.(params.path);
      if (failure) throw failure;
      const fold = (value: string): string => value.replace(/\\/g, '/').toLowerCase();
      const target = fold(params.path);
      const hit = repos
        .filter((repo) => target === fold(repo.match) || target.startsWith(`${fold(repo.match)}/`))
        .sort((a, b) => b.match.length - a.match.length)[0];
      if (!hit) throw new EngineError(ErrorCodes.RepoNotFound, `could not find repository at '${params.path}'`);
      return { repoId: hit.id, rootPath: `${hit.root}/`, bare: false };
    },
  };
  const discovered = (): string[] =>
    requests.filter((request) => request.method === 'repo/discover').map((r) => r.params.path);
  return { engine: engine as unknown as EngineClient, requests, discovered };
}

function service(
  engine: EngineClient,
  options: RepositoryServiceOptions & { lines?: string[] } = {},
): RepositoryService {
  const lines = options.lines;
  return new RepositoryService(engine, {
    caseInsensitive: false,
    ...options,
    log: lines ? (line) => lines.push(line) : undefined,
  });
}

describe('RepositoryService aliased roots (windows)', () => {
  // The engine expands the 8.3 short name and reports forward slashes; VS
  // Code keeps the short name, backslashes and a lower-case drive letter.
  const engineRoot = 'C:/Users/runneradmin/AppData/Local/Temp/gitglasses-e2e-m8ni2x';
  const editorRoot = 'c:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\gitglasses-e2e-m8ni2x';
  const identify: IdentifyPath = (fsPath) => {
    const folded = fsPath
      .replace(/\//g, '\\')
      .replace(/\\+$/, '')
      .toLowerCase()
      .replace('\\runner~1\\', '\\runneradmin\\');
    return folded === engineRoot.replace(/\//g, '\\').toLowerCase()
      ? { dev: 9n, ino: 42n }
      : { dev: 9n, ino: BigInt(folded.length) };
  };
  const windows = (lines?: string[]): RepositoryServiceOptions & { lines?: string[] } => ({
    caseInsensitive: true,
    pathFlavor: path.win32,
    resolveAlias: identityAliasResolver(identify, path.win32),
    lines,
  });

  it('locates a file opened through the short name, in the editor spelling', async () => {
    const { engine } = fakeEngine([{ id: 'r1', root: engineRoot, match: editorRoot }]);
    const repos = service(engine, windows());

    const located = await repos.locateOrDiscover(fileUri(`${editorRoot}\\alpha.txt`));
    expect(located).toEqual({ repoId: 'r1', rootPath: editorRoot, relativePath: 'alpha.txt' });
    // Later lookups match synchronously, nested paths included.
    expect(repos.locate(fileUri(`${editorRoot}\\src\\a.ts`))?.relativePath).toBe('src/a.ts');
    // The engine's own spelling still locates.
    expect(repos.locate(fileUri(`${engineRoot}/alpha.txt`))?.rootPath).toBe(engineRoot);
  });

  it('matches the long name despite the drive-letter case and separators', async () => {
    const longEditorRoot = 'c:\\Users\\runneradmin\\AppData\\Local\\Temp\\gitglasses-e2e-m8ni2x';
    const { engine } = fakeEngine([{ id: 'r1', root: engineRoot, match: longEditorRoot }]);
    const repos = service(engine, windows());

    const located = await repos.locateOrDiscover(fileUri(`${longEditorRoot}\\alpha.txt`));
    expect(located).toEqual({ repoId: 'r1', rootPath: engineRoot, relativePath: 'alpha.txt' });
    expect(repos.repositories()[0].aliases).toEqual([]);
  });

  it('logs both paths when the root cannot be matched', async () => {
    const { engine } = fakeEngine([{ id: 'r1', root: engineRoot, match: editorRoot }]);
    const lines: string[] = [];
    const repos = service(engine, { ...windows(lines), resolveAlias: undefined });

    expect(await repos.locateOrDiscover(fileUri(`${editorRoot}\\alpha.txt`))).toBeUndefined();
    await repos.locateOrDiscover(fileUri(`${editorRoot}\\alpha.txt`));
    const warnings = lines.filter((line) => line.startsWith('warning:'));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(editorRoot);
    expect(warnings[0]).toContain(engineRoot);
  });
});

describe('RepositoryService aliased roots (posix)', () => {
  const tree: IdentifyPath = (fsPath) => {
    const resolved = fsPath.replace(/^\/home\/u\/link(?=\/|$)/, '/home/u/real');
    return { dev: 1n, ino: BigInt(resolved.length) + (resolved === '/home/u/real/repo' ? 1000n : 0n) };
  };

  it('learns the symlinked spelling once and keeps joined paths in it', async () => {
    const { engine, discovered } = fakeEngine([
      { id: 'r1', root: '/home/u/real/repo', match: '/home/u/link/repo' },
    ]);
    const lines: string[] = [];
    const repos = service(engine, { resolveAlias: identityAliasResolver(tree), lines });

    const located = await repos.locateOrDiscover(fileUri('/home/u/link/repo/src/a.ts'));
    expect(located).toEqual({
      repoId: 'r1',
      rootPath: '/home/u/link/repo',
      relativePath: 'src/a.ts',
    });
    expect(repos.repositories()).toEqual([
      { repoId: 'r1', rootPath: '/home/u/real/repo', aliases: ['/home/u/link/repo'] },
    ]);
    expect(lines).toEqual([
      'repository r1 at /home/u/real/repo',
      'repository r1 at /home/u/real/repo is open as /home/u/link/repo',
    ]);
    expect(repos.isRootOf('r1', '/home/u/link/repo/')).toBe(true);
    expect(repos.rootOf('r1')).toBe('/home/u/real/repo');

    await repos.locateOrDiscover(fileUri('/home/u/link/repo/src/b.ts'));
    expect(discovered()).toEqual(['/home/u/link/repo/src']);
  });

  it('keeps the aliases under the new id after an engine restart', async () => {
    let generation = 1;
    const engine = {
      async request(_method: string, params: { path: string }) {
        return { repoId: `r${generation}`, rootPath: '/home/u/real/repo/', bare: false, params };
      },
    } as unknown as EngineClient;
    const repos = service(engine, { resolveAlias: identityAliasResolver(tree) });
    await repos.locateOrDiscover(fileUri('/home/u/link/repo/a.ts'));

    generation = 2;
    await repos.rediscoverAll();
    expect(repos.locate(fileUri('/home/u/link/repo/a.ts'))).toEqual({
      repoId: 'r2',
      rootPath: '/home/u/link/repo',
      relativePath: 'a.ts',
    });
  });
});

describe('RepositoryService letter case', () => {
  it('defaults to case-insensitive matching on Windows and macOS', () => {
    expect(defaultCaseInsensitive('win32')).toBe(true);
    expect(defaultCaseInsensitive('darwin')).toBe(true);
    expect(defaultCaseInsensitive('linux')).toBe(false);
  });

  it('matches a root reported in the on-disk case when told paths ignore case', async () => {
    // macOS realpath(3) returns the on-disk case of every component.
    const { engine } = fakeEngine([
      { id: 'r1', root: '/Users/x/Projects/foo', match: '/Users/x/projects/Foo' },
    ]);
    const repos = service(engine, { caseInsensitive: true });

    const located = await repos.locateOrDiscover(fileUri('/Users/x/projects/Foo/Main.swift'));
    expect(located?.relativePath).toBe('Main.swift');
  });

  it('keeps the full relative path under a root whose case folding changes its length', async () => {
    const { engine } = fakeEngine([
      { id: 'r1', root: '/Users/x/İstanbul/repo', match: '/Users/x/İstanbul/repo' },
    ]);
    const repos = service(engine, { caseInsensitive: true });

    expect(await repos.locateOrDiscover(fileUri('/Users/x/İstanbul/repo/src/a.ts'))).toEqual({
      repoId: 'r1',
      rootPath: '/Users/x/İstanbul/repo',
      relativePath: 'src/a.ts',
    });
  });
});

describe('RepositoryService nested repositories', () => {
  // A parent with a submodule and a vendored clone below it.
  const layout = () => [
    { id: 'r1', root: '/w/parent', match: '/w/parent' },
    { id: 'r2', root: '/w/parent/sub', match: '/w/parent/sub' },
    { id: 'r3', root: '/w/parent/vendor/clone', match: '/w/parent/vendor/clone' },
  ];

  it('resolves a submodule file to the submodule once the parent is known', async () => {
    const { engine } = fakeEngine(layout());
    const repos = service(engine);

    expect((await repos.locateOrDiscover(fileUri('/w/parent/a.txt')))?.repoId).toBe('r1');
    expect(await repos.locateOrDiscover(fileUri('/w/parent/sub/lib.txt'))).toEqual({
      repoId: 'r2',
      rootPath: '/w/parent/sub',
      relativePath: 'lib.txt',
    });
    expect((await repos.locateOrDiscover(fileUri('/w/parent/vendor/clone/x/y.c')))?.repoId).toBe(
      'r3',
    );
    // Synchronous lookups agree once the directories have been answered.
    expect(repos.locate(fileUri('/w/parent/sub/lib.txt'))?.repoId).toBe('r2');
    expect(repos.locate(fileUri('/w/parent/b.txt'))?.repoId).toBe('r1');
  });

  it('asks the engine once per directory', async () => {
    const { engine, discovered } = fakeEngine(layout());
    const repos = service(engine);

    await Promise.all([
      repos.locateOrDiscover(fileUri('/w/parent/sub/a.txt')),
      repos.locateOrDiscover(fileUri('/w/parent/sub/b.txt')),
    ]);
    await repos.locateOrDiscover(fileUri('/w/parent/sub/c.txt'));
    await repos.locateOrDiscover(fileUri('/w/parent/d.txt'));
    expect(discovered()).toEqual(['/w/parent/sub', '/w/parent']);
  });

  it('keeps a directory the engine places in the parent there', async () => {
    // An uninitialized submodule is an empty directory of its parent.
    const { engine } = fakeEngine([{ id: 'r1', root: '/w/parent', match: '/w/parent' }]);
    const repos = service(engine);
    expect(await repos.locateOrDiscover(fileUri('/w/parent/sub/x.txt'))).toEqual({
      repoId: 'r1',
      rootPath: '/w/parent',
      relativePath: 'sub/x.txt',
    });
  });

  it('asks again after forgetDirectories, picking up a repository created since', async () => {
    const known = [{ id: 'r1', root: '/w/parent', match: '/w/parent' }];
    const { engine } = fakeEngine(known);
    const repos = service(engine);
    expect((await repos.locateOrDiscover(fileUri('/w/parent/sub/x.txt')))?.repoId).toBe('r1');

    known.push({ id: 'r2', root: '/w/parent/sub', match: '/w/parent/sub' });
    expect((await repos.locateOrDiscover(fileUri('/w/parent/sub/x.txt')))?.repoId).toBe('r1');
    repos.forgetDirectories();
    expect((await repos.locateOrDiscover(fileUri('/w/parent/sub/x.txt')))?.repoId).toBe('r2');
  });

  it('drops and releases a repository whose .git was removed', async () => {
    const known = layout();
    const { engine, requests } = fakeEngine(known);
    const repos = service(engine);
    await repos.locateOrDiscover(fileUri('/w/parent/a.txt'));
    await repos.locateOrDiscover(fileUri('/w/parent/sub/lib.txt'));

    let changes = 0;
    repos.onDidChangeRepositories(() => changes++);
    known.splice(1, 1);
    await repos.forgetRepositoriesAt('/w/parent/sub');

    expect(changes).toBe(1);
    expect(requests.at(-1)).toEqual({ method: 'repo/close', params: { repoId: 'r2' } });
    expect(repos.locate(fileUri('/w/parent/sub/lib.txt'))?.repoId).toBe('r1');
    expect((await repos.locateOrDiscover(fileUri('/w/parent/sub/lib.txt')))?.repoId).toBe('r1');
  });

  it('reports each new repository once', async () => {
    const { engine } = fakeEngine(layout());
    const repos = service(engine);
    let changes = 0;
    repos.onDidChangeRepositories(() => changes++);

    await repos.locateOrDiscover(fileUri('/w/parent/a.txt'));
    await repos.locateOrDiscover(fileUri('/w/parent/other/b.txt'));
    expect(changes).toBe(1);
    await repos.locateOrDiscover(fileUri('/w/parent/sub/c.txt'));
    expect(changes).toBe(2);
  });
});

describe('RepositoryService discovery failures', () => {
  it('remembers a directory in no repository for a while, and logs it once', async () => {
    const { engine, discovered } = fakeEngine([]);
    let now = 1000;
    const lines: string[] = [];
    const repos = service(engine, { now: () => now, lines });

    expect(await repos.locateOrDiscover(fileUri('/tmp/notes/a.txt'))).toBeUndefined();
    expect(await repos.locateOrDiscover(fileUri('/tmp/notes/b.txt'))).toBeUndefined();
    expect(discovered()).toHaveLength(1);

    now += NO_REPOSITORY_TTL_MS;
    await repos.locateOrDiscover(fileUri('/tmp/notes/a.txt'));
    expect(discovered()).toHaveLength(2);
    expect(lines).toEqual(['no repository contains /tmp/notes']);
    // "No repository" is an answer; a scan that only met those is complete.
    expect(repos.unansweredLookups()).toBe(0);
  });

  it('asks again after an engine that was not running, without logging', async () => {
    let running = false;
    const { engine, discovered } = fakeEngine([{ id: 'r1', root: '/w/r', match: '/w/r' }], {
      fail: () => (running ? undefined : new EngineRestartedError()),
    });
    const lines: string[] = [];
    const repos = service(engine, { lines });

    expect(await repos.locateOrDiscover(fileUri('/w/r/a.txt'))).toBeUndefined();
    expect(repos.unansweredLookups()).toBe(1);
    running = true;
    expect((await repos.locateOrDiscover(fileUri('/w/r/a.txt')))?.repoId).toBe('r1');
    expect(discovered()).toHaveLength(2);
    expect(lines).toEqual(['repository r1 at /w/r']);
    expect(repos.unansweredLookups()).toBe(1);
  });

  it('keeps an error the engine answered with as an answer for a while', async () => {
    // libgit2 cannot open a reftable repository; asking again gets the same.
    const message = 'unsupported extension name extensions.refstorage';
    const { engine, discovered } = fakeEngine([], {
      fail: () => new EngineError(ErrorCodes.GitError, message),
    });
    let now = 1000;
    const lines: string[] = [];
    const repos = service(engine, { now: () => now, lines });

    expect(await repos.locateOrDiscover(fileUri('/w/reftable/x.txt'))).toBeUndefined();
    expect(await repos.locateOrDiscover(fileUri('/w/reftable/y.txt'))).toBeUndefined();
    expect(discovered()).toEqual(['/w/reftable']);
    // A workspace scan that met it is complete and worth keeping.
    expect(repos.unansweredLookups()).toBe(0);
    expect(lines).toEqual([`repository discovery failed for /w/reftable: ${message}`]);

    now += NO_REPOSITORY_TTL_MS;
    await repos.locateOrDiscover(fileUri('/w/reftable/x.txt'));
    expect(discovered()).toHaveLength(2);
  });

  it('logs any other failure once and does not cache it', async () => {
    const { engine, discovered } = fakeEngine([], {
      fail: () => new Error("engine request 'repo/discover' timed out after 60000ms"),
    });
    const lines: string[] = [];
    const repos = service(engine, { lines });

    await repos.locateOrDiscover(fileUri('/w/r/a.txt'));
    await repos.locateOrDiscover(fileUri('/w/r/a.txt'));
    expect(discovered()).toHaveLength(2);
    expect(lines).toEqual([
      "repository discovery failed for /w/r: engine request 'repo/discover' timed out after 60000ms",
    ]);
  });
});
