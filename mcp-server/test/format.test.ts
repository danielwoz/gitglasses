import { describe, expect, it } from 'vitest';
import { UNCOMMITTED_SHA, type GraphRow, type RequestResult } from '@gitglasses/protocol';
import type { PullRequest } from '@gitglasses/integrations';
import {
  binaryPathsInPatch,
  explainEngineError,
  formatBlame,
  formatCommitShow,
  formatCommits,
  formatDiff,
  formatGraph,
  formatHistory,
  formatLaunchpad,
  formatPatchEnvelope,
  formatRefs,
  formatStatus,
  parsePatchEnvelopeText,
  parsePatchSource,
  truncateText,
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

  // git attributes a whole binary file to one "line", which is otherwise
  // indistinguishable from real line authorship.
  it('labels a binary file on the header line', () => {
    const binary = [
      { sha: 'a'.repeat(40), resultLine: 1, originalLine: 1, lineCount: 1, path: 'logo.png' },
    ];
    expect(formatBlame('logo.png', binary, commits, undefined, true).split('\n')).toEqual([
      'blame logo.png (binary; the whole file is one hunk, not line authorship)',
      'L1 aaaaaaa Alice 2024-05-01 Add parser',
    ]);
  });
});

describe('formatDiff', () => {
  const hunk = {
    header: '@@ -1,2 +1,3 @@',
    oldStart: 1,
    oldLines: 2,
    newStart: 1,
    newLines: 3,
    lines: [' one', '-two', '+TWO', '+three'],
  };

  it('renders a file header line then its unified hunks, with counts from the hunks', () => {
    const text = formatDiff('unstaged', [{ path: 'a.txt', status: 'M', hunks: [hunk] }]);
    expect(text.split('\n')).toEqual([
      'diff unstaged (1 file):',
      'M  a.txt (+2 -1)',
      '@@ -1,2 +1,3 @@',
      ' one',
      '-two',
      '+TWO',
      '+three',
    ]);
  });

  it('marks a binary file instead of rendering an empty diff', () => {
    expect(
      formatDiff('unstaged', [{ path: 'logo.png', status: 'M', hunks: [], binary: true }]),
    ).toBe('diff unstaged (1 file):\nM  logo.png (binary)');
  });

  it('names the remaining ambiguity when a file has no hunks and is not binary', () => {
    expect(formatDiff('staged', [{ path: 'run.sh', status: 'M', hunks: [] }])).toBe(
      'diff staged (1 file):\nM  run.sh (no text diff; binary or mode change)',
    );
  });

  it('marks the pre-rename path and untracked files', () => {
    const text = formatDiff('unstaged', [
      { path: 'new.ts', origPath: 'old.ts', status: 'R', hunks: [] },
      { path: 'notes.txt', status: '?', hunks: [hunk] },
    ]);
    expect(text.split('\n')[1]).toBe('R  old.ts -> new.ts (no text diff; binary or mode change)');
    expect(text.split('\n')[2]).toBe('?  notes.txt (+2 -1)');
  });

  it('names the scope and the file in its empty states', () => {
    expect(formatDiff('staged', [])).toBe('No staged changes');
    expect(formatDiff('unstaged', [], 'a.txt')).toBe('No unstaged changes in a.txt');
  });

  // A footer is the first thing a character limit drops, so the count of files
  // left out has to survive on the first line.
  it('reports files left out on the header line', () => {
    const text = formatDiff('unstaged', [{ path: 'a.txt', status: 'M', hunks: [hunk] }], undefined, 66);
    expect(text.split('\n')[0]).toBe(
      'diff unstaged (showing 1 of 66 changed files; pass "file" to diff one of them):',
    );
  });
});

