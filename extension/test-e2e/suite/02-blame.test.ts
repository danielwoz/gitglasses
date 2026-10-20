import * as assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as vscode from 'vscode';
import { FIXTURE } from '../fixture';
import {
  activateExtension,
  hoverText,
  poll,
  waitForBlameHover,
  waitForLocate,
  workspaceRoot,
} from './helpers';

/** What the current-line blame shows (LineBlameState in src/annotations/lineBlame.ts). */
interface LineBlameState {
  uri: string;
  line: number;
  inline: string;
  statusBar: string;
  statusBarVisible: boolean;
}

function revParse(spec: string): string {
  return execFileSync('git', ['rev-parse', spec], { cwd: workspaceRoot().fsPath })
    .toString()
    .trim();
}

async function hoverAt(uri: vscode.Uri, line: number): Promise<string> {
  const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
    'vscode.executeHoverProvider',
    uri,
    new vscode.Position(line, 0),
  );
  return hoverText(hovers);
}

/** Polls the hover on `line` until `accept` holds, failing with what it last saw. */
async function waitForHover(
  uri: vscode.Uri,
  line: number,
  accept: (text: string) => boolean,
  what: string,
): Promise<string> {
  let last = '';
  return poll(
    async () => {
      last = await hoverAt(uri, line);
      return accept(last) ? last : undefined;
    },
    `hover on line ${line} never showed ${what}; last: ${JSON.stringify(last)}`,
  ).catch((error: Error) => {
    throw new Error(`${error.message}; last hover: ${JSON.stringify(last)}`);
  });
}

async function lineBlameState(): Promise<LineBlameState | undefined> {
  return vscode.commands.executeCommand<LineBlameState | undefined>('_gitglasses.lineBlameState');
}

async function waitForLineBlame(
  accept: (state: LineBlameState) => boolean,
  what: string,
): Promise<LineBlameState> {
  let last: LineBlameState | undefined;
  return poll(async () => {
    last = await lineBlameState();
    return last && accept(last) ? last : undefined;
  }, `current-line blame never showed ${what}`).catch((error: Error) => {
    throw new Error(`${error.message}; last: ${JSON.stringify(last)}`);
  });
}

async function openBlameFile(): Promise<vscode.TextEditor> {
  const uri = vscode.Uri.joinPath(workspaceRoot(), FIXTURE.blameFile);
  const document = await vscode.workspace.openTextDocument(uri);
  return vscode.window.showTextDocument(document);
}

