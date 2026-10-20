// Source Control's Commit Graph button opens the graph on the repository
// whose title bar holds it, which the views then follow as well.

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => import('./support/fakeVscode'));

import { Uri, controls } from './support/fakeVscode';
import {
  ScmGraphDeps,
  showGraphForSourceControl,
  sourceControlRoot,
} from '../src/scm/scmGraphButton';

/** The probe path the button locates a repository by, as this platform spells it. */
const probe = (root: string) => Uri.joinPath(Uri.file(root), '.gitglasses').fsPath;

const repos: Record<string, { repoId: string; rootPath: string }> = {
  [probe('/w/app')]: { repoId: 'r1', rootPath: '/w/app' },
  [probe('/w/lib')]: { repoId: 'r2', rootPath: '/w/lib' },
};

function deps(active: string, lookup?: () => never) {
  const calls = { located: [] as string[], activated: [] as string[], log: [] as string[] };
  const value: ScmGraphDeps = {
    locateOrDiscover: async (uri) => {
      calls.located.push(uri.fsPath);
      if (lookup) lookup();
      return repos[uri.fsPath];
    },
    activeRepoId: async () => active,
    setActive: async (rootPath) => void calls.activated.push(rootPath),
    log: (line) => void calls.log.push(line),
  };
  return { value, calls };
}

const graphOpened = () =>
  controls.executed.filter((entry) => entry.command === 'gitglasses.showGraph').length;

beforeEach(() => controls.reset());

describe('showGraphForSourceControl', () => {
  it('opens the graph on the clicked repository, which the views then follow', async () => {
    const { value, calls } = deps('r1');
    await showGraphForSourceControl({ id: 'git', rootUri: Uri.file('/w/lib') }, value);
    expect(calls.located).toEqual([probe('/w/lib')]);
    expect(calls.activated).toEqual(['/w/lib']);
    expect(graphOpened()).toBe(1);
  });

  it('leaves the selection alone when the views already follow that repository', async () => {
    const { value, calls } = deps('r2');
    await showGraphForSourceControl({ rootUri: Uri.file('/w/lib') }, value);
    expect(calls.activated).toEqual([]);
    expect(graphOpened()).toBe(1);
  });

  it('opens the views’ repository when the host does not say which was clicked', async () => {
    for (const arg of [undefined, { $mid: 5, handle: 0 }, { rootUri: 'file:///w/lib' }]) {
      const { value, calls } = deps('r1');
      await showGraphForSourceControl(arg, value);
      expect(calls.located).toEqual([]);
      expect(calls.activated).toEqual([]);
    }
    expect(graphOpened()).toBe(3);
  });

  it('still opens the graph, and logs why, when the lookup fails', async () => {
    const { value, calls } = deps('r1', () => {
      throw new Error('engine unavailable');
    });
    await showGraphForSourceControl({ rootUri: Uri.file('/w/lib') }, value);
    expect(calls.activated).toEqual([]);
    expect(calls.log).toEqual([expect.stringContaining('engine unavailable')]);
    expect(graphOpened()).toBe(1);
  });
});

describe('sourceControlRoot', () => {
  it('reads the root of a source control and nothing else', () => {
    expect(sourceControlRoot({ rootUri: Uri.file('/w/app') })?.fsPath).toBe('/w/app');
    expect(sourceControlRoot({ rootUri: undefined })).toBeUndefined();
    expect(sourceControlRoot(null)).toBeUndefined();
    expect(sourceControlRoot('git')).toBeUndefined();
  });
});
