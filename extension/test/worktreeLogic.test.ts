import { describe, expect, it } from 'vitest';
import {
  defaultWorktreePath,
  isSameWorktreePath,
  worktreeDescription,
  worktreeLabel,
} from '../src/views/worktreeLogic';

const SHA = '1234567890abcdef1234567890abcdef12345678';

describe('worktreeLabel', () => {
  it('uses the directory basename', () => {
    expect(worktreeLabel('/home/user/repos/app')).toBe('app');
  });

  it('ignores trailing separators', () => {
    expect(worktreeLabel('/home/user/repos/app/')).toBe('app');
  });

  it('handles Windows-style separators', () => {
    expect(worktreeLabel('C:\\repos\\app-feature')).toBe('app-feature');
  });
});

describe('worktreeDescription', () => {
  it('formats branch@sha7', () => {
    expect(worktreeDescription({ branch: 'main', sha: SHA }, false)).toBe('main@1234567');
  });

  it('marks the current worktree', () => {
    expect(worktreeDescription({ branch: 'main', sha: SHA }, true)).toBe(
      'main@1234567 (current)',
    );
  });

  it('labels detached worktrees', () => {
    expect(worktreeDescription({ sha: SHA }, false)).toBe('detached@1234567');
  });
});

describe('isSameWorktreePath', () => {
  it('ignores trailing separators and separator style', () => {
    expect(isSameWorktreePath('/repos/app/', '/repos/app')).toBe(true);
    expect(isSameWorktreePath('C:\\repos\\app', 'C:/repos/app/')).toBe(true);
    expect(isSameWorktreePath('/repos/app', '/repos/other')).toBe(false);
  });
});

describe('defaultWorktreePath', () => {
  it('suggests a repo-branch sibling directory', () => {
    expect(defaultWorktreePath('/home/user/repos/app', 'main')).toBe('../app-main');
  });

  it('sanitizes ref characters unsafe in paths', () => {
    expect(defaultWorktreePath('/repos/app', 'feature/new-ui')).toBe('../app-feature-new-ui');
  });
});
