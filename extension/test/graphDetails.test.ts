import { describe, expect, it } from 'vitest';
import {
  changeSummary,
  commitFileEntries,
  signatureLine,
  splitPath,
  statusLabel,
  wipFileEntries,
} from '../webviews-src/graph/detailsLogic';

describe('details helpers', () => {
  it('splits a path into name and directory', () => {
    expect(splitPath('src/graph/main.ts')).toEqual({ name: 'main.ts', dir: 'src/graph' });
    expect(splitPath('README.md')).toEqual({ name: 'README.md', dir: '' });
  });

  it('names statuses for screen readers', () => {
    expect(statusLabel('A')).toBe('Added');
    expect(statusLabel('R')).toBe('Renamed');
    expect(statusLabel('?')).toBe('Untracked');
    expect(statusLabel('X')).toBe('X');
  });

  it('formats signatures', () => {
    expect(signatureLine({ name: 'Ada', email: 'ada@example.invalid' })).toBe(
      'Ada <ada@example.invalid>',
    );
    expect(signatureLine({ name: 'Ada', email: '' })).toBe('Ada');
  });

  it('summarizes files, counting every changed file even when fewer are listed', () => {
    expect(changeSummary([{ additions: 3, deletions: 1 }], 1)).toEqual({
      text: '1 file changed',
      additions: 3,
      deletions: 1,
    });
    expect(changeSummary([{ additions: 3, deletions: 1 }], 2500).text).toBe('2500 files changed');
    expect(changeSummary([], 0).text).toBe('No files changed');
  });

  it('lists commit files with line counts, binaries without', () => {
    const entries = commitFileEntries([
      { path: 'a.ts', status: 'M', additions: 2, deletions: 1, binary: false },
      { path: 'logo.png', status: 'A', additions: 0, deletions: 0, binary: true },
      {
        path: 'new.md',
        origPath: 'old.md',
        status: 'R',
        additions: 0,
        deletions: 0,
        binary: false,
      },
    ]);
    expect(entries.map((entry) => entry.stats)).toEqual(['+2 −1', 'binary', '+0 −0']);
    expect(entries[2].origPath).toBe('old.md');
  });

  it('groups uncommitted changes the way Source Control does, without line counts', () => {
    const groups = wipFileEntries({
      kind: 'wip',
      staged: [{ path: 's.txt', status: 'A', additions: 0, deletions: 0 }],
      unstaged: [{ path: 'u.txt', status: 'M', additions: 0, deletions: 0 }],
      untracked: ['n.txt'],
      conflicted: ['c.txt'],
    });
    expect(groups.map((group) => group.title)).toEqual([
      'Merge Changes',
      'Staged Changes',
      'Changes',
      'Untracked',
    ]);
    expect(groups[2].entries[0].stats).toBeUndefined();
    expect(groups[3].untracked).toBe(true);
    expect(groups[3].entries[0].status).toBe('?');
  });

  it('leaves out empty groups', () => {
    expect(
      wipFileEntries({ kind: 'wip', staged: [], unstaged: [], untracked: [], conflicted: [] }),
    ).toEqual([]);
  });
});
