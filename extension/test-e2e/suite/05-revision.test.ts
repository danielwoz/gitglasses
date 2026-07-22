import * as assert from 'node:assert';
import * as vscode from 'vscode';
import { FIXTURE } from '../fixture';
import { activateExtension, poll, waitForBlameHover, workspaceRoot } from './helpers';

describe('revision content provider', () => {
  it('serves committed contents for a gitglasses: HEAD URI', async () => {
    await activateExtension();

    // Repo discovery is lazy: opening the file and waiting for a blame hover
    // guarantees the engine has registered the fixture repo. The engine hands
    // out sequential repo ids, so the single fixture repo is r1.
    const fileUri = vscode.Uri.joinPath(workspaceRoot(), FIXTURE.blameFile);
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(fileUri));
    await waitForBlameHover(fileUri);

    const expected = FIXTURE.blameFileHeadContents;
    // Each attempt appends a throwaway query param so VS Code cannot hand
    // back a cached (possibly empty) virtual document; decodeRevisionUri only
    // reads repoId and rev and ignores the extra key.
    let attempt = 0;
    const text = await poll(async () => {
      attempt += 1;
      const revisionUri = vscode.Uri.from({
        scheme: 'gitglasses',
        path: `/${FIXTURE.blameFile}`,
        query: `repoId=r1&rev=HEAD&probe=${attempt}`,
      });
      const document = await vscode.workspace.openTextDocument(revisionUri);
      const contents = document.getText();
      return contents === expected ? contents : undefined;
    }, `gitglasses:/${FIXTURE.blameFile}?repoId=r1&rev=HEAD never matched the committed contents`);

    assert.strictEqual(text, expected);
  });
});
