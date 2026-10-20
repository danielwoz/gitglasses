import { describe, expect, it } from 'vitest';
import {
  changeTitle,
  commitDiffSides,
  compareDiffSides,
  diffTitle,
} from '../src/commitDetails/commitDetailsLogic';

const SHA = '1a2b3c4d5e6f708192a3b4c5d6e7f80912345678';

describe('commitDiffSides', () => {
  it('diffs a modified file against the first parent', () => {
    expect(commitDiffSides(SHA, { path: 'src/a.ts', status: 'M' })).toEqual({
      left: { path: 'src/a.ts', rev: `${SHA}^` },
      right: { path: 'src/a.ts', rev: SHA },
    });
  });

  it('has no old side for an added file and no new side for a deleted one', () => {
    expect(commitDiffSides(SHA, { path: 'new.ts', status: 'A' }).left).toBeUndefined();
    expect(commitDiffSides(SHA, { path: 'gone.ts', status: 'D' }).right).toBeUndefined();
    expect(commitDiffSides(SHA, { path: 'gone.ts', status: 'D' }).left).toEqual({
      path: 'gone.ts',
      rev: `${SHA}^`,
    });
  });

  it('reads the old side of a rename at its old path', () => {
    const sides = commitDiffSides(SHA, {
      path: 'docs/new.md',
      origPath: 'docs/old.md',
      status: 'R',
    });
    expect(sides.left).toEqual({ path: 'docs/old.md', rev: `${SHA}^` });
    expect(sides.right).toEqual({ path: 'docs/new.md', rev: SHA });
  });
});

describe('compareDiffSides', () => {
  it('puts the base commit on the left', () => {
    expect(compareDiffSides('base1', 'head2', { path: 'a.txt', status: 'M' })).toEqual({
      left: { path: 'a.txt', rev: 'base1' },
      right: { path: 'a.txt', rev: 'head2' },
    });
  });
});

describe('titles', () => {
  it('names the file, or both paths of a rename, and both sides', () => {
    expect(diffTitle({ path: 'a.ts' }, '1a2b3c4^', '1a2b3c4')).toBe('a.ts (1a2b3c4^ ↔ 1a2b3c4)');
    expect(diffTitle({ path: 'new.md', origPath: 'old.md' }, 'x', 'y')).toBe(
      'old.md → new.md (x ↔ y)',
    );
    expect(changeTitle('1a2b3c4')).toBe('Changes in 1a2b3c4');
  });
});
