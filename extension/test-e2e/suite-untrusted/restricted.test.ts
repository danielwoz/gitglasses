import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { FIXTURE } from '../fixture';
import {
  activateExtension,
  hoverText,
  poll,
  waitForBlameHover,
  workspaceRoot,
} from '../suite/helpers';
import { mcpServiceState, startMcpServer } from '../suite/mcpClient';

// The planted workspace opens untrusted. GitGlasses must show blame without
// running any program the repository's config, attributes or hooks name, and
// must leave the repository untouched when a command that changes it is run
// anyway. Every planted program drops a file in GG_E2E_MARKERS when it runs.
describe('Restricted Mode', () => {
  const markers = process.env.GG_E2E_MARKERS ?? '';
  const ran = (): string[] => fs.readdirSync(markers);
  const settle = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

  it('opens the planted workspace untrusted', () => {
    assert.ok(markers !== '' && fs.existsSync(markers), 'GG_E2E_MARKERS is not set');
    assert.strictEqual(vscode.workspace.isTrusted, false, 'the workspace was trusted');
  });

  it('shows blame, saved and unsaved, without running anything the repository names', async () => {
    await activateExtension();
    const uri = vscode.Uri.joinPath(workspaceRoot(), FIXTURE.blameFile);
    const editor = await vscode.window.showTextDocument(uri);
    const text = await waitForBlameHover(uri);
    assert.ok(text.includes(FIXTURE.authorName), `hover lacked the fixture author: ${text}`);

    // An unsaved edit makes blame read the editor buffer, which a git blame
    // would pass through the clean filter.
    await editor.edit((edit) => edit.insert(new vscode.Position(0, 0), 'unsaved line\n'));
    await poll(async () => {
      const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
        'vscode.executeHoverProvider',
        uri,
        new vscode.Position(1, 0),
      );
      return hoverText(hovers).includes(FIXTURE.authorName) ? true : undefined;
    }, 'no blame hover for the unsaved buffer');
    await settle(2000);
    assert.deepStrictEqual(ran(), [], 'a planted program ran');
    await vscode.commands.executeCommand('workbench.action.files.revert');
  });

  it('leaves the index untouched when staging is invoked anyway', async () => {
    const index = path.join(workspaceRoot().fsPath, '.git', 'index');
    const before = fs.readFileSync(index);
    const uri = vscode.Uri.joinPath(workspaceRoot(), FIXTURE.dirtyFile);
    const editor = await vscode.window.showTextDocument(uri);
    const lastLine = Math.max(0, editor.document.lineCount - 2);
    editor.selection = new vscode.Selection(lastLine, 0, lastLine, 0);

    // The command is disabled in the UI; executeCommand bypasses that, so the
    // engine's refusal is what keeps the index as it was.
    await vscode.commands.executeCommand('gitglasses.stageSelectedHunks');
    await settle(1000);
    assert.ok(fs.readFileSync(index).equals(before), 'the index changed');
    assert.deepStrictEqual(ran(), [], 'a planted program ran');
  });

  // The graph and commit details read through libgit2 alone, so they work
  // untrusted.
  it('shows the commit graph and a commit, without running anything the repository names', async () => {
    // Waits for a tab of the panel type whose title matches.
    const webviewTab = (viewType: string, title: RegExp): Promise<string> =>
      poll(async () => {
        const tab = vscode.window.tabGroups.all
          .flatMap((group) => group.tabs)
          .find(
            (candidate) =>
              candidate.input instanceof vscode.TabInputWebview &&
              candidate.input.viewType.endsWith(viewType),
          );
        return tab && title.test(tab.label) ? tab.label : undefined;
      }, `no ${viewType} tab titled ${title}`);
    await vscode.commands.executeCommand('gitglasses.showGraph');
    await webviewTab('gitglasses.graph', /^Commit Graph — /);
    await vscode.commands.executeCommand('gitglasses.showCommitDetails', {
      repoPath: workspaceRoot().fsPath,
      sha: 'HEAD',
    });
    // The title names the sha HEAD resolved to once the commit has loaded.
    await webviewTab('gitglasses.commitDetails', /^Commit [0-9a-f]{7}$/);
    await settle(1000);
    assert.deepStrictEqual(ran(), [], 'a planted program ran');
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  // The editor's agents get the MCP server here too, allowed to run git
  // nowhere: it reads the workspace without git and refuses what needs it.
  it('gives agents the MCP server without letting it run git', async () => {
    const { status, launch } = await mcpServiceState();
    assert.deepStrictEqual(status.gitRoots ?? [], [], 'git allowed in an untrusted workspace');
    assert.ok(launch, 'no launch');
    assert.strictEqual(launch.env.GITGLASSES_ALLOWED_ROOTS, '');
    assert.strictEqual(launch.args.length, 1, `git allowed somewhere: ${launch.args.join(' ')}`);

    const root = workspaceRoot().fsPath;
    const session = await startMcpServer(launch, root);
    try {
      const blame = await session.callTool('git_blame', {
        repoPath: root,
        file: FIXTURE.blameFile,
      });
      assert.ok(blame.includes(FIXTURE.authorName), `git_blame: ${blame}`);
      const status = await session.callTool('git_status', { repoPath: root });
      assert.ok(status.includes(FIXTURE.dirtyFile), `git_status: ${status}`);
      await assert.rejects(
        session.callTool('git_file_history', { repoPath: root, file: FIXTURE.blameFile }),
        /needs git/,
      );
    } finally {
      session.close();
    }
    await settle(1000);
    assert.deepStrictEqual(ran(), [], 'a planted program ran');
  });
});
