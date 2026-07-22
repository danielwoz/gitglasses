import { describe, expect, it } from 'vitest';
import { UNCOMMITTED_SHA, type GraphRow, type RequestResult } from '@gitglasses/protocol';
import type { PullRequest } from '@gitglasses/integrations';
import {
  formatBlame,
  formatCommitShow,
  formatCommits,
  formatGraph,
  formatHistory,
  formatLaunchpad,
  formatStatus,
  parsePatchSource,
} from '../src/format.js';

const sig = (name: string, time: number) => ({ name, email: `${name}@example.com`, time });

// 2024-05-01T00:00:00Z
const T = 1714521600;

describe('formatBlame', () => {
  const commits = {
    ['a'.repeat(40)]: {
      author: sig('Alice', T),
      committer: sig('Alice', T),
      summary: 'Add parser',
      boundary: false,
    },
    ['b'.repeat(40)]: {
      author: sig('Bob', T + 86400),
      committer: sig('Bob', T + 86400),
      summary: 'Fix edge case',
      boundary: false,
    },
  };
  const hunks = [
    { sha: 'a'.repeat(40), resultLine: 1, originalLine: 1, lineCount: 3, path: 'src/a.ts' },
    { sha: 'b'.repeat(40), resultLine: 4, originalLine: 1, lineCount: 1, path: 'src/a.ts' },
    { sha: UNCOMMITTED_SHA, resultLine: 5, originalLine: 5, lineCount: 2, path: 'src/a.ts' },
  ];

  it('renders one line per hunk with range, sha7, author, date and summary', () => {
    const text = formatBlame('src/a.ts', hunks, commits);
    expect(text.split('\n')).toEqual([
      'blame src/a.ts',
      'L1-3 aaaaaaa Alice 2024-05-01 Add parser',
      'L4 bbbbbbb Bob 2024-05-02 Fix edge case',
      'L5-6 uncommitted',
    ]);
  });

  it('filters to the hunk covering a single line', () => {
    const text = formatBlame('src/a.ts', hunks, commits, 4);
    expect(text).toBe('blame src/a.ts:4\nL4 bbbbbbb Bob 2024-05-02 Fix edge case');
  });

  it('reports when no hunk covers the requested line', () => {
    expect(formatBlame('src/a.ts', hunks, commits, 99)).toBe('No blame hunk covers src/a.ts:99');
  });
});

describe('formatGraph', () => {
  const row = (partial: Partial<GraphRow>): GraphRow => ({
    sha: 'c'.repeat(40),
    parents: [],
    lane: 0,
    laneEdges: [],
    author: sig('Alice', T),
    time: T,
    summary: 'commit',
    refs: [],
    kind: 'commit',
    ...partial,
  });

  it('indents rows by lane and renders sha7 + summary', () => {
    const text = formatGraph([
      row({ sha: '1'.repeat(40), lane: 0, summary: 'main tip' }),
      row({ sha: '2'.repeat(40), lane: 1, summary: 'feature work' }),
      row({ sha: '3'.repeat(40), lane: 0, summary: 'base' }),
    ]);
    expect(text.split('\n')).toEqual([
      '* 1111111 main tip',
      '  * 2222222 feature work',
      '* 3333333 base',
    ]);
  });

  it('renders refs with HEAD marker and upstream ahead/behind', () => {
    const text = formatGraph([
      row({
        sha: '4'.repeat(40),
        summary: 'tip',
        refs: [
          {
            name: 'main',
            kind: 'head',
            upstream: { name: 'origin/main', ahead: 1, behind: 2 },
          },
          { name: 'v1.0', kind: 'tag' },
        ],
      }),
    ]);
    expect(text).toBe('* 4444444 tip (HEAD:main -> origin/main +1/-2, v1.0)');
  });

  it('marks stash and wip rows distinctly', () => {
    const text = formatGraph([
      row({ sha: '5'.repeat(40), kind: 'stash', summary: 'WIP on main' }),
      row({ sha: '6'.repeat(40), kind: 'wip', lane: 1, summary: 'uncommitted changes' }),
    ]);
    expect(text.split('\n')).toEqual([
      's 5555555 WIP on main',
      '  w 6666666 uncommitted changes',
    ]);
  });
});

