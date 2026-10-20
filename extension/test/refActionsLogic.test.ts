import { describe, expect, it } from 'vitest';
import {
  compareEntries,
  confirmForcePush,
  confirmRemoteRemove,
  confirmRemoteTagDelete,
  confirmTagDelete,
  hasMoreDetail,
  isNotFullyMerged,
  isPushRejected,
  planPush,
  rebaseTargets,
  refLabel,
  refRevision,
  splitRemoteBranch,
  summarizeGitError,
  workingTreeCompareEntries,
} from '../src/views/refActionsLogic';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

describe('refRevision / refLabel', () => {
  it('names each kind of ref the way git and the user read it', () => {
    expect(refRevision({ kind: 'branch', name: 'main', current: true })).toBe('main');
    expect(refRevision({ kind: 'remoteBranch', remote: 'origin', name: 'feat/x' })).toBe(
      'origin/feat/x',
    );
    expect(refRevision({ kind: 'stash', index: 2, message: 'm' })).toBe('stash@{2}');
    expect(refRevision({ kind: 'remote', name: 'origin' })).toBeUndefined();
    expect(refLabel({ kind: 'remoteBranch', remote: 'origin', name: 'feat/x' })).toBe(
      'origin/feat/x',
    );
    expect(refLabel({ kind: 'tag', name: 'v1' })).toBe('v1');
  });

  it('spells tags out in full so a same-named branch cannot shadow them', () => {
    expect(refRevision({ kind: 'tag', name: 'v1' })).toBe('refs/tags/v1');
  });
});

describe('splitRemoteBranch', () => {
  it('uses the longest remote name that prefixes the tracking name', () => {
    expect(splitRemoteBranch('team/origin/feat', ['team', 'team/origin'])).toEqual({
      remote: 'team/origin',
      branch: 'feat',
    });
    expect(splitRemoteBranch('origin/feat/x', ['origin'])).toEqual({
      remote: 'origin',
      branch: 'feat/x',
    });
  });

  it('matches whole remote names only', () => {
    expect(splitRemoteBranch('originals/x', ['origin'])).toBeUndefined();
  });
});

describe('planPush', () => {
  it('pushes a tracked branch where it tracks', () => {
    expect(planPush('origin/main', ['origin', 'fork'])).toEqual({ kind: 'push' });
  });

  it('publishes to the only remote without asking', () => {
    expect(planPush(undefined, ['fork'])).toEqual({ kind: 'publish', remote: 'fork' });
  });

  it('asks which remote when there are several, suggesting origin', () => {
    expect(planPush(undefined, ['fork', 'origin'])).toEqual({
      kind: 'pickRemote',
      remotes: ['fork', 'origin'],
      preferred: 'origin',
    });
    expect(planPush(undefined, ['a', 'b'])).toEqual({
      kind: 'pickRemote',
      remotes: ['a', 'b'],
      preferred: undefined,
    });
  });

  it('reports a repository with no remote', () => {
    expect(planPush(undefined, [])).toEqual({ kind: 'noRemote' });
  });
});

describe('git failure classification', () => {
  it('recognises an unmerged branch refusal', () => {
    expect(
      isNotFullyMerged(
        "git branch delete failed (1): error: The branch 'feat' is not fully merged.\nIf you are sure you want to delete it, run 'git branch -D feat'.",
      ),
    ).toBe(true);
    expect(isNotFullyMerged("error: branch 'feat' not found.")).toBe(false);
  });

  it('recognises a push the remote rejected', () => {
    expect(
      isPushRejected(
        ' ! [rejected]        main -> main (fetch first)\nerror: failed to push some refs',
      ),
    ).toBe(true);
    expect(isPushRejected(' ! [rejected] main -> main (non-fast-forward)')).toBe(true);
    expect(isPushRejected('fatal: could not read Username')).toBe(false);
  });
});

