import * as assert from 'node:assert';
import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { activateExtension, hoverText, poll, waitForBlameHover, workspaceRoot } from './helpers';
import { FIXTURE } from '../fixture';

const FILE = 'provenance.txt';

function git(...args: string[]): string {
  return childProcess
    .execFileSync('git', args, { cwd: workspaceRoot().fsPath, encoding: 'utf8' })
    .trim();
}

/** The hover's markdown with its escapes removed, so it reads as shown. */
async function shownHover(uri: vscode.Uri, line: number): Promise<string> {
  const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
    'vscode.executeHoverProvider',
    uri,
    new vscode.Position(line, 0),
  );
  return hoverText(hovers).replace(/\\(.)/g, '$1');
}

async function waitForShownHover(
  uri: vscode.Uri,
  line: number,
  accept: (text: string) => boolean,
  what: string,
): Promise<string> {
  let last = '';
  return poll(async () => {
    last = await shownHover(uri, line);
    return accept(last) ? last : undefined;
  }, `hover on line ${line} never ${what}`).catch((error: Error) => {
    throw new Error(`${error.message}; last hover: ${JSON.stringify(last)}`);
  });
}

// What commits declare about who wrote them, read by the real engine from the
// fixture repository: a Co-authored-by trailer on one commit and a git-ai
// note on the next, shown in the blame hover and hidden by the setting.
describe('declared provenance', () => {
  let uri: vscode.Uri;

  before(async () => {
    await activateExtension();
    await waitForBlameHover(vscode.Uri.joinPath(workspaceRoot(), FIXTURE.blameFile));
    const root = workspaceRoot().fsPath;
    fs.writeFileSync(path.join(root, FILE), 'written with an agent\n');
    git('add', FILE);
    git(
      'commit',
      '-q',
      '-m',
      'add provenance.txt',
      '-m',
      'Co-authored-by: Claude Opus 4.7 <noreply@anthropic.com>',
    );
    fs.appendFileSync(path.join(root, FILE), 'written in a git-ai session\n');
    git('commit', '-q', '-am', 'extend provenance.txt');
    const note = path.join(root, '.git', 'GG_E2E_NOTE');
    fs.writeFileSync(
      note,
      [
        FILE,
        '  s_c9883b05a2487d::t_9f8e7d6c5b4a32 2',
        '---',
        JSON.stringify({
          schema_version: 'authorship/3.0.0',
          base_commit_sha: git('rev-parse', 'HEAD~1'),
          prompts: {},
          sessions: {
            s_c9883b05a2487d: { agent_id: { tool: 'cursor', id: 'e2e-session', model: 'gpt-5' } },
          },
        }),
        '',
      ].join('\n'),
    );
    git('notes', '--ref=ai', 'add', '-F', note, 'HEAD');
    uri = vscode.Uri.joinPath(workspaceRoot(), FILE);
  });

  after(async () => {
    await vscode.workspace
      .getConfiguration('gitglasses')
      .update('provenance.enabled', undefined, vscode.ConfigurationTarget.Workspace);
  });

  it('shows the co-author a commit declares in the blame hover', async () => {
    const text = await waitForShownHover(
      uri,
      0,
      (t) => t.includes('declared via'),
      'showed a declaration',
    );
    assert.ok(
      text.includes('**AI-assisted** (declared via Co-authored-by: Claude Opus 4.7)'),
      text,
    );
  });

  it('reads a git-ai note ahead of the trailers', async () => {
    const text = await waitForShownHover(
      uri,
      1,
      (t) => t.includes('declared via'),
      'showed a declaration',
    );
    assert.ok(text.includes('(declared via git-ai note: Cursor · gpt-5)'), text);
  });

  it('hides provenance once it is turned off', async () => {
    await vscode.workspace
      .getConfiguration('gitglasses')
      .update('provenance.enabled', false, vscode.ConfigurationTarget.Workspace);
    const text = await waitForShownHover(
      uri,
      0,
      (t) => t.includes('add provenance.txt') && !t.includes('declared via'),
      'dropped the declaration',
    );
    assert.ok(!text.includes('AI-assisted'), text);
  });

  it('offers to fetch git-ai notes', async () => {
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes('gitglasses.provenance.fetchNotes'));
  });
});