describe('formatRefs', () => {
  it('renders branches, remote branches and tags one per line', () => {
    const text = formatRefs({
      branches: [
        { name: 'main', sha: 'a'.repeat(40), current: true, upstream: 'origin/main' },
        { name: 'feature/x', sha: 'b'.repeat(40), current: false },
      ],
      remotes: [{ name: 'origin', branches: [{ name: 'main', sha: 'a'.repeat(40) }] }],
      tags: [{ name: 'v1.0', sha: 'c'.repeat(40) }],
    });
    expect(text.split('\n')).toEqual([
      'branches (2):',
      '  main aaaaaaa (current) -> origin/main',
      '  feature/x bbbbbbb',
      'remote origin (1):',
      '  origin/main aaaaaaa',
      'tags (1):',
      '  v1.0 ccccccc',
    ]);
  });

  it('names the subject when there are no refs', () => {
    expect(formatRefs({ branches: [], remotes: [], tags: [] })).toBe(
      'No branches, remote branches or tags',
    );
  });
});

describe('binary detection helpers', () => {
  it('reads binary paths off a unified diff', () => {
    const patch =
      'diff --git a/a.txt b/a.txt\n@@ -1 +1 @@\n-one\n+two\n' +
      'diff --git a/logo.png b/logo.png\nBinary files a/logo.png and b/logo.png differ\n' +
      'diff --git a/new.bin b/new.bin\nBinary files /dev/null and b/new.bin differ\n';
    expect([...binaryPathsInPatch(patch)]).toEqual(['logo.png', 'new.bin']);
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

  // status/summary leaves branch empty for both, so without the head state an
  // empty repository and a detached HEAD render as a healthy branch.
  it('names an unborn HEAD rather than an empty branch', () => {
    const head = { oid: '', branch: '', detached: false, unborn: true };
    expect(formatStatus({ ...base, branch: '' }, head)).toBe(
      'branch: (no commits yet)\nworking tree clean',
    );
  });

  it('names a detached HEAD and the commit it sits on', () => {
    const head = { oid: 'f'.repeat(40), branch: '', detached: true, unborn: false };
    expect(formatStatus({ ...base, branch: '' }, head)).toBe(
      'branch: (detached at fffffff)\nworking tree clean',
    );
  });

  // status/summary never computes them, so "(+0 -0)" is noise on every line.
  it('omits line counts the status result does not carry', () => {
    const text = formatStatus({
      ...base,
      staged: [{ path: 'src/a.ts', status: 'M', additions: 0, deletions: 0 }],
    });
    expect(text).toContain('  M  src/a.ts');
    expect(text).not.toContain('+0 -0');
  });
});

describe('explainEngineError', () => {
  it('drops git CLI usage text, which names no action', () => {
    const raw =
      "git rev-parse HEAD failed (128): fatal: ambiguous argument 'HEAD': unknown revision\n" +
      "Use '--' to separate paths from revisions, like this:\n" +
      "'git <command> [<revision>...] -- [<file>...]'";
    const text = explainEngineError(raw, { repoPath: '/w/repo' });
    expect(text).toBe(
      '/w/repo is a git repository with no commits yet; blame, diff, log and patch need at least one commit',
    );
  });

  it('names the missing repository and what repoPath should be', () => {
    expect(
      explainEngineError("discover repository from /w: could not find repository at '/w'", {
        repoPath: '/w',
      }),
    ).toBe('no git repository at or above /w; pass repoPath as a path inside a git working tree');
  });

  it('turns an untracked path into the tool that would list paths', () => {
    expect(
      explainEngineError("git blame failed (128): fatal: no such path 'x.ts' in HEAD", {
        repoPath: '/w/repo',
      }),
    ).toMatch(/^x\.ts is not tracked at HEAD; call git_status/);
  });

  it('turns a bad revision into the tools that would find one', () => {
    expect(
      explainEngineError("resolve 'nope': revspec 'nope' not found", { repoPath: '/w/repo' }),
    ).toMatch(/^no such revision "nope"; call git_refs/);
  });

  // repo/discover walks upward and canonicalises, so the engine names paths the
  // agent never supplied.
  it('rewrites resolved paths back to the path the caller supplied', () => {
    expect(
      explainEngineError('something broke in /data/real/repo/sub', {
        repoPath: '~/link',
        resolvedPaths: ['/data/real/repo/sub'],
      }),
    ).toBe('something broke in ~/link');
  });

  it('leaves an unrecognised message intact apart from the plumbing prefix', () => {
    expect(
      explainEngineError('git merge-base failed (1): fatal: refusing to merge unrelated histories', {
        repoPath: '/w/repo',
      }),
    ).toBe('refusing to merge unrelated histories');
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

  // git reports a binary change as +0 -0, the same as a mode-only change.
  it('marks binary paths and appends the diff when one is supplied', () => {
    const text = formatCommitShow(
      {
        sha: 'a'.repeat(40),
        parents: [],
        author: sig('Alice', T),
        committer: sig('Alice', T),
        summary: 'Add logo',
      },
      [
        { path: 'logo.png', status: 'M', additions: 0, deletions: 0 },
        { path: 'mode.sh', status: 'M', additions: 0, deletions: 0 },
      ],
      { binaryPaths: new Set(['logo.png']), diff: 'diff --git a/logo.png b/logo.png\n' },
    );
    expect(text.split('\n').slice(5)).toEqual([
      'files (2):',
      '  M  logo.png (binary)',
      '  M  mode.sh (+0 -0)',
      '',
      'diff:',
      'diff --git a/logo.png b/logo.png',
    ]);
  });

  it('names the subject of an empty commit list', () => {
    expect(formatCommits([], 'No commits on this branch')).toBe('No commits on this branch');
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

describe('truncateText', () => {
  const text = 'one\ntwo\nthree\n';

  it('returns text that fits unchanged', () => {
    expect(truncateText(text, 100, 'raise it')).toBe(text);
  });

  it('cuts on a line boundary and names the limit', () => {
    expect(truncateText(text, 8, 'raise it')).toBe(
      'one\ntwo\n\n(truncated to 8 characters; raise it)',
    );
  });

  it('cuts mid-line when the first line already exceeds the limit', () => {
    expect(truncateText('averylongline\nnext', 5, 'raise it')).toBe(
      'avery\n\n(truncated to 5 characters; raise it)',
    );
  });
});

describe('patch envelope rendering', () => {
  const envelope = {
    format: 'gitglasses-patch',
    version: 1,
    baseSha: 'c'.repeat(40),
    branch: 'feature/x',
    summary: 'Fix the parser',
    patch: 'diff --git a/a.txt b/a.txt\n@@ -1 +1 @@\n-one\n+two\n',
    createdAtIso: '2024-05-01T00:00:00Z',
  } as const;

  it('renders metadata as lines and the patch with real newlines', () => {
    const text = formatPatchEnvelope(envelope);
    expect(text.split('\n').slice(0, 7)).toEqual([
      'format: "gitglasses-patch"',
      'version: 1',
      `baseSha: "${'c'.repeat(40)}"`,
      'branch: "feature/x"',
      'summary: "Fix the parser"',
      'createdAtIso: "2024-05-01T00:00:00Z"',
      '--- patch ---',
    ]);
    expect(text).toContain('\n-one\n+two\n');
    expect(text).not.toContain('\\n');
  });

  it('omits fields the envelope does not carry', () => {
    const { branch: _branch, ...rest } = envelope;
    expect(formatPatchEnvelope(rest)).not.toContain('branch:');
  });

  it('round-trips through parsePatchEnvelopeText', () => {
    expect(parsePatchEnvelopeText(formatPatchEnvelope(envelope))).toEqual(envelope);
  });

  it('round-trips a multi-line summary', () => {
    const multiline = { ...envelope, summary: 'Fix the parser\n\nand the lexer' };
    expect(parsePatchEnvelopeText(formatPatchEnvelope(multiline))).toEqual(multiline);
  });

  it('refuses a truncated rendering', () => {
    const text = truncateText(formatPatchEnvelope(envelope), 140, 'pass a higher "maxChars"');
    expect(() => parsePatchEnvelopeText(text)).toThrow(/truncated/);
  });

  it('rejects text that is not a rendering', () => {
    expect(() => parsePatchEnvelopeText('nothing to see')).toThrow(/--- patch ---/);
  });
});
