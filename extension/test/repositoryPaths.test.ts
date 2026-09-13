import { describe, expect, it } from 'vitest';
import { relativeWithinRoot } from '../src/model/repositoryService';

// The engine reports the repo root as libgit2's git_repository_workdir(),
// which uses forward slashes everywhere; VS Code's uri.fsPath uses backslashes
// on Windows. Both shapes are exercised here, since CI never runs the
// extension suite on Windows.
describe('relativeWithinRoot (posix)', () => {
  const root = '/home/u/repo';

  it('returns the repo-relative path', () => {
    expect(relativeWithinRoot(root, '/home/u/repo/src/a.ts', false)).toBe('src/a.ts');
  });

  it('returns empty string for the root itself', () => {
    expect(relativeWithinRoot(root, '/home/u/repo', false)).toBe('');
  });

  it('tolerates a trailing slash on the root', () => {
    expect(relativeWithinRoot('/home/u/repo/', '/home/u/repo/a.ts', false)).toBe('a.ts');
  });

  it('rejects a path outside the root', () => {
    expect(relativeWithinRoot(root, '/home/u/other/a.ts', false)).toBeUndefined();
  });

  it('does not match a sibling sharing a name prefix', () => {
    expect(relativeWithinRoot(root, '/home/u/repo-two/a.ts', false)).toBeUndefined();
  });

  it('is case-sensitive when told to be', () => {
    expect(relativeWithinRoot(root, '/home/u/REPO/a.ts', false)).toBeUndefined();
  });
});

describe('relativeWithinRoot (windows)', () => {
  // libgit2 hands back forward slashes even on Windows.
  const root = 'C:/Users/x/repo';

  it('matches a backslash fsPath against a forward-slash root', () => {
    expect(relativeWithinRoot(root, 'C:\\Users\\x\\repo\\src\\a.ts', true)).toBe('src/a.ts');
  });

  it('matches despite drive-letter case differing', () => {
    expect(relativeWithinRoot(root, 'c:\\Users\\x\\repo\\src\\a.ts', true)).toBe('src/a.ts');
  });

  it('preserves the original case of the returned path', () => {
    expect(relativeWithinRoot(root, 'c:\\Users\\x\\repo\\src\\MyFile.TS', true)).toBe(
      'src/MyFile.TS',
    );
  });

  it('returns empty string for the root itself', () => {
    expect(relativeWithinRoot(root, 'C:\\Users\\x\\repo', true)).toBe('');
  });

  it('still rejects a path outside the root', () => {
    expect(relativeWithinRoot(root, 'C:\\Users\\x\\other\\a.ts', true)).toBeUndefined();
  });

  it('does not match a sibling sharing a name prefix', () => {
    expect(relativeWithinRoot(root, 'C:\\Users\\x\\repo-two\\a.ts', true)).toBeUndefined();
  });
});

describe('relativeWithinRoot (edge cases)', () => {
  it('rejects an empty root rather than matching everything', () => {
    expect(relativeWithinRoot('', '/anything/a.ts', false)).toBeUndefined();
  });

  it('handles nested repositories by exact prefix', () => {
    expect(relativeWithinRoot('/r/outer/inner', '/r/outer/inner/a.ts', false)).toBe('a.ts');
    expect(relativeWithinRoot('/r/outer', '/r/outer/inner/a.ts', false)).toBe('inner/a.ts');
  });
});
