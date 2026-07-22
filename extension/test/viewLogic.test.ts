import { describe, expect, it } from 'vitest';
import {
  aggregateContributors,
  appendPage,
  commitDescription,
  emptyPageState,
  findShaMatches,
  formatCommitDoc,
  historyEntryDiffSpec,
  isFullOrAbbreviatedSha,
} from '../src/views/viewLogic';

const author = (name: string, email: string, time: number) => ({ name, email, time });

describe('paging cursor accumulation', () => {
  it('appends pages and tracks the latest cursor', () => {
    let state = emptyPageState<number>();
    expect(state.loaded).toBe(false);

    state = appendPage(state, { items: [1, 2, 3], nextCursor: 'c1' });
    expect(state.items).toEqual([1, 2, 3]);
    expect(state.nextCursor).toBe('c1');
    expect(state.loaded).toBe(true);

    state = appendPage(state, { items: [4, 5], nextCursor: 'c2' });
    expect(state.items).toEqual([1, 2, 3, 4, 5]);
    expect(state.nextCursor).toBe('c2');
  });

  it('clears the cursor when the last page has none', () => {
    let state = appendPage(emptyPageState<string>(), { items: ['a'], nextCursor: 'c1' });
    state = appendPage(state, { items: ['b'] });
    expect(state.items).toEqual(['a', 'b']);
    expect(state.nextCursor).toBeUndefined();
  });

  it('marks an empty repo as loaded so it is not refetched', () => {
    const state = appendPage(emptyPageState<string>(), { items: [] });
    expect(state.loaded).toBe(true);
    expect(state.items).toEqual([]);
    expect(state.nextCursor).toBeUndefined();
  });
});

describe('history entry diff spec', () => {
  const sha = 'aabbccddeeff00112233445566778899aabbccdd';

  it('diffs sha~1 against sha for the same repo and title includes the path', () => {
    const spec = historyEntryDiffSpec('repo-1', { sha, path: 'src/app.ts' });
    expect(spec.left).toEqual({ repoId: 'repo-1', path: 'src/app.ts', rev: `${sha}~1` });
    expect(spec.right).toEqual({ repoId: 'repo-1', path: 'src/app.ts', rev: sha });
    expect(spec.title).toBe('src/app.ts (aabbccdd~1 ↔ aabbccdd)');
  });

  it('uses the entry path at that commit (rename-aware), not the current path', () => {
    const spec = historyEntryDiffSpec('repo-1', { sha, path: 'old/name.ts' });
    expect(spec.left.path).toBe('old/name.ts');
    expect(spec.right.path).toBe('old/name.ts');
  });
});

describe('contributor aggregation', () => {
  it('groups by email case-insensitively and counts commits', () => {
    const stats = aggregateContributors([
      { author: author('Ada', 'ada@example.com', 100) },
      { author: author('Ada L.', 'ADA@Example.com', 300) },
      { author: author('Bob', 'bob@example.com', 200) },
    ]);
    expect(stats).toHaveLength(2);
    expect(stats[0].email).toBe('ada@example.com');
    expect(stats[0].count).toBe(2);
    expect(stats[1].email).toBe('bob@example.com');
    expect(stats[1].count).toBe(1);
  });

  it('takes the display name from the most recent commit', () => {
    const stats = aggregateContributors([
      { author: author('Old Name', 'x@example.com', 10) },
      { author: author('New Name', 'x@example.com', 999) },
      { author: author('Middle Name', 'x@example.com', 500) },
    ]);
    expect(stats[0].name).toBe('New Name');
    expect(stats[0].lastTime).toBe(999);
  });

  it('sorts by commit count descending', () => {
    const stats = aggregateContributors([
      { author: author('A', 'a@x.com', 1) },
      { author: author('B', 'b@x.com', 2) },
      { author: author('B', 'b@x.com', 3) },
      { author: author('B', 'b@x.com', 4) },
      { author: author('A', 'a@x.com', 5) },
    ]);
    expect(stats.map((s) => s.name)).toEqual(['B', 'A']);
    expect(stats.map((s) => s.count)).toEqual([3, 2]);
  });

  it('returns an empty list for no commits', () => {
    expect(aggregateContributors([])).toEqual([]);
  });
});

describe('terminal sha matching', () => {
  it('matches 7-40 character lowercase hex runs with positions', () => {
    const line = 'commit deadbee and 0123456789abcdef0123456789abcdef01234567 done';
    const matches = findShaMatches(line);
    expect(matches).toEqual([
      { sha: 'deadbee', startIndex: 7, length: 7 },
      { sha: '0123456789abcdef0123456789abcdef01234567', startIndex: 19, length: 40 },
    ]);
  });

  it('rejects 6-character hex runs', () => {
    expect(findShaMatches('short abc123 run')).toEqual([]);
  });

  it('rejects 41-character hex runs', () => {
    expect(findShaMatches('x '.concat('a'.repeat(41)))).toEqual([]);
  });

  it('rejects non-hex words and hex embedded in longer words', () => {
    expect(findShaMatches('gigantic terminal wordsalad')).toEqual([]);
    expect(findShaMatches('deadbeefs')).toEqual([]); // trailing non-hex letter
    expect(findShaMatches('xdeadbeef')).toEqual([]); // leading non-hex letter
  });

  it('validates a whole-string sha', () => {
    expect(isFullOrAbbreviatedSha('deadbee')).toBe(true);
    expect(isFullOrAbbreviatedSha('deadbe')).toBe(false);
    expect(isFullOrAbbreviatedSha('fix login')).toBe(false);
    expect(isFullOrAbbreviatedSha('a'.repeat(41))).toBe(false);
  });
});

describe('commit rendering', () => {
  const commit = {
    sha: 'aabbccddeeff00112233445566778899aabbccdd',
    parents: ['1111111111111111111111111111111111111111'],
    author: author('Ada', 'ada@example.com', 1_700_000_000),
    committer: author('Ada', 'ada@example.com', 1_700_000_000),
    summary: 'Fix the flux capacitor',
  };

  it('describes a commit as shortSha author relative-date', () => {
    const now = 1_700_000_000 + 3 * 24 * 60 * 60;
    expect(commitDescription(commit, now)).toBe('aabbccdd Ada 3 days ago');
  });

  it('renders a plain-text commit doc with sha, author, date, and summary', () => {
    const doc = formatCommitDoc(commit);
    expect(doc).toContain(`commit  ${commit.sha}`);
    expect(doc).toContain('parents 1111111111111111111111111111111111111111');
    expect(doc).toContain('author  Ada <ada@example.com>');
    expect(doc).toContain('date    ');
    expect(doc).toContain('Fix the flux capacitor');
  });
});
