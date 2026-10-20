// The workspace's repository list: what the scan finds on disk, what opening
// files adds, how the Git extension's settings and .git events change it,
// and which repository the views act on.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type * as vscode from 'vscode';

vi.mock('vscode', () => import('./support/fakeVscode'));

import { controls, Uri } from './support/fakeVscode';
import { fakeEngine, type FakeRepo } from './support/fakeEngine';
import { ErrorCodes } from '@gitglasses/protocol';
import { EngineError, EngineRestartedError } from '@gitglasses/rpc';
import { RepositoryService } from '../src/model/repositoryService';
import { identityAliasResolver } from '../src/model/pathAliases';
import { nodeFileIdentity } from '../src/model/nodeFileIdentity';
import { ACTIVE_REPO_KEY, ActiveRepoManager } from '../src/model/activeRepo';
import { MAX_WORKSPACE_REPOSITORIES } from '../src/model/repoDiscovery';

let root: string;
const managers: ActiveRepoManager[] = [];

/** Creates directories below the test root; a path ending in /.git marks a
 *  repository, and a [path, text] pair writes a file. */
function layout(...entries: (string | [string, string])[]): void {
  for (const entry of entries) {
    if (typeof entry === 'string') {
      fs.mkdirSync(path.join(root, entry), { recursive: true });
    } else {
      fs.mkdirSync(path.dirname(path.join(root, entry[0])), { recursive: true });
      fs.writeFileSync(path.join(root, entry[0]), entry[1]);
    }
  }
}

/** A repository the fake engine knows, rooted at `dir` below the test root. */
function repo(id: string, dir: string): FakeRepo {
  const full = path.join(root, dir);
  return { id, root: full, match: full };
}

function memento(values: Record<string, unknown> = {}): vscode.Memento {
  return {
    get: (key: string) => values[key],
    update: async (key: string, value: unknown) => {
      values[key] = value;
    },
    keys: () => Object.keys(values),
  } as unknown as vscode.Memento;
}

function manager(
  engine: ReturnType<typeof fakeEngine>,
  state: vscode.Memento = memento(),
): { repos: RepositoryService; active: ActiveRepoManager } {
  const repos = new RepositoryService(engine.engine, { caseInsensitive: false });
  const active = new ActiveRepoManager(repos, state);
  managers.push(active);
  return { repos, active };
}

function names(list: readonly { name: string }[]): string[] {
  return list.map((entry) => entry.name);
}

/** Resolves true on the manager's next change announcement, or false when
 *  none comes within a few settle periods. */
function nextChange(active: ActiveRepoManager): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      subscription.dispose();
      resolve(false);
    }, 3000);
    const subscription = active.onDidChange(() => {
      clearTimeout(timer);
      subscription.dispose();
      resolve(true);
    });
  });
}

function file(relative: string): vscode.Uri {
  return Uri.file(path.join(root, relative)) as unknown as vscode.Uri;
}

beforeEach(() => {
  controls.reset();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-active-repo-'));
  controls.folders = [root];
});