/** Types `text` at the start of the file a key at a time, like a person. */
async function typeAtTop(editor: vscode.TextEditor, text: string): Promise<void> {
  editor.selection = new vscode.Selection(0, 0, 0, 0);
  for (const char of text) {
    await vscode.commands.executeCommand('type', { text: char });
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
}

/** Puts the blame file back to its committed contents, saved. */
async function restoreBlameFile(editor: vscode.TextEditor): Promise<void> {
  const document = editor.document;
  const whole = new vscode.Range(0, 0, document.lineCount, 0);
  await editor.edit((edit) => edit.replace(whole, FIXTURE.blameFileHeadContents));
  await document.save();
  assert.strictEqual(fs.readFileSync(document.uri.fsPath, 'utf8'), FIXTURE.blameFileHeadContents);
}

const isUncommitted = (text: string): boolean => text.includes('Uncommitted changes');

describe('blame pipeline', () => {
  let firstSha = '';
  let secondSha = '';

  before(async () => {
    await activateExtension();
    // By message: the harness may add commits of its own on top.
    firstSha = revParse(':/^add alpha, tracked, beta');
    secondSha = revParse(':/^revise alpha');
  });

  afterEach(async () => {
    await vscode.commands.executeCommand('workbench.action.files.revert');
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  it('serves commit attribution through the hover provider', async () => {
    const editor = await openBlameFile();
    const uri = editor.document.uri;
    // The engine boots, discovers the repo, and blames the file
    // asynchronously; the hover probe polls until it answers.
    await waitForBlameHover(uri);
    const text = await waitForHover(
      uri,
      0,
      (t) => t.includes(FIXTURE.authorName) && t.includes(firstSha.slice(0, 7)),
      `${FIXTURE.authorName} and ${firstSha.slice(0, 7)}`,
    );
    assert.ok(text.includes('add alpha, tracked, beta'), text);
  });

  it('links the hover to the commit, its changes, the previous revision and the sha', async () => {
    const editor = await openBlameFile();
    const text = await waitForHover(
      editor.document.uri,
      1,
      (t) => t.includes(secondSha.slice(0, 7)),
      `commit ${secondSha.slice(0, 7)}`,
    );
    for (const command of [
      'gitglasses.showCommitDetails',
      'gitglasses.blame.openChanges',
      'gitglasses.blame.previousRevision',
      'gitglasses.copySha',
    ]) {
      assert.ok(text.includes(`command:${command}?`), `hover lacks a ${command} link: ${text}`);
    }
    assert.ok(text.includes('**revise alpha**'), text);
  });

  it('shows a line typed at the top as uncommitted, without another keystroke', async () => {
    const editor = await openBlameFile();
    const uri = editor.document.uri;
    await waitForBlameHover(uri);
    await typeAtTop(editor, 'new line\n');
    await waitForHover(uri, 0, isUncommitted, 'Uncommitted changes');
    const shifted = await waitForHover(
      uri,
      1,
      (t) => t.includes(firstSha.slice(0, 7)),
      `the first commit on the shifted line`,
    );
    assert.ok(!isUncommitted(shifted), shifted);
    editor.selection = new vscode.Selection(0, 0, 0, 0);
    await waitForLineBlame(
      (s) => s.line === 0 && s.inline === 'You • Uncommitted changes',
      'the uncommitted first line',
    );
  });

  it('keeps blame right when the file is saved straight after typing', async () => {
    const editor = await openBlameFile();
    const uri = editor.document.uri;
    await waitForBlameHover(uri);
    await typeAtTop(editor, 'first new\n');
    await new Promise((resolve) => setTimeout(resolve, 600));
    await typeAtTop(editor, 'second new\n');
    await editor.document.save();
    try {
      await waitForHover(uri, 0, isUncommitted, 'Uncommitted changes on the saved new line');
      await waitForHover(uri, 1, isUncommitted, 'Uncommitted changes on the first saved line');
      await waitForHover(
        uri,
        4,
        (t) => t.includes(firstSha.slice(0, 7)),
        `${firstSha.slice(0, 7)} on "alpha three"`,
      );
    } finally {
      await restoreBlameFile(editor);
    }
    await waitForHover(
      uri,
      0,
      (t) => t.includes(firstSha.slice(0, 7)),
      'the committed first line again after the restore',
    );
  });

  it('drops unsaved blame when the file is reverted', async () => {
    const editor = await openBlameFile();
    const uri = editor.document.uri;
    await typeAtTop(editor, 'scratch\n');
    await waitForHover(uri, 0, isUncommitted, 'Uncommitted changes before the revert');
    await vscode.commands.executeCommand('workbench.action.files.revert');
    assert.strictEqual(editor.document.isDirty, false);
    await waitForHover(
      uri,
      0,
      (t) => t.includes(firstSha.slice(0, 7)) && !isUncommitted(t),
      'the committed first line after the revert',
    );
  });

  it('renders current-line blame with the configured format, in the status bar per setting', async () => {
    const editor = await openBlameFile();
    editor.selection = new vscode.Selection(1, 0, 1, 0);
    const state = await waitForLineBlame(
      (s) => s.line === 1 && s.inline.endsWith('• revise alpha'),
      'the second commit on line 1',
    );
    assert.match(state.inline, /^Ada Lovelace, .+ ago • revise alpha$/);
    // By default the item steps aside for VS Code's own status bar blame.
    const builtin = vscode.workspace.getConfiguration().get('git.blame.statusBarItem.enabled');
    assert.strictEqual(state.statusBarVisible, builtin !== true);

    const config = vscode.workspace.getConfiguration('gitglasses');
    await config.update(
      'currentLine.format',
      '${sha} by ${author}',
      vscode.ConfigurationTarget.Workspace,
    );
    await config.update('statusBar.blame', 'show', vscode.ConfigurationTarget.Workspace);
    try {
      await waitForLineBlame(
        (s) => s.inline === `${secondSha.slice(0, 7)} by Ada Lovelace` && s.statusBarVisible,
        'the custom format, with the status bar item shown',
      );
    } finally {
      await config.update('currentLine.format', undefined, vscode.ConfigurationTarget.Workspace);
      await config.update('statusBar.blame', undefined, vscode.ConfigurationTarget.Workspace);
    }
  });

  it('turns inline blame off and on through its setting', async () => {
    const editor = await openBlameFile();
    editor.selection = new vscode.Selection(0, 0, 0, 0);
    await waitForLineBlame((s) => s.line === 0, 'line 0');
    await vscode.commands.executeCommand('gitglasses.toggleLineBlame');
    try {
      assert.strictEqual(
        vscode.workspace.getConfiguration('gitglasses').get('currentLine.enabled'),
        false,
      );
      await poll(
        async () => ((await lineBlameState()) === undefined ? true : undefined),
        'inline blame stayed on after the toggle',
      );
    } finally {
      await vscode.commands.executeCommand('gitglasses.toggleLineBlame');
    }
    assert.strictEqual(
      vscode.workspace.getConfiguration('gitglasses').get('currentLine.enabled'),
      true,
    );
    await waitForLineBlame((s) => s.line === 0, 'line 0 after turning it back on');
    // Leave the setting as the fixture had it: unset.
    const inspected = vscode.workspace
      .getConfiguration('gitglasses')
      .inspect('currentLine.enabled');
    if (inspected?.globalValue !== undefined) {
      await vscode.workspace
        .getConfiguration('gitglasses')
        .update('currentLine.enabled', undefined, vscode.ConfigurationTarget.Global);
    }
  });

  it('compares the hovered document with HEAD from an uncommitted line', async () => {
    const dirty = vscode.Uri.joinPath(workspaceRoot(), FIXTURE.dirtyFile);
    await vscode.window.showTextDocument(dirty);
    const text = await waitForHover(dirty, 1, isUncommitted, 'the uncommitted local edit');
    const match = /\(command:gitglasses\.diffWithHead\?([^ )]+)/.exec(text);
    assert.ok(match, `no open-changes link: ${text}`);
    const [args] = JSON.parse(decodeURIComponent(match[1])) as unknown[];
    // Another editor has the focus when the link is clicked.
    await openBlameFile();
    await vscode.commands.executeCommand('gitglasses.diffWithHead', args);
    const input = await poll(async () => {
      const tab = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
      return tab instanceof vscode.TabInputTextDiff ? tab : undefined;
    }, 'Open Changes opened no diff');
    assert.strictEqual(input.modified.toString(), dirty.toString());
    const original = await vscode.workspace.openTextDocument(input.original);
    assert.strictEqual(original.getText(), FIXTURE.dirtyFileCommittedContents);
  });

  it('offers blame CodeLens for tracked files only', async () => {
    const tracked = vscode.Uri.joinPath(workspaceRoot(), FIXTURE.blameFile);
    await vscode.window.showTextDocument(tracked);
    const lenses = await poll(async () => {
      const found = await vscode.commands.executeCommand<vscode.CodeLens[]>(
        'vscode.executeCodeLensProvider',
        tracked,
      );
      const ours = (found ?? []).filter((l) => l.command?.command === 'gitglasses.toggleFileBlame');
      return ours.length > 0 ? ours : undefined;
    }, 'no blame CodeLens on the tracked file');
    assert.match(lenses[0].command?.title ?? '', /^1 author \(Ada Lovelace, .+\)$/);

    const untracked = vscode.Uri.joinPath(workspaceRoot(), 'untracked-e2e.txt');
    fs.writeFileSync(untracked.fsPath, 'not in git\n');
    try {
      await waitForLocate(untracked);
      await vscode.window.showTextDocument(untracked);
      // Give the provider every chance to answer before checking it offered nothing.
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const found = await vscode.commands.executeCommand<vscode.CodeLens[]>(
        'vscode.executeCodeLensProvider',
        untracked,
      );
      const ours = (found ?? []).filter((l) => l.command?.command === 'gitglasses.toggleFileBlame');
      assert.deepStrictEqual(
        ours.map((l) => l.command?.title),
        [],
        'an untracked file got a blame lens',
      );
    } finally {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      fs.rmSync(untracked.fsPath, { force: true });
    }
  });

  it('blames the file as it was before a commit', async () => {
    const editor = await openBlameFile();
    const text = await waitForHover(
      editor.document.uri,
      1,
      (t) => t.includes(secondSha.slice(0, 7)),
      `commit ${secondSha.slice(0, 7)}`,
    );
    const match = /\(command:gitglasses\.blame\.previousRevision\?([^ )]+)/.exec(text);
    assert.ok(match, `no previous-revision link: ${text}`);
    const [args] = JSON.parse(decodeURIComponent(match[1])) as unknown[];
    await vscode.commands.executeCommand('gitglasses.blame.previousRevision', args);
    const previous = vscode.window.activeTextEditor;
    assert.ok(previous && previous.document.uri.scheme === 'gitglasses');
    assert.strictEqual(previous.document.getText(), FIXTURE.blameFileInitialContents);
    // Blame continues in the earlier revision: its lines all come from the
    // first commit.
    await waitForHover(
      previous.document.uri,
      1,
      (t) => t.includes(firstSha.slice(0, 7)),
      `commit ${firstSha.slice(0, 7)} in the previous revision`,
    );
  });

  it("opens the commit's change to the file from the hover", async () => {
    const editor = await openBlameFile();
    const text = await waitForHover(
      editor.document.uri,
      1,
      (t) => t.includes(secondSha.slice(0, 7)),
      `commit ${secondSha.slice(0, 7)}`,
    );
    const match = /\(command:gitglasses\.blame\.openChanges\?([^ )]+)/.exec(text);
    assert.ok(match, `no open-changes link: ${text}`);
    const [args] = JSON.parse(decodeURIComponent(match[1])) as unknown[];
    await vscode.commands.executeCommand('gitglasses.blame.openChanges', args);
    const input = await poll(async () => {
      const tab = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
      return tab instanceof vscode.TabInputTextDiff ? tab : undefined;
    }, 'Open Changes opened no diff');
    const [left, right] = await Promise.all([
      vscode.workspace.openTextDocument(input.original),
      vscode.workspace.openTextDocument(input.modified),
    ]);
    assert.strictEqual(left.getText(), FIXTURE.blameFileInitialContents);
    assert.strictEqual(right.getText(), FIXTURE.blameFileHeadContents);
  });

  it('opens the change of a commit that added the file, and offers no earlier revision', async () => {
    // The submodule commit, which is not the root commit, adds .gitmodules;
    // the root commit adds the blame file.
    const cases = [
      {
        uri: vscode.Uri.joinPath(workspaceRoot(), '.gitmodules'),
        sha: revParse(':/^add submodule'),
      },
      { uri: vscode.Uri.joinPath(workspaceRoot(), FIXTURE.blameFile), sha: firstSha },
    ];
    for (const { uri, sha } of cases) {
      const name = uri.path.split('/').pop() ?? '';
      await vscode.window.showTextDocument(uri);
      const text = await waitForHover(
        uri,
        0,
        (t) => t.includes(sha.slice(0, 7)),
        `commit ${sha.slice(0, 7)} in ${name}`,
      );
      assert.ok(
        !text.includes('command:gitglasses.blame.previousRevision?'),
        `a previous-revision link for a file the commit added: ${text}`,
      );
      const match = /\(command:gitglasses\.blame\.openChanges\?([^ )]+)/.exec(text);
      assert.ok(match, `no open-changes link: ${text}`);
      const [args] = JSON.parse(decodeURIComponent(match[1])) as unknown[];
      await vscode.commands.executeCommand('gitglasses.blame.openChanges', args);
      const input = await poll(async () => {
        const tab = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
        return tab instanceof vscode.TabInputTextDiff && tab.modified.path === `/${name}`
          ? tab
          : undefined;
      }, `Open Changes opened no diff for ${name}`);
      const [left, right] = await Promise.all([
        vscode.workspace.openTextDocument(input.original),
        vscode.workspace.openTextDocument(input.modified),
      ]);
      assert.strictEqual(left.getText(), '');
      assert.strictEqual(
        right.getText(),
        execFileSync('git', ['show', `${sha}:${name}`], {
          cwd: workspaceRoot().fsPath,
        }).toString(),
      );
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    }
  });
});
