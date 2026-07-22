import { describe, expect, it } from 'vitest';
import {
  confirmBranchDelete,
  confirmBranchForceDelete,
  confirmCherryPick,
  confirmMerge,
  confirmRebase,
  confirmResetHard,
  confirmRevert,
  confirmStashDrop,
  confirmWorktreeForceRemove,
  confirmWorktreeRemove,
} from '../src/commands/confirmations';

const SHA_A = 'abc1234def0000000000000000000000000000aa';
const SHA_B = '9876543fed0000000000000000000000000000bb';

describe('confirmResetHard', () => {
  it('interpolates branch and ref into the exact git operation', () => {
    const c = confirmResetHard('main', 'abc1234');
    expect(c.message).toBe("Hard reset 'main' to abc1234?");
    expect(c.detail).toBe(
      "git reset --hard abc1234\n\nDiscards all staged and working tree changes and moves 'main' to abc1234.",
    );
  });
});

describe('confirmMerge', () => {
  it('names the ref and the receiving branch', () => {
    const c = confirmMerge('feature/x', 'main');
    expect(c.message).toBe("Merge feature/x into 'main'?");
    expect(c.detail).toBe(
      "git merge feature/x\n\nCreates a merge commit on 'main' unless a fast-forward applies.",
    );
  });
});

describe('confirmRebase', () => {
  it('names the branch and the upstream', () => {
    const c = confirmRebase('topic', 'origin/main');
    expect(c.message).toBe("Rebase 'topic' onto origin/main?");
    expect(c.detail).toBe(
      "git rebase origin/main\n\nReplays the commits of 'topic' onto origin/main; commit shas change.",
    );
  });
});

describe('confirmCherryPick', () => {
  it('shows the abbreviated sha for a single commit', () => {
    const c = confirmCherryPick([SHA_A]);
    expect(c.message).toBe('Cherry-pick commit abc1234?');
    expect(c.detail).toBe(
      'git cherry-pick abc1234\n\nApplies the change onto the current branch as a new commit.',
    );
  });

  it('shows a count and all shas for multiple commits', () => {
    const c = confirmCherryPick([SHA_A, SHA_B]);
    expect(c.message).toBe('Cherry-pick 2 commits?');
    expect(c.detail).toBe(
      'git cherry-pick abc1234 9876543\n\nApplies the changes onto the current branch as new commits.',
    );
  });
});

describe('confirmRevert', () => {
  it('shows the abbreviated sha for a single commit', () => {
    const c = confirmRevert([SHA_A]);
    expect(c.message).toBe('Revert commit abc1234?');
    expect(c.detail).toBe(
      'git revert abc1234\n\nCreates a new commit that undoes the change.',
    );
  });

  it('shows a count and all shas for multiple commits', () => {
    const c = confirmRevert([SHA_B, SHA_A]);
    expect(c.message).toBe('Revert 2 commits?');
    expect(c.detail).toBe(
      'git revert 9876543 abc1234\n\nCreates new commits that undo the selected changes.',
    );
  });
});

describe('branch and stash confirmations', () => {
  it('builds delete and force-delete branch texts', () => {
    expect(confirmBranchDelete('old')).toEqual({
      message: "Delete branch 'old'?",
      detail: 'git branch -d old',
    });
    const force = confirmBranchForceDelete('old');
    expect(force.message).toBe("Force delete branch 'old'?");
    expect(force.detail).toBe(
      'git branch -D old\n\nThe branch is not fully merged; its commits may be lost.',
    );
  });

  it('builds stash drop text with index and message', () => {
    expect(confirmStashDrop(2, 'wip: thing')).toEqual({
      message: 'Drop stash@{2}?',
      detail: 'git stash drop stash@{2}\n\nwip: thing',
    });
  });
});

describe('worktree confirmations', () => {
  it('builds remove and force-remove texts with the path', () => {
    expect(confirmWorktreeRemove('/repos/app-wt')).toEqual({
      message: 'Remove worktree at /repos/app-wt?',
      detail: 'git worktree remove /repos/app-wt',
    });
    const force = confirmWorktreeForceRemove('/repos/app-wt');
    expect(force.message).toBe('Force remove worktree at /repos/app-wt?');
    expect(force.detail).toBe(
      'git worktree remove --force /repos/app-wt\n\nRemoves the worktree even if it has modified or untracked files.',
    );
  });
});
