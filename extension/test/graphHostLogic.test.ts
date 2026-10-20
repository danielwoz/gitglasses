import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MAX_LANES,
  MAX_REPLACE_ROWS,
  branchOptions,
  findQueries,
  isStaleCursorError,
  liveFilter,
  localNameFor,
  maxLanesSetting,
  refreshFor,
  replaceLimit,
  stashIndexOf,
} from '../src/webviews/graphHostLogic';

const SHA = 'a'.repeat(40);

describe('refreshFor', () => {
  it('reloads the rows when refs, HEAD or stashes move', () => {
    expect(refreshFor(['index', 'refs'])).toBe('replace');
    expect(refreshFor(['HEAD'])).toBe('replace');
    expect(refreshFor(['stash'])).toBe('replace');
  });

  it('only rechecks the WIP row on an index change', () => {
    expect(refreshFor(['index'])).toBe('wip');
  });

  it('ignores the rest', () => {
    expect(refreshFor(['worktrees', 'sequencer'])).toBe('none');
  });
});

describe('replaceLimit', () => {
  it('reloads as many rows as are loaded, at least one page, at most the cap', () => {
    expect(replaceLimit(0, 200)).toBe(200);
    expect(replaceLimit(1400, 200)).toBe(1400);
    expect(replaceLimit(MAX_REPLACE_ROWS * 3, 200)).toBe(MAX_REPLACE_ROWS);
  });
});

describe('isStaleCursorError', () => {
  it('recognizes the engine refusing an old cursor', () => {
    expect(
      isStaleCursorError(
        new Error('stale cursor: the refs changed since the first page; request it again'),
      ),
    ).toBe(true);
    expect(isStaleCursorError(new Error('invalid cursor'))).toBe(false);
  });
});

describe('branchOptions', () => {
  const refs = {
    branches: [
      { name: 'zeta', sha: SHA, current: false },
      { name: 'main', sha: SHA, current: true },
      { name: 'alpha', sha: SHA, current: false },
    ],
    remotes: [
      {
        name: 'origin',
        branches: [
          { name: 'main', sha: SHA },
          { name: 'feature/x', sha: SHA },
        ],
      },
      { name: 'up/stream', branches: [{ name: 'dev', sha: SHA }] },
    ],
    tags: [],
  };

  it('lists the current branch first, then local and remote branches by name', () => {
    expect(branchOptions(refs).map((option) => [option.name, option.ref, option.current])).toEqual([
      ['main', 'refs/heads/main', true],
      ['alpha', 'refs/heads/alpha', false],
      ['zeta', 'refs/heads/zeta', false],
      ['origin/feature/x', 'refs/remotes/origin/feature/x', false],
      ['origin/main', 'refs/remotes/origin/main', false],
      ['up/stream/dev', 'refs/remotes/up/stream/dev', false],
    ]);
  });

  it('drops filtered branches that no longer exist', () => {
    const options = branchOptions(refs);
    expect(liveFilter(undefined, options)).toBeUndefined();
    expect(liveFilter(['refs/heads/main', 'refs/heads/gone'], options)).toEqual([
      'refs/heads/main',
    ]);
    expect(liveFilter(['refs/heads/gone'], options)).toBeUndefined();
  });
});

describe('findQueries', () => {
  it('searches message and author, and sha when the text looks like one', () => {
    expect(findQueries(' parser ')).toEqual([{ text: 'parser' }, { author: 'parser' }]);
    expect(findQueries('ABC123')).toEqual([
      { text: 'ABC123' },
      { author: 'ABC123' },
      { sha: 'abc123' },
    ]);
    expect(findQueries('   ')).toEqual([]);
  });
});

describe('stashIndexOf / localNameFor / maxLanesSetting', () => {
  it('reads the stash index from a stash row ref', () => {
    expect(stashIndexOf([{ name: 'stash@{3}', kind: 'stash' }])).toBe(3);
    expect(stashIndexOf([{ name: 'main', kind: 'branch' }])).toBeUndefined();
  });

  it('names the local branch a remote branch checks out as', () => {
    expect(localNameFor('origin/feature/x', ['origin'])).toBe('feature/x');
    expect(localNameFor('up/stream/dev', ['up', 'up/stream'])).toBe('dev');
    expect(localNameFor('origin/main')).toBe('main');
  });

  it('clamps the lane cap setting', () => {
    expect(maxLanesSetting(undefined)).toBe(DEFAULT_MAX_LANES);
    expect(maxLanesSetting(1)).toBe(4);
    expect(maxLanesSetting(1000)).toBe(200);
    expect(maxLanesSetting(12.4)).toBe(12);
  });
});