describe('formatStatus', () => {
  const base: RequestResult<'status/summary'> = {
    branch: 'main',
    ahead: 0,
    behind: 0,
    staged: [],
    unstaged: [],
    untracked: [],
    conflicted: [],
  };

  it('renders a clean tree', () => {
    expect(formatStatus(base)).toBe('branch: main\nworking tree clean');
  });

  it('renders upstream tracking and all change sections', () => {
    const text = formatStatus({
      ...base,
      upstream: 'origin/main',
      ahead: 2,
      behind: 1,
      staged: [{ path: 'src/a.ts', status: 'M', additions: 3, deletions: 1 }],
      unstaged: [
        { path: 'src/new.ts', status: 'R', origPath: 'src/old.ts', additions: 5, deletions: 0 },
      ],
      untracked: ['notes.txt'],
      conflicted: ['src/b.ts'],
    });
    expect(text.split('\n')).toEqual([
      'branch: main -> origin/main (ahead 2, behind 1)',
      'staged (1):',
      '  M  src/a.ts (+3 -1)',
      'unstaged (1):',
      '  R  src/old.ts -> src/new.ts (+5 -0)',
      'untracked (1):',
      '  notes.txt',
      'conflicted (1):',
      '  src/b.ts',
    ]);
  });
});

describe('formatCommits / formatHistory / formatCommitShow', () => {
  it('renders commit summaries as sha7 author date summary', () => {
    const text = formatCommits([
      {
        sha: 'd'.repeat(40),
        parents: [],
        author: sig('Alice', T),
        committer: sig('Alice', T),
        summary: 'Initial commit',
      },
    ]);
    expect(text).toBe('ddddddd Alice 2024-05-01 Initial commit');
  });

  it('marks renamed history entries with the historical path', () => {
    const text = formatHistory('src/new.ts', [
      {
        sha: 'e'.repeat(40),
        author: sig('Bob', T),
        summary: 'Rename module',
        path: 'src/new.ts',
        additions: 1,
        deletions: 1,
      },
      {
        sha: 'f'.repeat(40),
        author: sig('Alice', T),
        summary: 'Create module',
        path: 'src/old.ts',
        additions: 10,
        deletions: 0,
      },
    ]);
    expect(text.split('\n')).toEqual([
      'history src/new.ts',
      'eeeeeee Bob 2024-05-01 Rename module (+1 -1)',
      'fffffff Alice 2024-05-01 Create module (+10 -0) (as src/old.ts)',
    ]);
  });

  it('renders commit metadata and changed files with +/- counts', () => {
    const text = formatCommitShow(
      {
        sha: 'a'.repeat(40),
        parents: ['b'.repeat(40)],
        author: sig('Alice', T),
        committer: sig('Alice', T),
        summary: 'Refactor',
      },
      [
        { path: 'src/a.ts', status: 'M', additions: 4, deletions: 2 },
        { path: 'src/b.ts', status: 'A', additions: 20, deletions: 0 },
      ],
    );
    expect(text.split('\n')).toEqual([
      `commit ${'a'.repeat(40)}`,
      'author: Alice <Alice@example.com> 2024-05-01',
      'parents: bbbbbbb',
      'summary: Refactor',
      '',
      'files (2):',
      '  M  src/a.ts (+4 -2)',
      '  A  src/b.ts (+20 -0)',
    ]);
  });
});

describe('parsePatchSource', () => {
  it('parses wip, stash and commit sources', () => {
    expect(parsePatchSource('wip')).toEqual({ kind: 'wip', includeUntracked: true });
    expect(parsePatchSource('stash:2')).toEqual({ kind: 'stash', index: 2 });
    expect(parsePatchSource('commit:abc123f')).toEqual({ kind: 'commit', sha: 'abc123f' });
  });

  it('rejects malformed sources', () => {
    expect(() => parsePatchSource('stash:x')).toThrow(/Invalid patch source/);
    expect(() => parsePatchSource('branch:main')).toThrow(/Invalid patch source/);
  });
});

describe('formatLaunchpad', () => {
  const pr = (partial: Partial<PullRequest>): PullRequest => ({
    id: '1',
    number: 7,
    title: 'Fix login',
    url: 'https://github.com/o/r/pull/7',
    state: 'open',
    draft: false,
    author: { id: 'alice', username: 'alice' },
    baseRef: 'main',
    headRef: 'fix-login',
    headSha: 'a'.repeat(40),
    repo: { provider: 'github', host: 'github.com', owner: 'o', name: 'r' },
    createdAt: '2024-05-01T00:00:00Z',
    updatedAt: '2024-05-02T00:00:00Z',
    viewerRole: 'author',
    reviewRequestedFromViewer: false,
    ...partial,
  });

  it('renders bucket headers with one line per pull request', () => {
    const text = formatLaunchpad([
      { bucket: 'needs-your-review', items: [pr({ number: 12, title: 'Add cache' })] },
      { bucket: 'waiting', items: [pr({})] },
    ]);
    expect(text.split('\n')).toEqual([
      'needs-your-review (1):',
      '  #12 Add cache [o/r] by alice https://github.com/o/r/pull/7',
      'waiting (1):',
      '  #7 Fix login [o/r] by alice https://github.com/o/r/pull/7',
    ]);
  });
});
