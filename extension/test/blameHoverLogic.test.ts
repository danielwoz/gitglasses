import { describe, expect, it } from 'vitest';
import type { BlameCommit, BlameHunk } from '@gitglasses/protocol';
import {
  BLAME_HOVER_COMMANDS,
  commandLink,
  joinBlocks,
  messageBlocks,
  openChangesArgs,
  previousRevisionArgs,
  pullRequestNumber,
  pullRequestUrl,
  renderCommitHover,
  renderUncommittedHover,
  type CommitHoverInput,
} from '../src/annotations/blameHoverLogic';

const SHA = '1234567890abcdef1234567890abcdef12345678';
const PARENT = 'fedcba0987654321fedcba0987654321fedcba09';
const NOW = 1_800_000_000;

const commit: BlameCommit = {
  author: { name: 'Ada *Lovelace*', email: 'ada@example.invalid', time: NOW - 3 * 86400 },
  committer: { name: 'Ada', email: 'ada@example.invalid', time: NOW - 3 * 86400 },
  summary: 'add parser',
  boundary: false,
};

const hunk: BlameHunk = {
  sha: SHA,
  resultLine: 10,
  originalLine: 4,
  lineCount: 5,
  path: 'src/old.ts',
  previous: { sha: PARENT, path: 'src/older.ts' },
};

/** Decodes every command link in `markdown` to its command and argument. */
function links(markdown: string): { label: string; command: string; arg: unknown }[] {
  return [...markdown.matchAll(/\[([^\]]+)\]\(command:([\w.]+)\?([^ )]+)/g)].map((m) => ({
    label: m[1],
    command: m[2],
    arg: (JSON.parse(decodeURIComponent(m[3])) as unknown[])[0],
  }));
}

function input(overrides: Partial<CommitHoverInput> = {}): CommitHoverInput {
  return {
    hunk,
    commit,
    line: 12,
    target: { repoId: 'r1', repoPath: '/repo', path: 'src/new.ts' },
    subject: 'add parser',
    remote: true,
    nowUnixSeconds: NOW,
    locale: 'en-US',
    ...overrides,
  };
}

describe('blame hover', () => {
  it('shows the author, both dates, the message and the facts', () => {
    const markdown = renderCommitHover(
      input({
        body: 'Handles nested input.',
        stats: { files: 3, additions: 10, deletions: 2 },
        pullRequest: { number: 42, url: 'https://github.com/o/r/pull/42' },
      }),
    );
    expect(markdown).toContain('**Ada \\*Lovelace\\***');
    expect(markdown).toContain('\\<ada@example\\.invalid\\>');
    expect(markdown).toContain('3 days ago');
    expect(markdown).toContain('**add parser**');
    expect(markdown).toContain('Handles nested input.');
    expect(markdown).toContain('[Pull request #42](<https://github.com/o/r/pull/42>)');
    expect(markdown).toContain('`1234567`');
    expect(markdown).toContain('3 files changed, +10 −2');
    expect(markdown).toContain('was `src/old.ts`');
  });

  it('links to the commit, its changes, the previous revision, the sha and the remote', () => {
    const found = links(renderCommitHover(input()));
    expect(found.map((l) => l.command)).toEqual([
      'gitglasses.showCommitDetails',
      'gitglasses.blame.openChanges',
      'gitglasses.blame.previousRevision',
      'gitglasses.copySha',
      'gitglasses.openCommitOnRemote',
    ]);
    expect(found[0].arg).toEqual({ repoPath: '/repo', sha: SHA });
    expect(found[1].arg).toEqual({
      repoId: 'r1',
      sha: SHA,
      path: 'src/old.ts',
      previousSha: PARENT,
      previousPath: 'src/older.ts',
    });
    // Line 12 is the hunk's third line, which the commit wrote as line 6.
    expect((found[2].arg as { line: number }).line).toBe(5);
    expect(found[3].arg).toEqual({ sha: SHA });
    expect(found[4].arg).toEqual({ sha: SHA, repoPath: '/repo' });
    for (const link of found) expect(BLAME_HOVER_COMMANDS).toContain(link.command);
  });

  it('asks why the hovered line is the way it is, first', () => {
    const found = links(renderCommitHover(input({ documentUri: 'file:///repo/src/new.ts' })));
    expect(found[0]).toEqual({
      label: '$(question) Why this line?',
      command: 'gitglasses.showLineStory',
      arg: { uri: 'file:///repo/src/new.ts', line: 12 },
    });
    expect(BLAME_HOVER_COMMANDS).toContain('gitglasses.showLineStory');
  });

  it('drops the links it cannot serve', () => {
    const rootCommit = { ...commit, boundary: true };
    const noPrevious = { ...hunk, previous: undefined };
    const found = links(
      renderCommitHover(
        input({
          commit: rootCommit,
          hunk: noPrevious,
          remote: false,
          target: { repoId: 'r1', repoPath: '', path: 'src/old.ts' },
        }),
      ),
    );
    expect(found.map((l) => l.command)).toEqual([
      'gitglasses.blame.openChanges',
      'gitglasses.copySha',
    ]);
    // The commit added the file: its change is the whole file.
    expect(found[0].arg).toEqual({ repoId: 'r1', sha: SHA, path: 'src/old.ts' });
  });

  it('offers no earlier revision for lines from the commit that added the file', () => {
    // git reports neither `previous` nor `boundary` for a file added after
    // the root commit; its first parent does not have the file.
    const added = { ...hunk, previous: undefined };
    const found = links(renderCommitHover(input({ hunk: added })));
    expect(found.map((l) => l.command)).toEqual([
      'gitglasses.showCommitDetails',
      'gitglasses.blame.openChanges',
      'gitglasses.copySha',
      'gitglasses.openCommitOnRemote',
    ]);
    expect(found[1].arg).not.toHaveProperty('previousSha');
    expect(openChangesArgs('r1', added)).toEqual({ repoId: 'r1', sha: SHA, path: 'src/old.ts' });
  });

  it('keeps a quote in a title from ending the link', () => {
    expect(commandLink('x', 'c', {}, 'say "hi"')).toBe(
      `[x](command:c?${encodeURIComponent('[{}]')} "say 'hi'")`,
    );
  });

  it('offers the working-tree diff of the hovered document for uncommitted lines', () => {
    // Hovering an editor that is not the active one compares that document.
    const found = links(renderUncommittedHover('file:///w/repo/a.txt'));
    expect(found.map((l) => l.command)).toEqual(['gitglasses.diffWithHead']);
    expect(found[0].arg).toEqual({ uri: 'file:///w/repo/a.txt' });
  });

  it('carries the previous revision line through the hunk offset', () => {
    expect(previousRevisionArgs('r1', hunk, 10).line).toBe(3);
  });
});