describe('summarizeGitError', () => {
  it("leads with git's error line and keeps the rest for the details", () => {
    const message =
      'git rebase failed (1): error: cannot rebase: You have unstaged changes.\nerror: Please commit or stash them.';
    expect(summarizeGitError(message)).toBe('cannot rebase: You have unstaged changes.');
    expect(hasMoreDetail(message)).toBe(true);
  });

  it('prefers a fatal line over hints and progress output', () => {
    const message =
      'git switch failed (128): hint: something\nfatal: invalid reference: nope\nhint: more';
    expect(summarizeGitError(message)).toBe('invalid reference: nope');
  });

  it('names the files git lists under its explanation', () => {
    const message =
      'git switch failed (1): error: Your local changes to the following files would be overwritten by checkout:\n\tnotes.txt\n\tREADME.md\nPlease commit your changes or stash them before you switch branches.\nAborting\n';
    expect(summarizeGitError(message)).toBe(
      'Your local changes to the following files would be overwritten by checkout: notes.txt, README.md',
    );
    const many = `error: untracked files would be overwritten:\n${['a', 'b', 'c', 'd', 'e']
      .map((f) => `\t${f}`)
      .join('\n')}`;
    expect(summarizeGitError(many)).toBe(
      'untracked files would be overwritten: a, b, c, and 2 more',
    );
  });

  it('leaves a one-line message as it is', () => {
    expect(summarizeGitError('rebase not started: the plan lists abc1234')).toBe(
      'rebase not started: the plan lists abc1234',
    );
    expect(hasMoreDetail('rebase not started: the plan lists abc1234')).toBe(false);
  });
});

describe('compareEntries', () => {
  it('puts each file on the sides where it exists', () => {
    expect(
      compareEntries([
        { path: 'added.txt', status: 'A' },
        { path: 'gone.txt', status: 'D' },
        { path: 'new-name.txt', status: 'R', origPath: 'old-name.txt' },
        { path: 'changed.txt', status: 'M' },
      ]),
    ).toEqual([
      { path: 'added.txt', right: 'added.txt' },
      { path: 'gone.txt', left: 'gone.txt' },
      { path: 'new-name.txt', left: 'old-name.txt', right: 'new-name.txt' },
      { path: 'changed.txt', left: 'changed.txt', right: 'changed.txt' },
    ]);
  });
});

describe('workingTreeCompareEntries', () => {
  it('combines what differs from HEAD with what the working tree changes', () => {
    const entries = workingTreeCompareEntries(
      [
        { path: 'only-on-branch.txt', status: 'D' },
        { path: 'both.txt', status: 'M' },
      ],
      {
        staged: [{ path: 'staged.txt', status: 'A' }],
        unstaged: [
          { path: 'both.txt', status: 'M' },
          { path: 'deleted-now.txt', status: 'D' },
        ],
        untracked: ['new.txt'],
      },
    );
    expect(entries).toEqual([
      { path: 'both.txt', left: 'both.txt', right: 'both.txt' },
      { path: 'deleted-now.txt', left: 'deleted-now.txt' },
      { path: 'new.txt', left: 'new.txt', right: 'new.txt' },
      { path: 'only-on-branch.txt', left: 'only-on-branch.txt' },
      { path: 'staged.txt', left: 'staged.txt', right: 'staged.txt' },
    ]);
  });
});

describe('rebaseTargets', () => {
  it("offers the current branch's upstream first, then branches, remote branches and tags", () => {
    const targets = rebaseTargets({
      branches: [
        { name: 'feature', sha: SHA_A, current: true, upstream: 'origin/feature' },
        { name: 'main', sha: SHA_B, current: false, upstream: 'origin/main' },
      ],
      remotes: [
        {
          name: 'origin',
          branches: [
            { name: 'main', sha: SHA_B },
            { name: 'feature', sha: SHA_A },
          ],
        },
      ],
      tags: [{ name: 'v1', sha: SHA_B }],
    });
    expect(targets.map((target) => [target.kind, target.value])).toEqual([
      ['upstream', 'origin/feature'],
      ['branch', 'main'],
      ['remoteBranch', 'origin/main'],
      ['tag', 'v1'],
    ]);
  });
});

describe('confirmations', () => {
  it('state the git command and what it costs', () => {
    expect(confirmTagDelete('v1').detail).toContain('git tag -d v1');
    expect(confirmRemoteTagDelete('v1', 'origin').detail).toContain(
      'git push --delete origin refs/tags/v1',
    );
    expect(confirmRemoteRemove('fork').detail).toContain('git remote remove fork');
    const force = confirmForcePush('main', 'origin');
    expect(force.message).toBe("Force push 'main' to origin?");
    expect(force.detail).toContain('--force-with-lease');
  });
});
