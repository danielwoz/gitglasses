import * as assert from 'node:assert';
import * as vscode from 'vscode';
import { FIXTURE } from '../fixture';
import { activateExtension, poll, waitForBlameHover, workspaceRoot } from './helpers';

/** The parts of the story gitglasses.showLineStory resolves with that the
 *  suite reads (LineStory in packages/integrations/src/lineStory.ts). */
interface Story {
  line: number;
  lineText?: string;
  blame: { sha: string; summary: string; originalLine: number };
  commit: { state: string; value?: { subject: string } };
  pullRequests: { state: string; forge?: { name: string } };
  issues: { state: string };
  history: {
    state: string;
    value?: { versions: { summary: string; patch?: string }[]; more: boolean };
  };
}

/** The title of the open Line Story tab. */
function storyTab(): Promise<string> {
  return poll(async () => {
    const tab = vscode.window.tabGroups.all
      .flatMap((group) => group.tabs)
      .find(
        (candidate) =>
          candidate.input instanceof vscode.TabInputWebview &&
          candidate.input.viewType.endsWith('gitglasses.lineStory'),
      );
    return tab?.label;
  }, 'no Line Story tab opened');
}

describe('line story', () => {
  const uri = (): vscode.Uri => vscode.Uri.joinPath(workspaceRoot(), FIXTURE.blameFile);

  after(() => vscode.commands.executeCommand('workbench.action.closeAllEditors'));

  it('offers "Why this line?" in the blame hover', async () => {
    await activateExtension();
    await vscode.window.showTextDocument(uri());
    const text = await waitForBlameHover(uri());
    assert.ok(text.includes('command:gitglasses.showLineStory'), `hover lacked the link: ${text}`);
  });

  it('tells a line its commit, its earlier versions and how to see its pull request', async () => {
    const story = await vscode.commands.executeCommand<Story>('gitglasses.showLineStory', {
      uri: uri().toString(),
      line: 2,
    });
    assert.ok(story, 'the command resolved without a story');
    assert.strictEqual(story.lineText, 'alpha two revised');
    assert.strictEqual(story.blame.summary, 'revise alpha');
    assert.strictEqual(story.commit.state, 'ready');
    assert.strictEqual(story.commit.value?.subject, 'revise alpha');
    // The fixture's origin is on github.com, and no integration is connected.
    assert.strictEqual(story.pullRequests.state, 'notConnected');
    assert.strictEqual(story.pullRequests.forge?.name, 'GitHub');
    assert.strictEqual(story.issues.state, 'ready');
    assert.strictEqual(story.history.state, 'ready');
    const versions = story.history.value?.versions ?? [];
    assert.deepStrictEqual(
      versions.map((version) => version.summary),
      ['revise alpha', 'add alpha, tracked, beta'],
    );
    assert.ok(versions[0].patch?.includes('+alpha two revised'), versions[0].patch);
    assert.ok(versions[1].patch?.includes('+alpha two'), versions[1].patch);
    assert.strictEqual(await storyTab(), `Why ${FIXTURE.blameFile}:2?`);
  });

  it("tells the cursor line's story from the command palette", async () => {
    const editor = await vscode.window.showTextDocument(uri(), {
      viewColumn: vscode.ViewColumn.One,
    });
    editor.selection = new vscode.Selection(3, 2, 3, 2);
    const story = await vscode.commands.executeCommand<Story>('gitglasses.showLineStory');
    assert.strictEqual(story?.line, 4);
    assert.strictEqual(story?.lineText, 'alpha four');
    assert.deepStrictEqual(
      story?.history.value?.versions.map((version) => version.summary),
      ['revise alpha'],
    );
    assert.strictEqual(
      await poll(async () => {
        const label = await storyTab();
        return label === `Why ${FIXTURE.blameFile}:4?` ? label : undefined;
      }, 'the Line Story tab kept its old title'),
      `Why ${FIXTURE.blameFile}:4?`,
    );
  });

  it('says a line with uncommitted changes has no story yet', async () => {
    const dirty = vscode.Uri.joinPath(workspaceRoot(), FIXTURE.dirtyFile);
    const editor = await vscode.window.showTextDocument(dirty, {
      viewColumn: vscode.ViewColumn.One,
    });
    await editor.edit((edit) => edit.insert(new vscode.Position(0, 0), 'unsaved story line\n'));
    try {
      const story = await vscode.commands.executeCommand<Story>('gitglasses.showLineStory', {
        uri: dirty.toString(),
        line: 1,
      });
      assert.strictEqual(story?.lineText, 'unsaved story line');
      assert.strictEqual(story?.commit.state, 'unavailable');
      assert.strictEqual(story?.history.state, 'unavailable');
    } finally {
      await vscode.window.showTextDocument(dirty, { viewColumn: vscode.ViewColumn.One });
      await vscode.commands.executeCommand('workbench.action.files.revert');
    }
  });
});
