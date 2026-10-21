import * as assert from 'node:assert';
import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { activateExtension, poll, waitForBlameHover, workspaceRoot } from './helpers';
import { FIXTURE } from '../fixture';

function git(...args: string[]): string {
  return childProcess
    .execFileSync('git', args, { cwd: workspaceRoot().fsPath, encoding: 'utf8' })
    .trim();
}

function hasBranch(bare: string, branch: string): boolean {
  try {
    childProcess.execFileSync('git', ['rev-parse', '--verify', '-q', `refs/heads/${branch}`], {
      cwd: bare,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

/** A new branch whose pushes go to `remote` at `url`; undone afterwards. */
function branchPushingTo(branch: string, remote: string, url: string): () => void {
  const previous = git('rev-parse', '--abbrev-ref', 'HEAD');
  git('remote', 'add', remote, url);
  git('switch', '-q', '-c', branch);
  git('config', `branch.${branch}.pushRemote`, remote);
  return () => {
    git('switch', '-q', previous);
    git('branch', '-q', '-D', branch);
    git('remote', 'remove', remote);
  };
}

// Home's Push publishes a branch that tracks nothing to the remote git's
// config names for it, with the engine's real git behind it.
describe('push and publish', () => {
  let scratch: string;

  before(async () => {
    await activateExtension();
    // Blame answering means the engine has discovered the workspace repo.
    await waitForBlameHover(vscode.Uri.joinPath(workspaceRoot(), FIXTURE.blameFile));
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'gitglasses-e2e-sync-'));
  });

  after(() => {
    // On Windows a git process that is still exiting can hold the remotes
    // open for a moment; a directory left in the temp folder fails nothing.
    try {
      fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch (error) {
      console.warn(`could not remove ${scratch}: ${String(error)}`);
    }
  });

  it('publishes a new branch to the remote its config names', async () => {
    const bare = path.join(scratch, 'publish.git');
    childProcess.execFileSync('git', ['init', '-q', '--bare', bare]);
    const undo = branchPushingTo('e2e-publish', 'e2e-sync', bare);
    try {
      await vscode.commands.executeCommand('gitglasses.home.push');
      await poll(
        async () => (hasBranch(bare, 'e2e-publish') ? true : undefined),
        'Push never published the branch to its pushRemote',
      );
      assert.strictEqual(git('config', 'branch.e2e-publish.remote'), 'e2e-sync');
    } finally {
      undo();
    }
  });

  // The whole credential path: git runs an ssh stand-in that asks to trust
  // the host through SSH_ASKPASS, which is the engine's shim; the engine
  // asks the extension, the extension shows the question, and the answer
  // travels back to ssh. sh-scripted, so not on Windows.
  it('asks to trust an unknown ssh host and connects once the user agrees', async function () {
    if (process.platform === 'win32') this.skip();
    const bare = path.join(scratch, 'ssh.git');
    childProcess.execFileSync('git', ['init', '-q', '--bare', bare]);
    const fakeSsh = path.join(scratch, 'fake-ssh');
    fs.writeFileSync(
      fakeSsh,
      [
        '#!/bin/sh',
        'answer=$("$SSH_ASKPASS" "The authenticity of host \'fakehost (127.0.0.1)\' can\'t be established.',
        'ED25519 key fingerprint is SHA256:e2eFakeFingerprint.',
        'Are you sure you want to continue connecting (yes/no/[fingerprint])? ")',
        '[ "$answer" = yes ] || { echo "Host key verification failed." >&2; exit 255; }',
        'shift',
        'exec sh -c "$1"',
        '',
      ].join('\n'),
      { mode: 0o755 },
    );
    const undo = branchPushingTo('e2e-ssh', 'e2e-ssh', `fakehost:${bare}`);
    git('config', 'core.sshCommand', fakeSsh);
    git('config', 'ssh.variant', 'simple');
    try {
      const pushed = vscode.commands.executeCommand('gitglasses.home.push');
      // Accepting the pick's first item is the "trust and connect" answer.
      await poll(async () => {
        await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
        return hasBranch(bare, 'e2e-ssh') ? true : undefined;
      }, 'the host-key question was never asked or its answer never reached ssh');
      await pushed;
    } finally {
      git('config', '--unset', 'core.sshCommand');
      git('config', '--unset', 'ssh.variant');
      undo();
    }
  });
});