afterEach(() => {
  for (const active of managers.splice(0)) active.dispose();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('ActiveRepoManager list', () => {
  it('lists the folder repository first, then repositories below it and submodules', async () => {
    layout('.git', 'api/.git', 'node_modules/dep/.git', 'libs/core/.git', [
      '.gitmodules',
      '[submodule "core"]\n\tpath = libs/core\n',
    ]);
    const engine = fakeEngine([
      repo('r1', ''),
      repo('r2', 'api'),
      repo('r3', 'libs/core'),
      repo('r4', 'node_modules/dep'),
    ]);
    const { active } = manager(engine);

    const list = await active.all();
    expect(list.map((entry) => entry.repoId)).toEqual(['r1', 'r2', 'r3']);
    expect(names(list)).toEqual([path.basename(root), 'api', 'core']);
    // Only the folder's own repository is watched while merely listed.
    expect(engine.discoveries().filter((request) => request.params.watch !== false)).toHaveLength(
      1,
    );
  });

  it('adds a repository reached by opening a file in it', async () => {
    // Three levels down: deeper than the default scan depth of one.
    layout('.git', 'a/b/deep/.git');
    const engine = fakeEngine([repo('r1', ''), repo('r2', 'a/b/deep')]);
    const { repos, active } = manager(engine);
    expect((await active.all()).map((entry) => entry.repoId)).toEqual(['r1']);

    const changed = nextChange(active);
    expect((await repos.locateOrDiscover(file('a/b/deep/x.txt')))?.repoId).toBe('r2');
    expect((await active.all()).map((entry) => entry.repoId)).toEqual(['r1', 'r2']);
    expect(await changed).toBe(true);
  });

  it(`keeps the list within ${MAX_WORKSPACE_REPOSITORIES} repositories`, async () => {
    const count = MAX_WORKSPACE_REPOSITORIES + 5;
    const fakeRepos: FakeRepo[] = [];
    for (let index = 0; index < count; index++) {
      layout(`clone${index}/.git`);
      fakeRepos.push(repo(`r${index}`, `clone${index}`));
    }
    const engine = fakeEngine(fakeRepos);
    const { repos, active } = manager(engine);

    const listed = await active.all();
    expect(listed).toHaveLength(MAX_WORKSPACE_REPOSITORIES);
    expect(engine.discovered().length).toBeLessThanOrEqual(MAX_WORKSPACE_REPOSITORIES + 1);
    // Repositories the scan left out still resolve when a file in one opens,
    // but the list does not grow past the bound.
    const left = fakeRepos.filter((known) => !listed.some((entry) => entry.repoId === known.id));
    expect(left).toHaveLength(5);
    const located = await Promise.all(
      left.map((known) => repos.locateOrDiscover(file(`${path.basename(known.root)}/a.txt`))),
    );
    expect(located.map((entry) => entry?.repoId)).toEqual(left.map((known) => known.id));
    expect(await active.all()).toHaveLength(MAX_WORKSPACE_REPOSITORIES);
  });

  it('keeps a scan that met a repository the engine refused', async () => {
    layout('.git', 'reftable/.git', 'ok/.git');
    const engine = fakeEngine([repo('r1', ''), repo('r2', 'ok')], {
      fail: (dir) =>
        dir === path.join(root, 'reftable')
          ? new EngineError(ErrorCodes.GitError, 'unsupported extension name extensions.refstorage')
          : undefined,
    });
    const { active } = manager(engine);

    expect((await active.all()).map((entry) => entry.repoId)).toEqual(['r1', 'r2']);
    const lookups = engine.discovered().length;
    await active.all();
    await active.resolve();
    expect(engine.discovered()).toHaveLength(lookups);
  });

  it('scans again after a scan the engine did not answer', async () => {
    layout('.git');
    let running = false;
    const engine = fakeEngine([repo('r1', '')], {
      fail: () => (running ? undefined : new EngineRestartedError()),
    });
    const { active } = manager(engine);

    expect(await active.all()).toEqual([]);
    running = true;
    expect((await active.all()).map((entry) => entry.repoId)).toEqual(['r1']);
  });
});

describe('ActiveRepoManager settings', () => {
  // A submodule two levels down, out of reach of the default scan depth.
  beforeEach(() =>
    layout('.git', 'one/.git', 'one/two/.git', 'vendor/lib/.git', 'libs/core/.git', [
      '.gitmodules',
      '\tpath = libs/core\n',
    ]),
  );

  const all = () =>
    fakeEngine([
      repo('r1', ''),
      repo('r2', 'one'),
      repo('r3', 'one/two'),
      repo('r4', 'vendor/lib'),
      repo('r5', 'libs/core'),
    ]);

  /** The ids listed: the folder's own first, the rest in any order, since the
   *  scan follows the directory listing's order. */
  const ids = (list: readonly { repoId: string }[]): string[] => [
    list[0]?.repoId,
    ...list
      .slice(1)
      .map((entry) => entry.repoId)
      .sort(),
  ];

  it('searches as deep as git.repositoryScanMaxDepth, skipping ignored folders', async () => {
    controls.settings.set('git.repositoryScanMaxDepth', 2);
    controls.settings.set('git.repositoryScanIgnoredFolders', ['vendor']);
    const { active } = manager(all());
    expect(ids(await active.all())).toEqual(['r1', 'r2', 'r3', 'r5']);
  });

  it('searches no subfolders when git.autoRepositoryDetection is off for them', async () => {
    controls.settings.set('git.autoRepositoryDetection', 'openEditors');
    controls.settings.set('git.detectSubmodules', false);
    const { active } = manager(all());
    expect(ids(await active.all())).toEqual(['r1']);
  });

  it('scans again when one of those settings changes', async () => {
    controls.settings.set('git.detectSubmodules', false);
    const { active } = manager(all());
    expect(ids(await active.all())).toEqual(['r1', 'r2']);

    const changed = nextChange(active);
    controls.settings.set('git.detectSubmodules', true);
    controls.changeSettings('git.detectSubmodules');
    expect(await changed).toBe(true);
    expect(ids(await active.all())).toEqual(['r1', 'r2', 'r5']);
  });
});

describe('ActiveRepoManager .git events', () => {
  it('lists a repository created in the workspace and drops one whose .git is deleted', async () => {
    layout('.git', 'fresh');
    const known = [repo('r1', '')];
    const engine = fakeEngine(known);
    const { repos, active } = manager(engine);
    expect((await active.all()).map((entry) => entry.repoId)).toEqual(['r1']);
    expect((await repos.locateOrDiscover(file('fresh/a.txt')))?.repoId).toBe('r1');

    // git init in fresh/
    layout('fresh/.git');
    known.push(repo('r2', 'fresh'));
    let changed = nextChange(active);
    controls.created.fire(Uri.file(path.join(root, 'fresh', '.git')));
    expect(await changed).toBe(true);
    expect((await active.all()).map((entry) => entry.repoId)).toEqual(['r1', 'r2']);
    expect((await repos.locateOrDiscover(file('fresh/a.txt')))?.repoId).toBe('r2');

    // rm -rf fresh/.git
    fs.rmSync(path.join(root, 'fresh', '.git'), { recursive: true });
    known.pop();
    changed = nextChange(active);
    controls.deleted.fire(Uri.file(path.join(root, 'fresh', '.git')));
    expect(await changed).toBe(true);
    expect(engine.requests).toContainEqual({ method: 'repo/close', params: { repoId: 'r2' } });
    expect((await active.all()).map((entry) => entry.repoId)).toEqual(['r1']);
    expect((await repos.locateOrDiscover(file('fresh/a.txt')))?.repoId).toBe('r1');
  });
});

describe('ActiveRepoManager selection', () => {
  it('acts on the stored choice and watches it', async () => {
    layout('.git', 'api/.git');
    const engine = fakeEngine([repo('r1', ''), repo('r2', 'api')]);
    const { repos, active } = manager(
      engine,
      memento({ [ACTIVE_REPO_KEY]: path.join(root, 'api') }),
    );

    expect((await active.resolve())?.repoId).toBe('r2');
    expect(repos.isWatched('r2')).toBe(true);
    expect(engine.discoveries().at(-1)?.params).toEqual({ path: path.join(root, 'api') });
  });

  it('gives the root in the spelling the workspace was opened with', async () => {
    // The workspace folder is a symlink; the engine reports the real path.
    layout('real/.git', 'real/nested/.git');
    const link = path.join(root, 'link');
    fs.symlinkSync(
      path.join(root, 'real'),
      link,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    controls.folders = [link];
    const fake = fakeEngine([
      { id: 'r1', root: path.join(root, 'real'), match: path.join(root, 'real') },
      { id: 'r1', root: path.join(root, 'real'), match: link },
      { id: 'r2', root: path.join(root, 'real/nested'), match: path.join(link, 'nested') },
    ]);
    const repos = new RepositoryService(fake.engine, {
      caseInsensitive: false,
      resolveAlias: identityAliasResolver(nodeFileIdentity),
    });
    const active = new ActiveRepoManager(repos, memento());
    managers.push(active);

    expect(await active.all()).toEqual([
      { repoId: 'r1', rootPath: path.join(root, 'real'), workspacePath: link, name: 'link' },
      {
        repoId: 'r2',
        rootPath: path.join(root, 'real/nested'),
        workspacePath: path.join(link, 'nested'),
        name: 'nested',
      },
    ]);
    expect((await active.resolve())?.workspacePath).toBe(link);
  });

  it('selects a repository by its root, and only one the workspace has', async () => {
    layout('.git', 'api/.git');
    const engine = fakeEngine([repo('r1', ''), repo('r2', 'api')]);
    const { active } = manager(engine);
    expect((await active.resolve())?.repoId).toBe('r1');

    const changed = nextChange(active);
    await active.select(path.join(root, 'api'));
    expect(await changed).toBe(true);
    expect((await active.resolve())?.repoId).toBe('r2');

    await active.select(path.join(root, 'elsewhere'));
    expect((await active.resolve())?.repoId).toBe('r2');
    expect(controls.messages.at(-1)).toContain('no repository in this workspace is rooted at');
  });

  it('falls back to the folder repository when the stored choice is gone', async () => {
    layout('.git');
    const engine = fakeEngine([repo('r1', '')]);
    const { active } = manager(engine, memento({ [ACTIVE_REPO_KEY]: '/elsewhere/repo' }));
    expect((await active.resolve())?.repoId).toBe('r1');
  });
});
