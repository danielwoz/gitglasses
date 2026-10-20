import { describe, expect, it } from 'vitest';
import {
  BranchStatus,
  HeadInfo,
  branchActionLabel,
  branchCardActions,
  branchCardDescription,
  branchCardTitle,
  formatAheadBehind,
  formatDirtySummary,
  glimpsePrs,
  showGetStarted,
  walkthroughTabState,
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

describe('branch card for each kind of HEAD', () => {
  const head = (overrides: Partial<HeadInfo> = {}): HeadInfo => ({
    branch: 'main',
    oid: 'c0ffee0000000000000000000000000000000000',
    detached: false,
    unborn: false,
    ...overrides,
  });

  it('names the branch of an empty repository instead of calling it detached', () => {
    const unborn = head({ branch: 'main', oid: '', unborn: true });
    const fresh = status({ branch: 'main', upstream: undefined, untracked: ['a.txt'] });
    expect(branchCardTitle(fresh, unborn)).toBe('main');
    expect(branchCardDescription(fresh, unborn)).toBe('no commits yet · 1 untracked');
    expect(branchCardTitle(status({ branch: '' }), head({ branch: '', unborn: true }))).toBe(
      'No commits yet',
    );
  });

  it('offers only the first commit while the branch is unborn', () => {
    const unborn = head({ oid: '', unborn: true });
    expect(branchCardActions(status({ upstream: undefined }), unborn, true)).toEqual(['commit']);
  });

  it('labels a detached HEAD by its commit and offers no push or pull', () => {
    const detached = head({ branch: '', detached: true });
    const s = status({ branch: '', upstream: undefined });
    expect(branchCardTitle(s, detached)).toBe('HEAD detached at c0ffee0');
    expect(branchCardDescription(s, detached)).toBe('no branch · clean');
    expect(branchCardActions(s, detached, true)).toEqual(['commit', 'switchBranch', 'createBranch']);
  });

  it('offers Push only with commits to push, and Pull with an upstream', () => {
    expect(branchCardActions(status(), head(), true)).toEqual([
      'commit',
      'pull',
      'switchBranch',
      'createBranch',
    ]);
    expect(branchCardActions(status({ ahead: 2 }), head(), true)).toEqual([
      'commit',
      'push',
      'pull',
      'switchBranch',
      'createBranch',
    ]);
  });

  it('publishes a branch without an upstream when there is a remote to publish to', () => {
    const local = status({ upstream: undefined });
    expect(branchCardActions(local, head(), true)).toContain('publish');
    expect(branchCardActions(local, head(), false)).toEqual([
      'commit',
      'switchBranch',
      'createBranch',
    ]);
  });

  it('counts the commits Push and Pull would move', () => {
    const s = status({ ahead: 1, behind: 3 });
    expect(branchActionLabel('push', s)).toBe('Push 1 commit');
    expect(branchActionLabel('pull', s)).toBe('Pull 3 commits');
    expect(branchActionLabel('pull', status())).toBe('Pull');
    expect(branchActionLabel('publish', s)).toBe('Publish Branch');
  });
});

describe('walkthroughTabState', () => {
  it('recognises our walkthrough, the Welcome editor showing another, and anything else', () => {
    expect(walkthroughTabState('Walkthrough: Get Started with GitGlasses')).toBe('shown');
    expect(walkthroughTabState('Walkthrough: Setup VS Code Web')).toBe('welcome');
    expect(walkthroughTabState('Welcome')).toBe('welcome');
    expect(walkthroughTabState('app.ts')).toBe('elsewhere');
    expect(walkthroughTabState(undefined)).toBe('elsewhere');
  });
});
