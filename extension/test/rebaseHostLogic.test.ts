import { describe, expect, it } from 'vitest';
import {
  type RebaseSession,
  autoStashKeptWarning,
  autoStashPrompt,
  isDirty,
  staleReason,
} from '../src/webviews/rebaseHostLogic';

const HEAD = '1'.repeat(40);
const UPSTREAM = '2'.repeat(40);

const session: RebaseSession = {
  upstream: 'origin/main',
  branch: 'feature',
  headSha: HEAD,
  upstreamSha: UPSTREAM,
  autoStash: false,
};

describe('isDirty', () => {
  it('counts staged and unstaged changes but not untracked files', () => {
    expect(isDirty({ staged: [], unstaged: [] })).toBe(false);
    expect(isDirty({ staged: [{}], unstaged: [] })).toBe(true);
    expect(isDirty({ staged: [], unstaged: [{}] })).toBe(true);
  });
});

describe('autoStashPrompt', () => {
  it('says how many files and what stashing does', () => {
    const prompt = autoStashPrompt({ staged: [{}], unstaged: [{}, {}] });
    expect(prompt.message).toBe('You have uncommitted changes.');
    expect(prompt.detail).toContain('3 changed files');
    expect(prompt.detail).toContain('--autostash');
    expect(prompt.detail).toContain('stay in the stash');
  });
});

describe('staleReason', () => {
  it('is undefined while the branch and upstream are where the plan saw them', () => {
    expect(staleReason(session, { headSha: HEAD, upstreamSha: UPSTREAM })).toBeUndefined();
  });

  it('names what moved', () => {
    const moved = '3'.repeat(40);
    expect(staleReason(session, { headSha: moved, upstreamSha: UPSTREAM })).toBe(
      "'feature' moved from 1111111 to 3333333 since this plan was made.",
    );
    expect(staleReason(session, { headSha: moved, upstreamSha: moved })).toBe(
      "'feature' moved from 1111111 to 3333333; origin/main moved from 2222222 to 3333333 since this plan was made.",
    );
  });
});

describe('autoStashKeptWarning', () => {
  it('names the conflicted files and where the changes are kept', () => {
    const text = autoStashKeptWarning(['README.md']);
    expect(text).toContain('conflict with it (README.md)');
    expect(text).toContain('stash@{0}');
    expect(text).not.toContain('rebase completed.');
  });

  it('shortens a long list of files', () => {
    expect(autoStashKeptWarning(['a', 'b', 'c', 'd', 'e'])).toContain('(a, b, c and 2 more)');
  });

  it('still points at the stash when nothing conflicts', () => {
    expect(autoStashKeptWarning([])).toContain('kept in stash@{0}');
  });
});
