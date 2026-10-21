import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import {
  DEFAULT_SCAN_SETTINGS,
  MAX_WORKSPACE_REPOSITORIES,
  collectWorkspaceRepos,
  findRepositoryFolders,
  parseGitmodulePaths,
  type DiscoveryHost,
  type FoundRepository,
  type ScanSettings,
} from '../src/model/repoDiscovery';

/**
 * An in-memory tree. Keys are directories; a `.git` value of 'dir' or 'file'
 * marks a repository root (a gitlink file for submodules and worktrees), and
 * '-> target' marks a symbolic link.
 */
type Tree = Record<string, Record<string, 'dir' | 'file' | `-> ${string}`>>;

interface FakeRepo {
  id: string;
  root: string;
}

function host(
  tree: Tree,
  repos: FakeRepo[],
  files: Record<string, string> = {},
  settings: Partial<ScanSettings> = {},
): DiscoveryHost & { listed: string[]; discovered: string[]; watched: string[] } {
  const listed: string[] = [];
  const discovered: string[] = [];
  const watched: string[] = [];
  return {
    listed,
    discovered,
    watched,
    async discover(dir, watch) {
      discovered.push(dir);
      if (watch) watched.push(dir);
      // The engine's upward search: the innermost repository containing dir.
      const hit = repos
        .filter((repo) => dir === repo.root || dir.startsWith(`${repo.root}/`))
        .sort((a, b) => b.root.length - a.root.length)[0];
      return hit && { repoId: hit.id, rootPath: hit.root };
    },
    async readDirectory(dir) {
      listed.push(dir);
      const entries = tree[dir];
      if (!entries) throw new Error(`ENOENT ${dir}`);
      return Object.entries(entries).map(([name, kind]) => ({
        name,
        isDirectory: kind === 'dir' || kind.startsWith('->'),
        isSymbolicLink: kind.startsWith('->'),
      }));
    },
    async readFile(file) {
      return files[file];
    },
    settings: () => ({ ...DEFAULT_SCAN_SETTINGS, ...settings }),
    join: path.posix.join,
    caseInsensitive: false,
  };
}

// ~/src holding two clones, one of them two levels down, next to the usual
// noise a scan must not descend into.
const srcTree: Tree = {
  '/home/u/src': {
    api: 'dir',
    web: 'dir',
    group: 'dir',
    node_modules: 'dir',
    link: '-> /home/u/src',
    'notes.txt': 'file',
  },
  '/home/u/src/api': { '.git': 'dir', src: 'dir' },
  '/home/u/src/api/.git': { HEAD: 'file' },
  '/home/u/src/api/src': {},
  '/home/u/src/web': { '.git': 'file', lib: 'dir' },
  '/home/u/src/web/lib': {},
  '/home/u/src/group': { deep: 'dir' },
  '/home/u/src/group/deep': { '.git': 'dir' },
  '/home/u/src/node_modules': { pkg: 'dir' },
  '/home/u/src/node_modules/pkg': { '.git': 'dir' },
};

describe('findRepositoryFolders', () => {
  it('finds repositories one level down by default', async () => {
    const fake = host(srcTree, []);
    expect(await findRepositoryFolders('/home/u/src', fake, DEFAULT_SCAN_SETTINGS)).toEqual([
      '/home/u/src/api',
      '/home/u/src/web',
    ]);
    // Neither .git, node_modules nor the symlink is listed.
    expect(fake.listed).not.toContain('/home/u/src/api/.git');
    expect(fake.listed).not.toContain('/home/u/src/node_modules');
    expect(fake.listed).not.toContain('/home/u/src/link');
  });

  it('goes deeper when the depth allows, and without limit at -1', async () => {
    const two = await findRepositoryFolders('/home/u/src', host(srcTree, []), {
      maxDepth: 2,
      ignoredFolders: ['node_modules'],
    });
    expect(two).toContain('/home/u/src/group/deep');
    const unlimited = await findRepositoryFolders('/home/u/src', host(srcTree, []), {
      maxDepth: -1,
      ignoredFolders: [],
    });
    expect(unlimited).toContain('/home/u/src/node_modules/pkg');
  });

  it('searches nothing at depth 0', async () => {
    const fake = host(srcTree, []);
    expect(
      await findRepositoryFolders('/home/u/src', fake, { maxDepth: 0, ignoredFolders: [] }),
    ).toEqual([]);
    expect(fake.listed).toEqual([]);
  });

  it('matches ignored folder names without case where paths ignore it', async () => {
    const tree: Tree = { 'C:/w': { Node_Modules: 'dir' }, 'C:/w/Node_Modules': { '.git': 'dir' } };
    const fake = { ...host(tree, []), caseInsensitive: true };
    expect(await findRepositoryFolders('C:/w', fake, DEFAULT_SCAN_SETTINGS)).toEqual([]);
  });

  it('skips directories it cannot list', async () => {
    const tree: Tree = { '/w': { locked: 'dir', open: 'dir' }, '/w/open': { '.git': 'dir' } };
    expect(await findRepositoryFolders('/w', host(tree, []), DEFAULT_SCAN_SETTINGS)).toEqual([
      '/w/open',
    ]);
  });
});

