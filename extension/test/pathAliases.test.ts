import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  identityAliasResolver,
  sameDirectoryAncestor,
  type IdentifyPath,
} from '../src/model/pathAliases';
import { nodeFileIdentity } from '../src/model/nodeFileIdentity';

/**
 * A Windows volume as the identity lookup sees it: case-insensitive, either
 * separator, and every name in `aliases` naming the same directory as its
 * target, the way an 8.3 short name or a subst drive does.
 */
function windowsVolume(dirs: string[], aliases: Record<string, string> = {}): IdentifyPath {
  const fold = (value: string): string =>
    value.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
  const expand = (value: string): string => {
    let folded = fold(value);
    for (const [from, to] of Object.entries(aliases)) {
      const prefix = fold(from);
      if (folded === prefix || folded.startsWith(`${prefix}\\`)) {
        folded = fold(to) + folded.slice(prefix.length);
      }
    }
    return folded;
  };
  const ids = new Map(dirs.map((dir, index) => [fold(dir), BigInt(index + 1)]));
  return (fsPath) => {
    const ino = ids.get(expand(fsPath));
    return ino === undefined ? undefined : { dev: 7n, ino };
  };
}

/** A POSIX tree where `link` is a symlink to `target`. */
function posixTree(dirs: string[], link: string, target: string): IdentifyPath {
  const ids = new Map(dirs.map((dir, index) => [dir, BigInt(index + 1)]));
  return (fsPath) => {
    const resolved =
      fsPath === link || fsPath.startsWith(`${link}/`) ? target + fsPath.slice(link.length) : fsPath;
    const ino = ids.get(resolved);
    return ino === undefined ? undefined : { dev: 1n, ino };
  };
}

describe('sameDirectoryAncestor (windows)', () => {
  // The CI runner's temp dir is reached through the 8.3 short name RUNNER~1;
  // libgit2 reports the long name, with forward slashes and an upper-case
  // drive letter, while VS Code keeps the short name and a lower-case drive.
  const volume = windowsVolume(
    [
      'C:\\',
      'C:\\Users',
      'C:\\Users\\runneradmin',
      'C:\\Users\\runneradmin\\AppData\\Local\\Temp',
      'C:\\Users\\runneradmin\\AppData\\Local\\Temp\\gitglasses-e2e-m8ni2x',
      'C:\\Users\\runneradmin\\AppData\\Local\\Temp\\gitglasses-e2e-m8ni2x\\src',
      'C:\\work\\repo',
      'C:\\work\\repo\\lib',
    ],
    { 'C:\\Users\\RUNNER~1': 'C:\\Users\\runneradmin', 'S:\\': 'C:\\work\\' },
  );
  const engineRoot = 'C:/Users/runneradmin/AppData/Local/Temp/gitglasses-e2e-m8ni2x';
  const editorRoot = 'c:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\gitglasses-e2e-m8ni2x';

  it('maps an 8.3 short-name spelling onto the long-name root', () => {
    expect(sameDirectoryAncestor(editorRoot, engineRoot, volume, path.win32)).toBe(editorRoot);
  });

  it('walks up from a directory below the root, keeping the editor spelling', () => {
    expect(sameDirectoryAncestor(`${editorRoot}\\src`, engineRoot, volume, path.win32)).toBe(
      editorRoot,
    );
  });

  it('maps a subst drive onto the directory it stands for', () => {
    expect(sameDirectoryAncestor('S:\\repo\\lib', 'C:/work/repo', volume, path.win32)).toBe(
      'S:\\repo',
    );
  });

  it('answers undefined when no ancestor is the root', () => {
    expect(sameDirectoryAncestor('c:\\Users\\RUNNER~1', engineRoot, volume, path.win32)).toBe(
      undefined,
    );
  });

  it('answers undefined when the root cannot be read', () => {
    expect(sameDirectoryAncestor(editorRoot, 'D:/gone', volume, path.win32)).toBeUndefined();
  });
});

describe('sameDirectoryAncestor (posix)', () => {
  const tree = posixTree(
    ['/', '/home', '/home/u', '/home/u/real', '/home/u/real/repo', '/home/u/real/repo/src'],
    '/home/u/link',
    '/home/u/real',
  );

  it('maps a symlinked spelling onto the resolved root', () => {
    expect(sameDirectoryAncestor('/home/u/link/repo/src', '/home/u/real/repo', tree)).toBe(
      '/home/u/link/repo',
    );
  });

  it('returns the directory itself when it already is the root', () => {
    expect(sameDirectoryAncestor('/home/u/real/repo', '/home/u/real/repo', tree)).toBe(
      '/home/u/real/repo',
    );
  });

  it('does not match the same inode on another device', () => {
    const otherDevice: IdentifyPath = (fsPath) => {
      const identity = tree(fsPath);
      if (!identity) return undefined;
      return fsPath.startsWith('/home/u/real') ? identity : { ...identity, dev: 2n };
    };
    expect(sameDirectoryAncestor('/home/u/link/repo', '/home/u/real/repo', otherDevice)).toBe(
      undefined,
    );
  });

  it('is exposed as a resolver', () => {
    expect(identityAliasResolver(tree)('/home/u/link/repo', '/home/u/real/repo')).toBe(
      '/home/u/link/repo',
    );
  });
});

describe('nodeFileIdentity', () => {
  const created: string[] = [];
  afterEach(() => {
    for (const dir of created.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('answers undefined for a path that does not exist', () => {
    expect(nodeFileIdentity(path.join(os.tmpdir(), 'gitglasses-no-such-dir', 'x'))).toBeUndefined();
  });

  it.skipIf(process.platform === 'win32')(
    'finds the symlinked spelling of a real directory',
    () => {
      const base = fs.mkdtempSync(path.join(os.tmpdir(), 'gitglasses-alias-'));
      created.push(base);
      fs.mkdirSync(path.join(base, 'real', 'repo', 'src'), { recursive: true });
      fs.symlinkSync(path.join(base, 'real'), path.join(base, 'link'));
      const root = fs.realpathSync.native(path.join(base, 'real', 'repo'));

      expect(
        sameDirectoryAncestor(path.join(base, 'link', 'repo', 'src'), root, nodeFileIdentity),
      ).toBe(path.join(base, 'link', 'repo'));
    },
  );
});
