import * as assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { FIXTURE } from '../fixture';
import { activateExtension, poll, waitForBlameHover, workspaceRoot } from './helpers';

// The Worktrees view with linked worktrees beside the fixture: each row's
// status at a glance, and the comparison with the base its context menu
// opens.

interface Row {
  label: string;
  description: string;
  tooltip: string;
  contextValue: string;
  loading: number;
  node: unknown;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' },
  }).trim();
}

/** One file a comparison opened: the label URI and its two sides. */
type ComparedFile = [vscode.Uri, vscode.Uri | undefined, vscode.Uri | undefined];

function rows(): Thenable<Row[]> {
  return vscode.commands.executeCommand<Row[]>('_gitglasses.worktreeRows');
}

describe('worktrees view', () => {
  let scratch = '';
  let mainBranch = '';
  const cleanDir = (): string => path.join(scratch, 'agent-clean');
  const conflictDir = (): string => path.join(scratch, 'agent-conflict');

  before(() => {
    const root = workspaceRoot().fsPath;
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'gitglasses-e2e-worktrees-'));
    mainBranch = git(root, 'branch', '--show-current');
    // An agent's worktree one commit behind with a commit of its own and
    // uncommitted work, named the way `claude --worktree agent-clean` names
    // its branch.
    git(root, 'worktree', 'add', '-q', '-b', 'worktree-agent-clean', cleanDir(), 'HEAD~1');
    fs.writeFileSync(path.join(cleanDir(), 'agent.txt'), 'agent work\n');
    git(cleanDir(), 'add', 'agent.txt');
    git(cleanDir(), 'commit', '-q', '-m', 'agent work');
    fs.writeFileSync(path.join(cleanDir(), 'notes.txt'), 'not committed\n');
    // One that edits the line the base revised since.
    git(root, 'worktree', 'add', '-q', '-b', 'agent-conflict', conflictDir(), 'HEAD~3');
    fs.writeFileSync(
      path.join(conflictDir(), FIXTURE.blameFile),
      FIXTURE.blameFileInitialContents.replace('alpha two', 'alpha two by the agent'),
    );
    git(conflictDir(), 'commit', '-q', '-am', 'agent edit');
  });

  after(() => {
    const root = workspaceRoot().fsPath;
    for (const dir of [cleanDir(), conflictDir()]) {
      git(root, 'worktree', 'remove', '--force', dir);
    }
    git(root, 'branch', '-D', 'worktree-agent-clean', 'agent-conflict');
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  it("shows each worktree's status at a glance", async () => {
    await activateExtension();
    // Blame proves the engine has discovered the repository the view lists.
    await waitForBlameHover(vscode.Uri.joinPath(workspaceRoot(), FIXTURE.blameFile));
    await vscode.commands.executeCommand('gitglasses.refreshViews');
    const listed = await poll(
      async () => {
        const current = await rows();
        const clean = current.find((row) => row.label === 'worktree-agent-clean');
        const conflict = current.find((row) => row.label === 'agent-conflict');
        return clean?.description.includes('merges cleanly') &&
          conflict?.description.includes('conflicts')
          ? current
          : undefined;
      },
      `the worktree rows never showed their status: ${JSON.stringify(await rows())}`,
    );

    // Opened through a symlink, the workspace's own worktree is still the
    // current one.
    const main = listed.find((row) => row.contextValue === 'gitglassesCurrentWorktree');
    assert.ok(main, `no current worktree: ${JSON.stringify(listed)}`);
    assert.strictEqual(main.label, mainBranch);
    assert.match(main.description, /^current · \d+ changed · base$/);

    const clean = listed.find((row) => row.label === 'worktree-agent-clean')!;
    assert.strictEqual(clean.description, '1 changed · ↑1 ↓1 · merges cleanly · Claude Code');
    assert.strictEqual(clean.contextValue, 'gitglassesWorktree');
    assert.match(clean.tooltip, new RegExp(`Merges cleanly into ${mainBranch}`));
    assert.match(clean.tooltip, /Last activity: /);

    const conflict = listed.find((row) => row.label === 'agent-conflict')!;
    assert.strictEqual(conflict.description, '↑1 ↓3 · conflicts in 1 file');
    assert.match(
      conflict.tooltip,
      new RegExp(`Conflicts with ${mainBranch} in ${FIXTURE.blameFile}`),
    );
  });

  it('opens what a worktree changed since it left the base', async () => {
    const clean = (await rows()).find((row) => row.label === 'worktree-agent-clean');
    assert.ok(clean, 'no worktree-agent-clean row');
    const opened = vscode.commands.executeCommand<ComparedFile[] | undefined>(
      'gitglasses.worktrees.compareWithBase',
      clean.node,
    );
    const expected = `${mainBranch} ↔ worktree-agent-clean (Working Tree)`;
    const activeTab = (): string | undefined =>
      vscode.window.tabGroups.activeTabGroup.activeTab?.label;
    const label = await poll(
      async () => (activeTab()?.startsWith(expected) ? activeTab() : undefined),
      `the comparison never opened (active tab: ${activeTab()})`,
    );
    assert.ok(label.startsWith(expected), label);

    // Every side the comparison shows has content to show; a file that is
    // new in the worktree (committed or untracked) has no side at the base.
    const compared = await opened;
    assert.ok(compared, 'the comparison reported no files');
    const names = compared.map(([file]) => path.basename(file.fsPath)).sort();
    assert.deepStrictEqual(names, ['agent.txt', 'notes.txt']);
    for (const [file, left, right] of compared) {
      assert.strictEqual(left, undefined, `${file.fsPath} has a side at the base`);
      assert.ok(right, `${file.fsPath} has no working tree side`);
      const document = await vscode.workspace.openTextDocument(right);
      assert.ok(document.getText().length > 0, `${right.toString()} is empty`);
    }
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  });
});
