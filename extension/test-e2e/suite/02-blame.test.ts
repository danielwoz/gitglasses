import * as assert from 'node:assert';
import * as vscode from 'vscode';
import { FIXTURE } from '../fixture';
import { activateExtension, waitForBlameHover, workspaceRoot } from './helpers';

describe('blame pipeline', () => {
  it('serves commit attribution through the hover provider', async () => {
    await activateExtension();

    const uri = vscode.Uri.joinPath(workspaceRoot(), FIXTURE.blameFile);
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document);

    // The engine boots, discovers the repo, and blames the file
    // asynchronously; the hover probe polls until it answers.
    const text = await waitForBlameHover(uri);
    assert.ok(
      text.includes(FIXTURE.authorName) || /\b[0-9a-f]{12,40}\b/.test(text),
      `hover lacked fixture author and sha; got: ${text}`,
    );
  });
});
