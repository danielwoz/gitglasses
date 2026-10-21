import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { FIXTURE } from '../fixture';
import {
  type ListedRepo,
  activateExtension,
  listRepositories,
  poll,
  waitForBlameHover,
  waitForLocate,
  workspaceRoot,
} from './helpers';

/** Whether two paths name the same directory on disk, whatever their
 *  spelling. */
function sameDirectory(a: string, b: string): boolean {
  const left = fs.statSync(a, { bigint: true });
  const right = fs.statSync(b, { bigint: true });
  return left.dev === right.dev && left.ino === right.ino;
}

/** Whether two spellings are the same text, up to separators and the letter
 *  case Windows and macOS ignore. */
function samePath(a: string, b: string): boolean {
  const caseless = process.platform === 'win32' || process.platform === 'darwin';
  const normalize = (value: string): string => {
    const slashed = value.replace(/\\/g, '/').replace(/\/+$/, '');
    return caseless ? slashed.toLowerCase() : slashed;
  };
  return normalize(a) === normalize(b);
}

// The fixture is opened through another spelling of its directory: a symlink
// on Linux and macOS, the 8.3 short name of the temp dir on Windows CI. The
// engine reports repository roots with that resolved, and every file feature
// depends on mapping them back to the editor's spelling.
describe('repository resolution', () => {
  it('opens the workspace through an alias of the fixture directory', function () {
    if (process.env.GITGLASSES_E2E_ALIASED !== '1') this.skip();
    const root = workspaceRoot().fsPath;
    assert.notStrictEqual(fs.realpathSync.native(root), root, `${root} is not an alias`);
  });

  it('locates a file in the workspace spelling of its repository root', async () => {
    await activateExtension();
    const uri = vscode.Uri.joinPath(workspaceRoot(), FIXTURE.blameFile);
    const located = await waitForLocate(uri);
    assert.ok(
      samePath(located.rootPath, workspaceRoot().fsPath),
      `root ${located.rootPath} is not spelled like the workspace ${workspaceRoot().fsPath}`,
    );
    assert.strictEqual(located.relativePath, FIXTURE.blameFile);
  });

  it('lists the repositories below the folder root before their files are opened', async () => {
    await activateExtension();
    let last: ListedRepo[] = [];
    const settled = await poll(async () => {
      last = await listRepositories();
      const names = last.map((repo) => repo.name);
      const listed = names.includes(FIXTURE.nestedDir) && names.includes(FIXTURE.submoduleDir);
      // The folder's own repository stays first: it is the default the views
      // act on.
      const ownFirst = last.length > 0 && sameDirectory(last[0].rootPath, workspaceRoot().fsPath);
      return listed && ownFirst ? true : undefined;
    }, 'repository list').catch(() => false);
    assert.ok(
      settled,
      'expected the folder repository first, with the nested clone and the submodule; got ' +
        JSON.stringify(last),
    );
  });

  for (const inner of [
    { kind: 'nested clone', dir: FIXTURE.nestedDir, file: FIXTURE.nestedFile },
    { kind: 'submodule', dir: FIXTURE.submoduleDir, file: FIXTURE.submoduleFile },
  ]) {
    it(`resolves a file in a ${inner.kind} to that repository and blames it there`, async () => {
      await activateExtension();
      const outer = await waitForLocate(vscode.Uri.joinPath(workspaceRoot(), FIXTURE.blameFile));
      const uri = vscode.Uri.joinPath(workspaceRoot(), inner.dir, inner.file);
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));

      const located = await waitForLocate(uri);
      assert.notStrictEqual(located.repoId, outer.repoId, `${inner.dir} resolved to the parent`);
      assert.ok(
        samePath(located.rootPath, path.join(workspaceRoot().fsPath, inner.dir)),
        `root ${located.rootPath} is not ${inner.dir} in the workspace spelling`,
      );
      assert.strictEqual(located.relativePath, inner.file);

      const text = await waitForBlameHover(uri, FIXTURE.innerAuthorName);
      assert.ok(
        text.includes(FIXTURE.innerAuthorName),
        `blame did not come from the ${inner.kind}'s history: ${text}`,
      );
    });
  }
});
