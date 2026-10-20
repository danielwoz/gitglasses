import { describe, expect, it } from 'vitest';
import type { StoryBlame, StoryPullRequest } from '@gitglasses/integrations';
import {
  blameFacts,
  countText,
  diffRows,
  historyNotice,
  previousPathOf,
  pullRequestFacts,
  pullRequestNotice,
  pullRequestStateLabel,
} from '../webviews-src/lineStory/lineStoryLogic';

const NOW = 1_800_000_000;
const forge = { providerId: 'github', host: 'github.com', name: 'GitHub', owner: 'o', repo: 'r' };

describe('version diffs', () => {
  const patch = [
    'diff --git a/src/old.ts b/src/new.ts',
    '--- a/src/old.ts',
    '+++ b/src/new.ts',
    '@@ -10,1 +12,2 @@',
    '-old line',
    '+new line',
    '+--- not a header',
    ' context',
    '\\ No newline at end of file',
    '',
  ].join('\n');

  it('shows the hunks without the file headers', () => {
    expect(diffRows(patch)).toEqual([
      { kind: 'hunk', text: '@@ -10,1 +12,2 @@' },
      { kind: 'del', text: '-old line' },
      { kind: 'add', text: '+new line' },
      { kind: 'add', text: '+--- not a header' },
      { kind: 'context', text: ' context' },
      { kind: 'note', text: '\\ No newline at end of file' },
    ]);
  });

  it('reads the path before the change, or none when the change added the file', () => {
    expect(previousPathOf(patch, 'src/new.ts')).toBe('src/old.ts');
    expect(
      previousPathOf('--- /dev/null\n+++ b/a.ts\n@@ -0,0 +1 @@\n+a\n', 'a.ts'),
    ).toBeUndefined();
    expect(previousPathOf(undefined, 'a.ts')).toBe('a.ts');
  });
});

describe('pull request facts', () => {
  const pr: StoryPullRequest = {
    number: 7,
    title: 'Fix it',
    url: 'https://github.com/o/r/pull/7',
    state: 'merged',
    draft: false,
    author: 'ada',
    createdAt: '2027-01-01T00:00:00Z',
    mergedAt: new Date((NOW - 2 * 86400) * 1000).toISOString(),
    baseRef: 'main',
    headRef: 'fix',
    excerpt: '',
    excerptTruncated: false,
    reviewCommentCount: 1,
    commentCount: 3,
  };

  it('names the state, author, merge, base and comment counts', () => {
    expect(pullRequestStateLabel(pr)).toBe('Merged');
    expect(pullRequestStateLabel({ state: 'open', draft: true })).toBe('Draft');
    expect(pullRequestFacts(pr, NOW)).toEqual([
      'by ada',
      'merged 2 days ago',
      'into main',
      '1 review comment',
      '3 comments',
    ]);
    expect(countText(0, 'comment')).toBe('0 comments');
  });
});

describe('blame facts', () => {
  const blame: StoryBlame = {
    sha: 'a'.repeat(40),
    line: 12,
    hunkStart: 10,
    hunkLines: 5,
    path: 'src/old.ts',
    originalLine: 4,
    author: { name: 'Ada', email: 'ada@example.invalid', time: NOW - 3 * 86400 },
    committer: { name: 'Ada', email: 'ada@example.invalid', time: NOW - 3 * 86400 },
    summary: 'x',
    boundary: false,
  };

  it('says when, which lines, and where the line was then', () => {
    expect(blameFacts(blame, 'src/new.ts', NOW)).toEqual([
      '3 days ago',
      'lines 10–14 last changed together',
      'then src/old.ts:4',
    ]);
    expect(blameFacts({ ...blame, path: 'src/new.ts', hunkLines: 1 }, 'src/new.ts', NOW)).toEqual([
      '3 days ago',
      'line 10 last changed here',
      'then line 4',
    ]);
  });
});

describe('notices', () => {
  it('offers to connect the forge, or to trust the folder', () => {
    expect(pullRequestNotice({ state: 'notConnected', forge })).toEqual({
      text: 'Connect GitHub to see the pull request that merged this commit.',
      action: { label: 'Connect GitHub', message: 'connect' },
    });
    expect(pullRequestNotice({ state: 'unavailable', reason: 'restricted' })?.action?.message).toBe(
      'manageTrust',
    );
    expect(
      pullRequestNotice({ state: 'failed', forge, reason: 'auth', message: '401' })?.action
        ?.message,
    ).toBe('connect');
  });

  it('explains an empty answer and says nothing over a list', () => {
    expect(pullRequestNotice({ state: 'found', forge, pullRequests: [] })?.text).toMatch(
      /rebase merge/,
    );
    expect(
      pullRequestNotice({
        state: 'found',
        forge,
        pullRequests: [{} as StoryPullRequest],
      }),
    ).toBeUndefined();
  });

  it('explains missing history', () => {
    expect(historyNotice({ state: 'unavailable', reason: 'restricted' })).toMatch(/trusted/);
    expect(historyNotice({ state: 'unavailable', reason: 'noGit' })).toMatch(/git CLI/);
    expect(historyNotice({ state: 'ready', value: { versions: [], more: false } })).toBe(
      'No earlier versions.',
    );
  });
});
