// git_compare: its rendering, and its answers against the real engine on a
// branch that diverged from main, served with and without git.

import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CommitSummaryInfo, RequestResult } from '@gitglasses/protocol';
import type { EngineClient } from '@gitglasses/rpc';
import { createEngineClient, resolveEnginePath } from '../src/engine.js';
import { createToolHandlers, type ToolHandlers } from '../src/server.js';
import { formatCompare } from '../src/tools/compare.js';

const sha = (c: string) => c.repeat(40);
const commit = (c: string, summary: string): CommitSummaryInfo => ({
  sha: sha(c),
  parents: [],
  author: { name: 'Alice', email: 'alice@example.com', time: 1714521600 },
  committer: { name: 'Alice', email: 'alice@example.com', time: 1714521600 },
  summary,
});
const compared = (
  partial: Partial<RequestResult<'log/compare'>>,
): RequestResult<'log/compare'> => ({
  base: sha('b'),
  head: sha('h'),
  mergeBase: sha('m'),
  ahead: 0,
  behind: 0,
  commits: [],
  ...partial,
});

describe('formatCompare', () => {
  it('names the merge base, the distance and the head-only commits and files', () => {
    const text = formatCompare({
      baseName: 'main',
      headName: 'feature',
      compared: compared({
        ahead: 2,
        behind: 3,
        commits: [commit('c', 'Two'), commit('d', 'One')],
      }),
      files: [
        { path: 'src/a.ts', status: 'M', additions: 4, deletions: 1 },
        { path: 'img.png', status: 'A', additions: 0, deletions: 0 },
      ],
      binaryPaths: new Set(['img.png']),
    });
    expect(text.split('\n')).toEqual([
      'compare main...feature',
      'base: main bbbbbbb, head: feature hhhhhhh, merge base: mmmmmmm',
      'feature is 2 commits ahead of main and 3 behind',
      'the 3 commits only on main are left out of the files below, which start at the merge base',
      '',
      'commits on feature not on main (2):',
      '  ccccccc Alice 2024-05-01 Two',
      '  ddddddd Alice 2024-05-01 One',
      '',
      'files changed on feature since the merge base (2):',
      '  M  src/a.ts (+4 -1)',
      '  A  img.png (binary)',
    ]);
  });

  it('says how to see the commits it left out', () => {
    const text = formatCompare({
      baseName: 'main',
      headName: 'HEAD',
      compared: compared({ ahead: 120, commits: [commit('c', 'Newest')] }),
      files: [],
    });
    expect(text).toContain('HEAD is 120 commits ahead of main and 0 behind');
    expect(text).toContain('  (showing the newest 1; raise "limit" (max 500) for more)');
  });

  it('compares unrelated histories tree to tree, and says so', () => {
    const text = formatCompare({
      baseName: 'main',
      headName: 'orphan',
      compared: compared({
        mergeBase: undefined,
        ahead: 1,
        behind: 1,
        commits: [commit('c', 'x')],
      }),
      files: [{ path: 'a', status: 'D', additions: 0, deletions: 2 }],
    });
    expect(text).toContain('merge base: none');
    expect(text).toContain('share no commit');
    expect(text).toContain('files changed on orphan since main (1):');
  });

  it('stops at "same commit" when there is nothing between them', () => {
    expect(
      formatCompare({
        baseName: 'main',
        headName: 'HEAD',
        compared: compared({ base: sha('a'), head: sha('a'), mergeBase: sha('a') }),
        files: [],
      }).split('\n')[2],
    ).toBe('HEAD and main point at the same commit');
  });

  it('appends the diff, or why it was left out', () => {
    const base = {
      baseName: 'main',
      headName: 'HEAD',
      compared: compared({ ahead: 1, commits: [commit('c', 'x')] }),
      files: [{ path: 'a', status: 'M' as const, additions: 1, deletions: 0 }],
    };
    expect(formatCompare({ ...base, diff: 'diff --git a/a b/a\n+x\n' })).toMatch(
      /\n\ndiff:\ndiff --git a\/a b\/a\n\+x$/,
    );
    expect(formatCompare({ ...base, diffOmitted: 'needs git' })).toMatch(
      /\n\n\(diff omitted: needs git\)$/,
    );
  });
});

const enginePath = resolveEnginePath({ packageRoot: path.resolve(import.meta.dirname, '..') });

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

