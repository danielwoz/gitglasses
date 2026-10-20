import { describe, expect, it } from 'vitest';
import { UNCOMMITTED_SHA, type BlameCommit, type BlameHunk } from '@gitglasses/protocol';
import type { FileBlame } from '../src/model/blameModel';
import {
  isCommitId,
  isLineStoryArgs,
  isWebUrl,
  lineStoryTitle,
  storyBlameOf,
  storyLineText,
  storyVersionOf,
} from '../src/lineStory/lineStoryLogic';

const OLD = '1111111111111111111111111111111111111111';
const NEW = '2222222222222222222222222222222222222222';
const PARENT = '3333333333333333333333333333333333333333';

function commit(summary: string, time: number): BlameCommit {
  const signature = { name: 'Ada', email: 'ada@example.invalid', time };
  return { author: signature, committer: signature, summary, boundary: false };
}

const hunks: BlameHunk[] = [
  { sha: OLD, resultLine: 1, originalLine: 1, lineCount: 3, path: 'src/old.ts' },
  {
    sha: NEW,
    resultLine: 4,
    originalLine: 10,
    lineCount: 2,
    path: 'src/new.ts',
    previous: { sha: PARENT, path: 'src/old.ts' },
  },
  { sha: UNCOMMITTED_SHA, resultLine: 6, originalLine: 6, lineCount: 1, path: 'src/new.ts' },
];

const blame: FileBlame = {
  hunks,
  commits: { [OLD]: commit('first', 100), [NEW]: commit('second', 200) },
  totalLines: 6,
  lfs: false,
};

describe('storyBlameOf', () => {
  it('describes the hunk holding the line, at its number in the commit', () => {
    expect(storyBlameOf(blame, 5)).toEqual({
      sha: NEW,
      line: 5,
      hunkStart: 4,
      hunkLines: 2,
      path: 'src/new.ts',
      // The hunk's second line, which the commit wrote as line 11.
      originalLine: 11,
      previous: { sha: PARENT, path: 'src/old.ts' },
      author: commit('second', 200).author,
      committer: commit('second', 200).committer,
      summary: 'second',
      boundary: false,
    });
  });

  it('marks an uncommitted line and stops at the end of the file', () => {
    expect(storyBlameOf(blame, 6)).toMatchObject({
      sha: UNCOMMITTED_SHA,
      summary: 'Not committed yet',
    });
    expect(storyBlameOf(blame, 7)).toBeUndefined();
  });

  it("follows a Git LFS file's last content change, as the hover does", () => {
    const lfs: FileBlame = { ...blame, hunks: hunks.slice(0, 2), lfs: true };
    expect(storyBlameOf(lfs, 1)).toMatchObject({ sha: NEW, line: 1, originalLine: 10 });
  });
});

describe('line story arguments', () => {
  it('accepts a document and a 1-based line only', () => {
    expect(isLineStoryArgs({ uri: 'file:///a.ts', line: 3 })).toBe(true);
    expect(isLineStoryArgs({ uri: 'file:///a.ts', line: 0 })).toBe(false);
    expect(isLineStoryArgs({ uri: 'file:///a.ts', line: 1.5 })).toBe(false);
    expect(isLineStoryArgs({ uri: '', line: 1 })).toBe(false);
    expect(isLineStoryArgs(undefined)).toBe(false);
  });

  it('opens only web links and commit ids', () => {
    expect(isWebUrl('https://github.com/o/r/pull/1')).toBe(true);
    expect(isWebUrl('http://ghe.corp.example/o/r/issues/2')).toBe(true);
    expect(isWebUrl('command:workbench.action.terminal.new')).toBe(false);
    expect(isWebUrl('file:///etc/passwd')).toBe(false);
    expect(isWebUrl('javascript:alert(1)')).toBe(false);
    expect(isCommitId(NEW)).toBe(true);
    expect(isCommitId('HEAD; rm -rf')).toBe(false);
  });
});

describe('line story text', () => {
  it('titles the panel with the file name and the line', () => {
    expect(lineStoryTitle('src/parser/lexer.ts', 42)).toBe('Why lexer.ts:42?');
  });

  it('bounds a very long line', () => {
    expect(storyLineText('x'.repeat(600))).toHaveLength(501);
    expect(storyLineText('short')).toBe('short');
  });

  it('keeps each version of the line with its diff', () => {
    const entry = {
      sha: NEW,
      author: commit('second', 200).author,
      summary: 'second',
      path: 'src/new.ts',
      additions: 1,
      deletions: 1,
      patch: '@@ -1 +1 @@\n-a\n+b\n',
    };
    expect(storyVersionOf(entry)).toEqual({ ...entry, patchTruncated: undefined });
  });
});
