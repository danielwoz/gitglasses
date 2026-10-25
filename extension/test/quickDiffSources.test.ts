// GitGlasses must not add a source control where VS Code's Git extension
// runs: Source Control's Graph, repository picker and status bar items
// follow the selected provider, and an extra one takes them over. Where Git
// is absent it provides quick diff from one rooted source control per
// repository, with no commit box.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RepositoryService } from '../src/model/repositoryService';
import type { WorkspaceRepo } from '../src/model/activeRepo';

const host = {
  gitInstalled: true,
  created: [] as Array<{
    id: string;
    label: string;
    rootUri?: { fsPath: string };
    inputBox: { visible: boolean };
    quickDiffProvider?: unknown;
    disposed: boolean;
  }>,
};

vi.mock('vscode', async () => {
  const base = await import('./support/fakeVscode');
  return {
    ...base,
    extensions: {
      getExtension: (id: string) => (id === 'vscode.git' && host.gitInstalled ? { id } : undefined),
    },
    scm: {
      createSourceControl(id: string, label: string, rootUri?: { fsPath: string }) {
        const control = {
          id,
          label,
          rootUri,
          inputBox: { visible: true },
          quickDiffProvider: undefined as unknown,
          disposed: false,
          dispose() {
            control.disposed = true;
          },
        };
        host.created.push(control);
        return control;
      },
    },
  };
});

import { EventEmitter } from './support/fakeVscode';
import { registerQuickDiff } from '../src/scm/quickDiffSources';

const repo = (name: string): WorkspaceRepo => ({
  repoId: name,
  name,
  rootPath: `/w/${name}`,
  workspacePath: `/w/${name}`,
});

function setup(initial: WorkspaceRepo[]) {
  let list = initial;
  const reposChanged = new EventEmitter<void>();
  const engineChanged = new EventEmitter<void>();
  const disposables = registerQuickDiff(
    {} as RepositoryService,
    async () => list,
    reposChanged.event,
    (listener) => engineChanged.event(listener),
    () => undefined,
  );
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  return {
    disposables,
    setRepos(next: WorkspaceRepo[]) {
      list = next;
    },
    async reposChanged() {
      reposChanged.fire();
      await settle();
    },
    async engineChanged() {
      engineChanged.fire();
      await settle();
    },
  };
}

beforeEach(() => {
  host.created = [];
});

describe('registerQuickDiff', () => {
  it('adds no source control where VS Code’s Git extension runs', async () => {
    host.gitInstalled = true;
    const quickDiff = setup([repo('app'), repo('lib')]);
    await quickDiff.reposChanged();
    await quickDiff.engineChanged();
    expect(quickDiff.disposables).toEqual([]);
    expect(host.created).toEqual([]);
  });

  it('adds one rooted source control per repository without it, with no commit box', async () => {
    host.gitInstalled = false;
    const quickDiff = setup([repo('app'), repo('lib')]);
    await quickDiff.reposChanged();
    expect(host.created.map((control) => control.rootUri?.fsPath)).toEqual(['/w/app', '/w/lib']);
    for (const control of host.created) {
      expect(control.id).toBe('gitglasses');
      expect(control.inputBox.visible).toBe(false);
      expect(control.quickDiffProvider).toBeDefined();
    }

    // An engine restart re-syncs without duplicating; a repository that
    // goes away takes its source control with it.
    quickDiff.setRepos([repo('lib')]);
    await quickDiff.engineChanged();
    expect(host.created).toHaveLength(2);
    expect(host.created.map((control) => control.disposed)).toEqual([true, false]);

    for (const disposable of quickDiff.disposables) disposable.dispose();
    expect(host.created.every((control) => control.disposed)).toBe(true);
  });
});