describe.skipIf(!enginePath)('git_compare against the engine', () => {
  let repoDir: string;
  let full: EngineClient;
  let restricted: EngineClient;
  let trusted: ToolHandlers;
  let readOnly: ToolHandlers;

  // main: base -> main-only change to shared.txt; feature: base -> feature.txt
  // added and app.txt edited. A two-tree diff of main..feature would show the
  // main-only change reverted.
  beforeAll(async () => {
    repoDir = await mkdtemp(path.join(os.tmpdir(), 'gitglasses-mcp-compare-'));
    git(repoDir, 'init', '-b', 'main');
    git(repoDir, 'config', 'user.name', 'Test Author');
    git(repoDir, 'config', 'user.email', 'test@example.com');
    git(repoDir, 'config', 'core.autocrlf', 'false');
    git(repoDir, 'config', 'commit.gpgsign', 'false');
    await writeFile(path.join(repoDir, 'shared.txt'), 'one\n');
    await writeFile(path.join(repoDir, 'app.txt'), 'a\nb\n');
    git(repoDir, 'add', '.');
    git(repoDir, 'commit', '-m', 'Base');
    git(repoDir, 'checkout', '-b', 'feature');
    await writeFile(path.join(repoDir, 'feature.txt'), 'new\n');
    git(repoDir, 'add', '.');
    git(repoDir, 'commit', '-m', 'Add feature file');
    await writeFile(path.join(repoDir, 'app.txt'), 'a\nB\nc\n');
    git(repoDir, 'commit', '-am', 'Edit app');
    git(repoDir, 'checkout', 'main');
    await writeFile(path.join(repoDir, 'shared.txt'), 'one\ntwo\n');
    git(repoDir, 'commit', '-am', 'Main only');
    git(repoDir, 'checkout', 'feature');

    full = createEngineClient({ enginePath });
    restricted = createEngineClient({ enginePath, restricted: true });
    trusted = createToolHandlers({ client: full, allow: [repoDir], env: {} });
    readOnly = createToolHandlers({
      client: full,
      restrictedClient: restricted,
      clientRoots: async () => [repoDir],
      env: {},
    });
  }, 30000);

  afterAll(async () => {
    full?.dispose();
    restricted?.dispose();
    if (repoDir) await rm(repoDir, { recursive: true, force: true });
  });

  it('lists only what the branch changed since it left main', async () => {
    const text = await trusted.git_compare({ repoPath: repoDir, base: 'main' });
    expect(text).toContain(`merge base: ${git(repoDir, 'merge-base', 'main', 'HEAD').slice(0, 7)}`);
    expect(text).toContain('HEAD is 2 commits ahead of main and 1 behind');
    expect(text).toMatch(
      /commits on HEAD not on main \(2\):\n {2}[0-9a-f]{7} Test Author \S+ Edit app\n {2}[0-9a-f]{7} Test Author \S+ Add feature file/,
    );
    expect(text).toContain('files changed on HEAD since the merge base (2):');
    expect(text).toContain('A  feature.txt (+1 -0)');
    expect(text).toContain('M  app.txt (+2 -1)');
    // main's own change is not reported as reverted by the branch.
    expect(text).not.toContain('shared.txt');
  });

  it('includes the diff from the merge base on request', async () => {
    const text = await trusted.git_compare({
      repoPath: repoDir,
      base: 'main',
      head: 'feature',
      includeDiff: true,
    });
    expect(text).toContain('\ndiff:\n');
    expect(text).toContain('+++ b/feature.txt');
    expect(text).toContain('+B');
    expect(text).not.toContain('shared.txt');
  });

  it('compares the other way round as the branch that is behind', async () => {
    const text = await trusted.git_compare({ repoPath: repoDir, base: 'feature', head: 'main' });
    expect(text).toContain('main is 1 commit ahead of feature and 2 behind');
    expect(text).toContain('M  shared.txt (+1 -0)');
    expect(text).not.toContain('feature.txt (');
  });

  it('works without git, leaving out only the diff', async () => {
    const text = await readOnly.git_compare({ repoPath: repoDir, base: 'main', includeDiff: true });
    expect(text).toContain('HEAD is 2 commits ahead of main and 1 behind');
    expect(text).toContain('A  feature.txt (+1 -0)');
    expect(text).toContain('(diff omitted: git_compare needs git for rendering the diff');
  });

  // A blobless clone of the repository: where git may run it downloads the
  // contents from the clone's remote (here a local path), as git does; read
  // without git, the counts are reported as unknown rather than as zero.
  it('counts lines in a partial clone by downloading, or says they are unknown', async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), 'gitglasses-mcp-partial-'));
    try {
      git(repoDir, 'config', 'uploadpack.allowFilter', 'true');
      const clone = path.join(parent, 'clone');
      // A plain path would copy the objects and ignore the filter.
      const url = pathToFileURL(repoDir).href;
      git(parent, 'clone', '--quiet', '--filter=blob:none', '--no-checkout', url, clone);
      const promisorPacks = (): number =>
        git(clone, 'count-objects', '-v')
          .split('\n')
          .filter((line) => line.startsWith('packs:'))
          .map((line) => Number(line.split(' ')[1]))[0];

      const withoutGit = createToolHandlers({
        client: full,
        restrictedClient: restricted,
        read: [clone],
        env: {},
      });
      const unknown = await withoutGit.git_compare({
        repoPath: clone,
        base: 'origin/main',
        head: 'origin/feature',
      });
      expect(unknown).toContain('A  feature.txt (+? -?: contents not in this partial clone)');
      const before = promisorPacks();

      const withGit = createToolHandlers({ client: full, allow: [clone], env: {} });
      const counted = await withGit.git_compare({
        repoPath: clone,
        base: 'origin/main',
        head: 'origin/feature',
      });
      expect(counted).toContain('A  feature.txt (+1 -0)');
      expect(counted).toContain('M  app.txt (+2 -1)');
      expect(promisorPacks()).toBeGreaterThan(before);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('names an unknown revision and where to find a valid one', async () => {
    await expect(trusted.git_compare({ repoPath: repoDir, base: 'nope' })).rejects.toThrow(
      /no such revision "nope"; call git_refs/,
    );
  });

  it('truncates at maxChars with a footer', async () => {
    const text = await trusted.git_compare({
      repoPath: repoDir,
      base: 'main',
      includeDiff: true,
      maxChars: 300,
    });
    expect(text).toMatch(/\(truncated to 300 characters; .*omit "includeDiff"/);
  });
});
