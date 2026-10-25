import { describe, expect, it } from 'vitest';
import { choosePaletteRepo, paletteTitle } from '../src/commands/paletteRepo';

interface Repo {
  repoId: string;
  name: string;
}

const same = (a: Repo, b: Repo): boolean => a.repoId === b.repoId;
const app: Repo = { repoId: 'r1', name: 'app' };
const lib: Repo = { repoId: 'r2', name: 'lib' };

describe('choosePaletteRepo', () => {
  it('asks, editor first, when the file in the editor is in another repository', () => {
    expect(choosePaletteRepo(app, lib, same)).toEqual({ kind: 'ask', editor: lib, selected: app });
  });

  it('uses the repository both agree on', () => {
    expect(choosePaletteRepo(app, { ...app }, same)).toEqual({ kind: 'use', repo: { ...app } });
  });

  it('uses whichever one exists', () => {
    expect(choosePaletteRepo(undefined, lib, same)).toEqual({ kind: 'use', repo: lib });
    expect(choosePaletteRepo(app, undefined, same)).toEqual({ kind: 'use', repo: app });
    expect(choosePaletteRepo<Repo>(undefined, undefined, same)).toEqual({ kind: 'none' });
  });
});

describe('paletteTitle', () => {
  it('names the repository', () => {
    expect(paletteTitle('app')).toBe('Git Commands — app');
  });
});
