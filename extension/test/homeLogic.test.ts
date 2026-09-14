import { describe, expect, it } from 'vitest';
import {
  BranchStatus,
  branchCardDescription,
  formatAheadBehind,
  formatDirtySummary,
  glimpsePrs,
  showGetStarted,
} from '../src/home/homeLogic';

function status(overrides: Partial<BranchStatus> = {}): BranchStatus {
  return {
    branch: 'main',
    upstream: 'origin/main',
    ahead: 0,
    behind: 0,
    staged: [],
    unstaged: [],
    untracked: [],
    conflicted: [],
    ...overrides,
  };
}

describe('formatAheadBehind', () => {
  it('is empty when in sync', () => {
    expect(formatAheadBehind(0, 0)).toBe('');
  });

  it('formats ahead, behind, and both', () => {
    expect(formatAheadBehind(2, 0)).toBe('↑2');
    expect(formatAheadBehind(0, 3)).toBe('↓3');
    expect(formatAheadBehind(2, 3)).toBe('↑2 ↓3');
  });
});

describe('formatDirtySummary', () => {
  it('reports clean when nothing changed', () => {
    expect(formatDirtySummary(status())).toBe('clean');
  });

  it('lists only non-zero counts', () => {
    expect(
      formatDirtySummary(status({ staged: [1, 2, 3], untracked: ['a'] })),
    ).toBe('3 staged, 1 untracked');
    expect(
      formatDirtySummary(status({ staged: [1], unstaged: [1, 2], untracked: ['a'] })),
    ).toBe('1 staged, 2 unstaged, 1 untracked');
  });
});

describe('branchCardDescription', () => {
  it('joins arrows, upstream, and dirty summary', () => {
    expect(
      branchCardDescription(status({ ahead: 2, behind: 1, staged: [1] })),
    ).toBe('↑2 ↓1 · origin/main · 1 staged');
  });

  it('omits arrows when in sync and notes a missing upstream', () => {
    expect(branchCardDescription(status({ upstream: undefined }))).toBe('no upstream · clean');
  });
});

describe('glimpsePrs', () => {
  const groups = [
    { bucket: 'mergeable', items: ['m1', 'm2'] },
    { bucket: 'needs-your-review', items: ['r1'] },
    { bucket: 'blocked', items: ['b1'] },
    { bucket: 'waiting', items: ['w1'] },
  ];

  it('orders blocked before needs-your-review before the rest', () => {
    expect(glimpsePrs(groups)).toEqual([
      { bucket: 'blocked', item: 'b1' },
      { bucket: 'needs-your-review', item: 'r1' },
      { bucket: 'mergeable', item: 'm1' },
    ]);
  });

  it('caps the result at three by default', () => {
    const many = [{ bucket: 'blocked', items: ['b1', 'b2', 'b3', 'b4'] }];
    expect(glimpsePrs(many)).toHaveLength(3);
  });

  it('returns everything when there are fewer than the cap', () => {
    expect(glimpsePrs([{ bucket: 'waiting', items: ['w1'] }])).toEqual([
      { bucket: 'waiting', item: 'w1' },
    ]);
    expect(glimpsePrs([])).toEqual([]);
  });

  it('never includes snoozed items', () => {
    expect(
      glimpsePrs([
        { bucket: 'snoozed', items: ['s1', 's2'] },
        { bucket: 'waiting', items: ['w1'] },
      ]),
    ).toEqual([{ bucket: 'waiting', item: 'w1' }]);
  });

  it('honors a custom limit', () => {
    expect(glimpsePrs(groups, 5)).toHaveLength(5);
  });
});

describe('showGetStarted', () => {
  it('shows until dismissed', () => {
    expect(showGetStarted(undefined)).toBe(true);
    expect(showGetStarted(false)).toBe(true);
    expect(showGetStarted(true)).toBe(false);
  });
});
