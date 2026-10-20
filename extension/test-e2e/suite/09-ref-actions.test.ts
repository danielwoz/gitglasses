import * as assert from 'node:assert';
import * as vscode from 'vscode';
import { FIXTURE } from '../fixture';
import {
  activateExtension,
  listRepositories,
  poll,
  waitForBlameHover,
  workspaceRoot,
} from './helpers';

// The actions on the Branches, Remotes, Tags and Stashes views, driven the
// way the tree's context menus drive them.

const COMMANDS = [
  'gitglasses.branch.checkout',
  'gitglasses.branch.create',
  'gitglasses.branch.rename',
  'gitglasses.branch.delete',
  'gitglasses.branch.merge',
  'gitglasses.branch.rebase',
  'gitglasses.branch.push',
  'gitglasses.branch.setUpstream',
  'gitglasses.branch.openOnRemote',
  'gitglasses.ref.compareWithHead',
  'gitglasses.ref.compareWithWorkingTree',
  'gitglasses.tag.create',
  'gitglasses.tag.delete',
  'gitglasses.tag.push',
  'gitglasses.tag.deleteRemote',
  'gitglasses.tag.checkout',
  'gitglasses.stash.apply',
  'gitglasses.stash.pop',
  'gitglasses.stash.drop',
  'gitglasses.stash.show',
  'gitglasses.stash.create',
  'gitglasses.remote.fetch',
  'gitglasses.remote.prune',
  'gitglasses.remote.add',
  'gitglasses.remote.remove',
  'gitglasses.remote.openOnHost',
];

function activeTabLabel(): string | undefined {
  return vscode.window.tabGroups.activeTabGroup.activeTab?.label;
}

describe('ref view actions', () => {
  it('registers the view commands', async () => {
    await activateExtension();
    const all = await vscode.commands.getCommands(true);
    for (const command of COMMANDS) assert.ok(all.includes(command), `${command} is missing`);
  });

  it('compares a revision with HEAD in one multi-file diff', async () => {
    await activateExtension();
    // Blame proves the engine has discovered the repo the views act on.
    await waitForBlameHover(vscode.Uri.joinPath(workspaceRoot(), FIXTURE.blameFile));
    // The workspace's own repository: the outermost of those listed.
    const [repo] = (await listRepositories()).sort((a, b) => a.rootPath.length - b.rootPath.length);
    assert.ok(repo, 'no repository to act on');
    // Two commits back: before the rename and the submodule.
    const node = {
      item: {},
      repo: { repoId: repo.repoId, rootPath: repo.rootPath },
      ref: { kind: 'branch', name: 'HEAD~2', current: false },
    };
    void vscode.commands.executeCommand('gitglasses.ref.compareWithHead', node);
    const label = await poll(async () => {
      const current = activeTabLabel();
      return current?.startsWith('HEAD ↔ HEAD~2') ? current : undefined;
    }, `the comparison never opened (active tab: ${activeTabLabel()})`);
    assert.ok(label.startsWith('HEAD ↔ HEAD~2'), label);
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  });
});
