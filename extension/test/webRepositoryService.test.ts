import { describe, expect, it } from 'vitest';
import type * as vscode from 'vscode';
import { fakeEngine } from './support/fakeEngine';
import { WebRepositoryService } from '../src/web/webRepositoryService';

function uri(path: string, scheme = 'vscode-vfs'): vscode.Uri {
  return { scheme, path } as unknown as vscode.Uri;
}

describe('WebRepositoryService.setFolderPath', () => {
  it('updates the matched workspace folder path after switching folders', async () => {
    const { engine } = fakeEngine([{ id: 'r1', root: '/workspace', match: '/workspace' }]);
    const repos = new WebRepositoryService(engine, '', '/workspace');

    expect(await repos.locateOrDiscover(uri('/project-a/file.ts'))).toBeUndefined();

    repos.setFolderPath('/project-a/');
    expect(await repos.locateOrDiscover(uri('/project-a/file.ts'))).toEqual({
      repoId: 'r1',
      rootPath: '/workspace',
      relativePath: 'file.ts',
    });

    repos.setFolderPath('/project-b');
    expect(repos.locate(uri('/project-a/file.ts'))).toBeUndefined();
    expect(repos.locate(uri('/project-b/src/main.ts'))).toEqual({
      repoId: 'r1',
      rootPath: '/workspace',
      relativePath: 'src/main.ts',
    });
  });
});
