import * as assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { activateExtension, listRepositories, poll, workspaceRoot } from './helpers';

/** Open webview tabs of one of the extension's panel types. */
function webviewTabs(viewType: string): vscode.Tab[] {
  return vscode.window.tabGroups.all
    .flatMap((group) => group.tabs)
    .filter(
      (tab) => tab.input instanceof vscode.TabInputWebview && tab.input.viewType.endsWith(viewType),
    );
}

function tabLabel(viewType: string): Promise<string> {
  return poll(async () => webviewTabs(viewType)[0]?.label, `no ${viewType} tab opened`);
}

async function closeEditors(): Promise<void> {
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
}

/** Picks the `index`th entry of Select Repository's quick pick. */
async function selectRepository(index: number): Promise<void> {
  const picked = vscode.commands.executeCommand('gitglasses.selectRepository');
  // The quick pick opens once the repository list resolves.
  await new Promise((resolve) => setTimeout(resolve, 1000));
  for (let i = 0; i < index; i++) {
    await vscode.commands.executeCommand('workbench.action.quickOpenSelectNext');
  }
  await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
  await picked;
}

describe('graph webview', () => {
  after(closeEditors);

  // The webview DOM is not reachable from the extension test host; the tabs
  // and their titles are what the panels show of their state.
  it('opens the graph in a tab named after the repository', async () => {
    await activateExtension();
    await vscode.commands.executeCommand('gitglasses.showGraph');
    const label = await tabLabel('gitglasses.graph');
    assert.strictEqual(label, `Commit Graph — ${path.basename(workspaceRoot().fsPath)}`);
  });

  it('follows Select Repository to another repository', async function () {
    const repos = await listRepositories();
    if (repos.length < 2) this.skip();
    await vscode.commands.executeCommand('gitglasses.showGraph');
    const before = await tabLabel('gitglasses.graph');
    try {
      await selectRepository(1);
      const after = await poll(async () => {
        const label = webviewTabs('gitglasses.graph')[0]?.label;
        return label && label !== before ? label : undefined;
      }, 'the graph kept its repository after Select Repository');
      assert.ok(
        repos.slice(1).some((repo) => after === `Commit Graph — ${repo.name}`),
        `unexpected graph title ${after}`,
      );
    } finally {
      // The later suites expect the workspace folder's repository.
      await selectRepository(0);
      await poll(async () => {
        const label = webviewTabs('gitglasses.graph')[0]?.label;
        return label === before ? label : undefined;
      }, 'the graph did not return to the first repository');
    }
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