describe('commit message body', () => {
  it('reflows paragraphs and keeps list items apart', () => {
    const { blocks, truncated } = messageBlocks(
      'First paragraph\nwrapped here.\n\n- one\n- two\n\nCloses #4',
    );
    expect(truncated).toBe(false);
    expect(blocks).toEqual([
      { text: 'First paragraph wrapped here.', listItem: false },
      { text: '- one', listItem: true },
      { text: '- two', listItem: true },
      { text: 'Closes #4', listItem: false },
    ]);
    expect(joinBlocks(blocks.map((b) => ({ markdown: b.text, listItem: b.listItem })))).toBe(
      'First paragraph wrapped here.\n\n- one  \n- two\n\nCloses #4',
    );
  });

  it('cuts long messages short', () => {
    const body = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n');
    const { blocks, truncated } = messageBlocks(body, 5);
    expect(truncated).toBe(true);
    expect(blocks).toEqual([{ text: 'line 0 line 1 line 2 line 3 line 4', listItem: false }]);
  });
});

describe('pull request links', () => {
  it('reads the numbers forges write into merge messages', () => {
    expect(pullRequestNumber('github', 'Merge pull request #12 from a/b', '')).toBe(12);
    expect(pullRequestNumber('github', 'Fix the parser (#345)', '')).toBe(345);
    expect(pullRequestNumber('github-enterprise', 'Fix the parser (#345)', '')).toBe(345);
    expect(pullRequestNumber('azuredevops', 'Merged PR 77: Fix', '')).toBe(77);
    expect(pullRequestNumber('bitbucket', 'Merged in feature (pull request #9)', '')).toBe(9);
    expect(pullRequestNumber('bitbucketDC', 'Pull request #5: Fix', '')).toBe(5);
    expect(
      pullRequestNumber('bitbucketDC', 'Merge pull request #6 in P/r from f to main', ''),
    ).toBe(6);
    expect(
      pullRequestNumber(
        'gitlab',
        "Merge branch 'x' into 'main'",
        'Body\n\nSee merge request group/proj!31',
      ),
    ).toBe(31);
    expect(pullRequestNumber('github', 'Fix #345 in the middle', '')).toBeUndefined();
    expect(pullRequestNumber('github', 'Plain subject', 'Refs #8')).toBeUndefined();
  });

  it("reads only the hosting forge's own pull request messages", () => {
    // On GitLab "#345" names an issue; merge requests are "!345".
    expect(pullRequestNumber('gitlab', 'Fix crash (#345)', '')).toBeUndefined();
    expect(pullRequestNumber('gitlab', 'Merge pull request #12 from a/b', '')).toBeUndefined();
    expect(pullRequestNumber('azuredevops', 'Fix crash (#345)', '')).toBeUndefined();
    expect(
      pullRequestNumber('github', 'Merge branch', 'See merge request group/proj!31'),
    ).toBeUndefined();
    expect(pullRequestNumber('gitea', 'Fix crash (#345)', '')).toBeUndefined();
  });

  it("builds each forge's pull request URL", () => {
    const repo = { provider: 'x', host: 'h.example', owner: 'own', name: 'repo' };
    expect(pullRequestUrl('github', repo, 3)).toBe('https://h.example/own/repo/pull/3');
    expect(pullRequestUrl('github-enterprise', repo, 3)).toBe('https://h.example/own/repo/pull/3');
    expect(pullRequestUrl('gitlab', repo, 3)).toBe('https://h.example/own/repo/-/merge_requests/3');
    expect(pullRequestUrl('bitbucket', repo, 3)).toBe('https://h.example/own/repo/pull-requests/3');
    expect(pullRequestUrl('bitbucketDC', repo, 3)).toBe(
      'https://h.example/projects/own/repos/repo/pull-requests/3',
    );
    expect(pullRequestUrl('azuredevops', { ...repo, owner: 'org/proj' }, 3)).toBe(
      'https://h.example/org/proj/_git/repo/pullrequest/3',
    );
    expect(pullRequestUrl('gitea', repo, 3)).toBeUndefined();
  });
});
