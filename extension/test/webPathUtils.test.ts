import { describe, expect, it } from 'vitest';
import * as path from '../src/web/pathUtils';
import * as nodePath from 'node:path';

// The web bundle aliases node:path to pathUtils; these cases pin the shim to
// node's posix behavior for every operation the bundled sources perform.
const CASES: Array<{ name: string; ours: string; nodes: string }> = [
  { name: 'join', ours: path.join('/a', 'b', 'c.txt'), nodes: nodePath.posix.join('/a', 'b', 'c.txt') },
  { name: 'join dotdot', ours: path.join('/a/b', '../c'), nodes: nodePath.posix.join('/a/b', '../c') },
  { name: 'dirname', ours: path.dirname('/a/b/c.txt'), nodes: nodePath.posix.dirname('/a/b/c.txt') },
  { name: 'dirname root', ours: path.dirname('/a'), nodes: nodePath.posix.dirname('/a') },
  { name: 'dirname bare', ours: path.dirname('abc'), nodes: nodePath.posix.dirname('abc') },
  { name: 'basename', ours: path.basename('/a/b/c.txt'), nodes: nodePath.posix.basename('/a/b/c.txt') },
  { name: 'basename ext', ours: path.basename('/a/c.txt', '.txt'), nodes: nodePath.posix.basename('/a/c.txt', '.txt') },
  { name: 'extname', ours: path.extname('/a/b/c.min.js'), nodes: nodePath.posix.extname('/a/b/c.min.js') },
  { name: 'extname dotfile', ours: path.extname('/a/.gitignore'), nodes: nodePath.posix.extname('/a/.gitignore') },
  { name: 'relative inside', ours: path.relative('/repo', '/repo/src/a.ts'), nodes: nodePath.posix.relative('/repo', '/repo/src/a.ts') },
  { name: 'relative outside', ours: path.relative('/repo', '/other/a.ts'), nodes: nodePath.posix.relative('/repo', '/other/a.ts') },
  { name: 'relative same', ours: path.relative('/repo', '/repo'), nodes: nodePath.posix.relative('/repo', '/repo') },
  { name: 'resolve', ours: path.resolve('/repo', 'sub/../x'), nodes: nodePath.posix.resolve('/repo', 'sub/../x') },
  { name: 'resolve absolute wins', ours: path.resolve('/a', '/b/c'), nodes: nodePath.posix.resolve('/a', '/b/c') },
  { name: 'normalize', ours: path.normalize('/a//b/./c/'), nodes: nodePath.posix.normalize('/a//b/./c/') },
];

describe('pathUtils matches node:path posix semantics', () => {
  for (const test of CASES) {
    it(test.name, () => {
      expect(test.ours).toBe(test.nodes);
    });
  }

  it('locate()-style relative checks behave like the native service', () => {
    // repositoryService.locate: relative() + isAbsolute() + sep splitting.
    const rel = path.relative('/repo', '/repo/src/deep/file.ts');
    expect(rel.startsWith('..')).toBe(false);
    expect(path.isAbsolute(rel)).toBe(false);
    expect(rel.split(path.sep).join('/')).toBe('src/deep/file.ts');

    const outside = path.relative('/repo', '/elsewhere/file.ts');
    expect(outside.startsWith('..')).toBe(true);
  });
});