describe('parseGitmodulePaths', () => {
  it('reads every path, quoted or not, in order', () => {
    const text = [
      '[submodule "lib"]',
      '\tpath = libs/lib',
      '\turl = ../lib.git',
      '[submodule "spaced name"]',
      '\tpath = "third party/x" ',
      '[submodule "c"]',
      '  path=vendor/c ; trailing comment',
      '# path = commented/out',
    ].join('\r\n');
    expect(parseGitmodulePaths(text)).toEqual(['libs/lib', 'third party/x', 'vendor/c']);
  });

  it('drops paths that leave the repository', () => {
    const text =
      '\tpath = ../outside\n\tpath = /etc\n\tpath = C:/x\n\tpath = a/../../b\n\tpath = ok/';
    expect(parseGitmodulePaths(text)).toEqual(['ok']);
  });
});

describe('collectWorkspaceRepos', () => {
  it('lists the repositories below a folder that is not a repository itself', async () => {
    const fake = host(srcTree, [
      { id: 'r1', root: '/home/u/src/api' },
      { id: 'r2', root: '/home/u/src/web' },
    ]);
    expect(await collectWorkspaceRepos(['/home/u/src'], fake)).toEqual([
      { repoId: 'r1', rootPath: '/home/u/src/api' },
      { repoId: 'r2', rootPath: '/home/u/src/web' },
    ]);
  });

  it('puts each folder’s own repository first, once', async () => {
    const tree: Tree = {
      '/w/main': { nested: 'dir', '.git': 'dir' },
      '/w/main/nested': { '.git': 'dir' },
      '/w/other': { '.git': 'dir' },
    };
    const repos: FakeRepo[] = [
      { id: 'r1', root: '/w/main' },
      { id: 'r2', root: '/w/main/nested' },
      { id: 'r3', root: '/w/other' },
    ];
    const found = await collectWorkspaceRepos(
      ['/w/main', '/w/other', '/w/main'],
      host(tree, repos),
    );
    expect(found.map((repo: FoundRepository) => repo.repoId)).toEqual(['r1', 'r3', 'r2']);
  });

  it('adds submodules from .gitmodules, nested ones included', async () => {
    const tree: Tree = { '/w/app': { '.git': 'dir' } };
    const repos: FakeRepo[] = [
      { id: 'r1', root: '/w/app' },
      { id: 'r2', root: '/w/app/libs/core' },
      { id: 'r3', root: '/w/app/libs/core/third/zlib' },
    ];
    const files = {
      '/w/app/.gitmodules':
        '[submodule "core"]\n\tpath = libs/core\n[submodule "docs"]\n\tpath = docs\n',
      '/w/app/libs/core/.gitmodules': '[submodule "zlib"]\n\tpath = third/zlib\n',
    };
    const fake = host(tree, repos, files);
    const found = await collectWorkspaceRepos(['/w/app'], fake);
    // docs is not initialized: it resolves to the parent, already listed.
    expect(found.map((repo) => repo.repoId)).toEqual(['r1', 'r2', 'r3']);
    expect(fake.discovered).toContain('/w/app/docs');
  });

  it('follows git.detectSubmodules and git.detectSubmodulesLimit', async () => {
    const tree: Tree = { '/w/app': { '.git': 'dir' } };
    const repos: FakeRepo[] = [
      { id: 'r1', root: '/w/app' },
      { id: 'r2', root: '/w/app/a' },
      { id: 'r3', root: '/w/app/b' },
    ];
    const files = { '/w/app/.gitmodules': '\tpath = a\n\tpath = b\n' };
    const off = await collectWorkspaceRepos(
      ['/w/app'],
      host(tree, repos, files, { detectSubmodules: false }),
    );
    expect(off.map((repo) => repo.repoId)).toEqual(['r1']);
    const limited = await collectWorkspaceRepos(
      ['/w/app'],
      host(tree, repos, files, { submoduleLimit: 1 }),
    );
    expect(limited.map((repo) => repo.repoId)).toEqual(['r1', 'r2']);
  });

  it('watches only the folders’ own repositories', async () => {
    const tree: Tree = {
      '/w/main': { nested: 'dir', '.git': 'dir' },
      '/w/main/nested': { '.git': 'dir' },
      '/w/other': {},
    };
    const repos: FakeRepo[] = [
      { id: 'r1', root: '/w/main' },
      { id: 'r2', root: '/w/main/nested' },
      { id: 'r3', root: '/w/main/sub' },
    ];
    const files = { '/w/main/.gitmodules': '\tpath = sub\n' };
    const fake = host(tree, repos, files);
    const found = await collectWorkspaceRepos(['/w/main', '/w/other'], fake);
    expect(found.map((repo) => repo.repoId)).toEqual(['r1', 'r2', 'r3']);
    expect(fake.watched).toEqual(['/w/main', '/w/other']);
  });

  it('asks the engine about no more repositories than it lists', async () => {
    // ~/src holding far more clones than the list keeps.
    const clones = Array.from({ length: 500 }, (_, index) => `clone${index}`);
    const tree: Tree = { '/home/u/src': Object.fromEntries(clones.map((name) => [name, 'dir'])) };
    for (const name of clones) tree[`/home/u/src/${name}`] = { '.git': 'dir' };
    const repos = clones.map((name, index) => ({ id: `r${index}`, root: `/home/u/src/${name}` }));
    const fake = host(tree, repos);

    const found = await collectWorkspaceRepos(['/home/u/src'], fake);
    expect(found).toHaveLength(MAX_WORKSPACE_REPOSITORIES);
    // The folder itself, then one lookup per listed repository.
    expect(fake.discovered).toHaveLength(MAX_WORKSPACE_REPOSITORIES + 1);
  });

  it('stops asking once the limit is reached, submodules included', async () => {
    const tree: Tree = {
      '/w/app': { a: 'dir', b: 'dir', c: 'dir', '.git': 'dir' },
      '/w/app/a': { '.git': 'dir' },
      '/w/app/b': {},
      '/w/app/c': { '.git': 'dir' },
    };
    const repos: FakeRepo[] = [
      { id: 'r1', root: '/w/app' },
      { id: 'r2', root: '/w/app/a' },
      { id: 'r3', root: '/w/app/c' },
      { id: 'r4', root: '/w/app/s1' },
      { id: 'r5', root: '/w/app/s2' },
    ];
    const files = { '/w/app/.gitmodules': '\tpath = s1\n\tpath = s2\n' };
    const fake = host(tree, repos, files);

    const found = await collectWorkspaceRepos(['/w/app'], fake, 4);
    expect(found.map((repo) => repo.repoId)).toEqual(['r1', 'r2', 'r3', 'r4']);
    expect(fake.discovered).toEqual(['/w/app', '/w/app/a', '/w/app/c', '/w/app/s1']);
  });

  it('survives a folder the engine cannot place', async () => {
    const fake = host({ '/w/empty': {} }, []);
    fake.discover = async () => {
      throw new Error('engine down');
    };
    expect(await collectWorkspaceRepos(['/w/empty'], fake)).toEqual([]);
  });
});
