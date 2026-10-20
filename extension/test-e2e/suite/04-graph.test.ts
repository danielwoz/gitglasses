import * as assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import * as vscode from 'vscode';
import { activateExtension, poll, workspaceRoot } from './helpers';

/** Open webview tabs of one of the extension's panel types. */
function webviewTabs(viewType: string): vscode.Tab[] {
  return vscode.window.tabGroups.all
    .flatMap((group) => group.tabs)
    .filter(
      (tab) => tab.input instanceof vscode.TabInputWebview && tab.input.viewType.endsWith(viewType),
    );
}

async function closeEditors(): Promise<void> {
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
}

describe('graph webview', () => {
  after(closeEditors);

  // The webview DOM is not reachable from the extension test host, so the
  // deepest observable signal is that the command that creates the panel and
  // starts streaming graph rows resolves instead of rejecting.
  it('executes showGraph without rejecting', async () => {
    await activateExtension();
    await assert.doesNotReject(
      Promise.resolve(vscode.commands.executeCommand('gitglasses.showGraph')),
      'gitglasses.showGraph rejected',
    );
  });

  it('shows a commit in the Commit Details panel and leaves the clipboard alone', async () => {
    await activateExtension();
    const root = workspaceRoot().fsPath;
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root }).toString().trim();
    await vscode.env.clipboard.writeText('clipboard sentinel');
    await vscode.commands.executeCommand('gitglasses.showCommitDetails', {
      repoPath: root,
      sha: 'HEAD',
    });
    const label = await poll(async () => {
      const current = webviewTabs('gitglasses.commitDetails')[0]?.label;
      // The title names the full sha HEAD resolved to once it has loaded.
      return current === `Commit ${head.slice(0, 7)}` ? current : undefined;
    }, 'the Commit Details panel never showed HEAD');
    assert.strictEqual(label, `Commit ${head.slice(0, 7)}`);
    assert.strictEqual(await vscode.env.clipboard.readText(), 'clipboard sentinel');

    // Showing another commit reuses the panel.
    await vscode.commands.executeCommand('gitglasses.showCommitDetails', {
      repoPath: root,
      sha: `${head}~1`,
    });
    const parent = execFileSync('git', ['rev-parse', 'HEAD~1'], { cwd: root }).toString().trim();
    await poll(async () => {
      const tabs = webviewTabs('gitglasses.commitDetails');
      return tabs.length === 1 && tabs[0].label === `Commit ${parent.slice(0, 7)}`
        ? true
        : undefined;
    }, 'the Commit Details panel did not move to the parent commit');
  });
});
