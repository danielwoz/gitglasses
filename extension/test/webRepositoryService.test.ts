import { describe, expect, it } from 'vitest';
import type * as vscode from 'vscode';
import { fakeEngine } from './support/fakeEngine';
import { WebRepositoryService } from '../src/web/webRepositoryService';

function uri(path: string, scheme = 'vscode-vfs'): vscode.Uri {
  return { scheme, path } as unknown as vscode.Uri;
}

describe('WebRepositoryService', () => {
  it('locates files under the workspace folder path', async () => {
    const { engine } = fakeEngine([{ id: 'r1', root: '/workspace', match: '/workspace' }]);
    const repos = new WebRepositoryService(engine, '/my-project/', '/workspace');

    const located = await repos.locateOrDiscover(uri('/my-project/src/index.ts'));
    expect(located).toEqual({
      repoId: 'r1',
      rootPath: '/workspace',
      relativePath: 'src/index.ts',
    });
    expect(repos.locate(uri('/my-project'))).toEqual({
      repoId: 'r1',
      rootPath: '/workspace',
      relativePath: '',
    });
  });

  it('locates probes under the MEMFS mountPath even when folderPath differs', async () => {
    const { engine } = fakeEngine([{ id: 'r1', root: '/workspace', match: '/workspace' }]);
    const repos = new WebRepositoryService(engine, '/my-project', '/workspace');

    // Callers such as Commit Details probe `<rootPath>/.gitglasses` with a file:// URI.
    const located = await repos.locateOrDiscover(uri('/workspace/.gitglasses', 'file'));
    expect(located).toEqual({
      repoId: 'r1',
      rootPath: '/workspace',
      relativePath: '.gitglasses',
    });
    expect(repos.locate(uri('/workspace', 'file'))).toEqual({
      repoId: 'r1',
      rootPath: '/workspace',
      relativePath: '',
    });
  });

  it('returns undefined for paths outside both folderPath and mountPath', async () => {
    const { engine } = fakeEngine([{ id: 'r1', root: '/workspace', match: '/workspace' }]);
    const repos = new WebRepositoryService(engine, '/my-project', '/workspace');

    expect(await repos.locateOrDiscover(uri('/other-project/file.ts'))).toBeUndefined();
    expect(repos.locate(uri('/workspace-other/file.ts', 'file'))).toBeUndefined();
  });
});
