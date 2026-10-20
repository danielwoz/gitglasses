// "Why this line?": the gitglasses.showLineStory command and the Line Story
// panel it opens beside the editor. The story is the line's blame (with the
// blame settings every other surface uses, ignore-revs included), the commit
// that last changed it, the pull requests that carried that commit, the
// issues they name and the line's earlier versions, assembled by
// buildLineStory. In Restricted Mode it is the blame and the commit only.

import * as vscode from 'vscode';
import {
  buildLineStory,
  type LineStory,
  type StoryForge,
  type StoryForgeLabel,
} from '@gitglasses/integrations';
import type { CommitDetails } from '@gitglasses/protocol';
import { EngineClient } from '@gitglasses/rpc';
import { errorMessage } from '../commands/ui';
import { DocumentBlameService } from '../annotations/documentBlame';
import { isMethodAvailable } from '../engine/capabilityGate';
import { IntegrationService } from '../integrations/integrationService';
import { providerLabel } from '../integrations/integrationSettings';
import { SHOW_COMMIT_DETAILS_COMMAND } from '../commitDetails/commitDetails';
import { copyText, openAllChanges, openFileDiff } from '../commitDetails/commitViews';
import { renderWebviewHtml } from '../webviews/webviewHtml';
import type {
  HostToLineStoryMessage,
  LineStoryPanelState,
  LineStoryToHostMessage,
  VersionTarget,
} from '../../webviews-src/lineStory/ipc';
import {
  LINE_STORY_COMMAND,
  LINE_STORY_VIEW_TYPE,
  LineStoryArgs,
  isCommitId,
  isLineStoryArgs,
  isWebUrl,
  lineStoryTitle,
  storyBlameOf,
  storyLineText,
  storyVersionOf,
} from './lineStoryLogic';

export interface LineStoryDeps {
  context: vscode.ExtensionContext;
  engine: EngineClient;
  blame: DocumentBlameService;
  integrations: IntegrationService;
  log(line: string): void;
}

/** A story that cannot be told, with the reason written for the user. */
class NoStory extends Error {}

/** Where the story on show lives, for the panel's actions. */
interface Shown {
  uri: vscode.Uri;
  line: number;
  repoId: string;
  rootPath: string;
  forge?: StoryForgeLabel;
}

/** The single Line Story panel; another line retargets it. */
class LineStoryPanel implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private panelDisposables: vscode.Disposable[] = [];
  private target: LineStoryPanelState | undefined;
  private shown: Shown | undefined;
  /** The last message posted, sent again when the webview (re)starts. */
  private last: HostToLineStoryMessage | undefined;
  /** Bumped per load, so a slow answer for an earlier line is dropped. */
  private loads = 0;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly deps: LineStoryDeps) {
    // A new connection (or a removed one) changes what the story can say.
    this.disposables.push(
      deps.integrations.onDidChange(() => {
        if (this.panel && this.target) void this.load();
      }),
    );
  }

  async show(args: LineStoryArgs): Promise<LineStory<CommitDetails> | undefined> {
    this.target = { uri: args.uri, line: args.line };
    if (this.panel) {
      this.panel.reveal(undefined, true);
    } else {
      this.adopt(
        vscode.window.createWebviewPanel(
          LINE_STORY_VIEW_TYPE,
          'Line Story',
          { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
          { enableScripts: true, localResourceRoots: [this.distRoot()] },
        ),
      );
    }
    return this.load();
  }

  private distRoot(): vscode.Uri {
    return vscode.Uri.joinPath(this.deps.context.extensionUri, 'dist', 'webviews');
  }

  /** Wires a panel, new or restored after a reload. */
  adopt(panel: vscode.WebviewPanel, restored?: LineStoryPanelState): void {
    if (this.panel && this.panel !== panel) this.panel.dispose();
    this.panel = panel;
    this.last = undefined;
    panel.webview.options = { enableScripts: true, localResourceRoots: [this.distRoot()] };
    panel.iconPath = vscode.Uri.joinPath(this.deps.context.extensionUri, 'media', 'gitglasses.svg');
    panel.webview.html = renderWebviewHtml(panel.webview, this.distRoot(), {
      script: 'lineStory.js',
      style: 'lineStory.css',
      title: 'Line Story',
    });
    this.panelDisposables.push(
      panel.webview.onDidReceiveMessage((message: LineStoryToHostMessage) =>
        this.onMessage(message),
      ),
      panel.onDidDispose(() => this.onPanelDisposed(panel)),
    );
    if (restored) {
      this.target = restored;
      void this.load();
    }
  }

  private async post(message: HostToLineStoryMessage): Promise<void> {
    this.last = message;
    await this.panel?.webview.postMessage(message);
  }

  private async load(): Promise<LineStory<CommitDetails> | undefined> {
    const target = this.target;
    if (!target || !this.panel) return undefined;
    const load = ++this.loads;
    const current = (): boolean => load === this.loads && this.panel !== undefined;
    let uri: vscode.Uri;
    try {
      uri = vscode.Uri.parse(target.uri, true);
    } catch {
      await this.post({ type: 'error', message: `Not a document: ${target.uri}`, state: target });
      return undefined;
    }
    const file = vscode.workspace.asRelativePath(uri, false);
    this.panel.title = lineStoryTitle(file, target.line);
    await this.post({ type: 'loading', state: target, file });
    try {
      const story = await this.tell(uri, target, (view) => {
        if (current()) void this.post({ type: 'story', view, state: target });
      });
      return story;
    } catch (error) {
      const message =
        error instanceof NoStory
          ? error.message
          : `Could not read the story: ${errorMessage(error)}`;
      if (!(error instanceof NoStory)) {
        this.deps.log(`line story: ${file}:${target.line} failed: ${errorMessage(error)}`);
      }
      if (current()) await this.post({ type: 'error', message, state: target });
      return undefined;
    }
  }

  /** Assembles the story of `target`, handing each stage to `show`. */
  private async tell(
    uri: vscode.Uri,
    target: LineStoryPanelState,
    show: (view: { story: LineStory<CommitDetails>; file: string }) => void,
  ): Promise<LineStory<CommitDetails>> {
    const { engine, integrations } = this.deps;
    const document = await vscode.workspace.openTextDocument(uri);
    const file = vscode.workspace.asRelativePath(uri, false);
    if (target.line > document.lineCount) {
      throw new NoStory(`${file} has no line ${target.line}.`);
    }
    if (!this.deps.blame.supports(document)) {
      throw new NoStory(`GitGlasses has no blame for ${file}.`);
    }
    const result = await this.deps.blame.blameDocument(document);
    if (result.kind === 'tooLarge') {
      throw new NoStory(
        `${file} has more unsaved changes than blame holds; save it to read the line's story.`,
      );
    }
    if (result.kind !== 'blame') {
      throw new NoStory(
        `${file} has no blame: it is outside a repository, not tracked yet, or could not be read.`,
      );
    }
    const blame = storyBlameOf(result.blame, target.line);
    if (!blame) throw new NoStory(`Blame does not reach line ${target.line} of ${file}.`);
    const { repoId, rootPath, relativePath } = result.target;

    const capabilities = engine.capabilities();
    const restricted = capabilities?.restricted === true || !vscode.workspace.isTrusted;
    const hosting = rootPath
      ? await integrations.getHostingFor(rootPath).catch(() => undefined)
      : undefined;
    let forge: StoryForge = { kind: 'none' };
    if (hosting) {
      const connected = restricted
        ? undefined
        : await integrations.getConnectedHostingFor(rootPath).catch((error: unknown) => {
            this.deps.log(`line story: reading the ${hosting.host} credential failed: ${error}`);
            return undefined;
          });
      forge = {
        kind: 'hosted',
        label: {
          providerId: hosting.providerId,
          host: hosting.host,
          name: providerLabel(hosting.providerId, hosting.host),
          owner: hosting.repo.owner,
          repo: hosting.repo.name,
        },
        provider: hosting.provider,
        repo: hosting.repo,
        auth: connected?.auth,
      };
    }
    this.shown = {
      uri,
      line: target.line,
      repoId,
      rootPath,
      forge: forge.kind === 'hosted' ? forge.label : undefined,
    };

    return buildLineStory<CommitDetails>(
      {
        file: relativePath,
        line: target.line,
        lineText: storyLineText(document.lineAt(target.line - 1).text),
        blame,
      },
      {
        commit: (sha) => engine.request('commit/details', { repoId, sha }),
        history: isMethodAvailable(capabilities, 'history/line')
          ? async ({ path, rev, line, limit }) =>
              (
                await engine.request('history/line', {
                  repoId,
                  path,
                  rev,
                  startLine: line,
                  endLine: line,
                  limit,
                  patch: true,
                })
              ).entries.map(storyVersionOf)
          : 'noGit',
        forge,
        restricted,
        issuePatterns: rootPath ? await integrations.autolinkPatterns(rootPath) : [],
        log: this.deps.log,
      },
      (story) => show({ story, file: relativePath }),
    );
  }

  private async onMessage(message: LineStoryToHostMessage): Promise<void> {
    const shown = this.shown;
    try {
      switch (message.type) {
        case 'ready':
          // The webview (re)started: show it what it missed.
          if (this.last) await this.panel?.webview.postMessage(this.last);
          break;
        case 'refresh':
          await this.load();
          break;
        case 'openLine':
          if (shown) {
            const position = new vscode.Position(shown.line - 1, 0);
            await vscode.window.showTextDocument(shown.uri, {
              selection: new vscode.Range(position, position),
              viewColumn: vscode.ViewColumn.One,
            });
          }
          break;
        case 'openUrl':
          if (isWebUrl(message.url)) await vscode.env.openExternal(vscode.Uri.parse(message.url));
          break;
        case 'connect':
          if (shown?.forge?.providerId === 'github' && shown.forge.host === 'github.com') {
            await this.deps.integrations.connectGitHub();
          } else {
            await this.deps.integrations.connectIntegration();
          }
          break;
        case 'manageTrust':
          await vscode.commands.executeCommand('workbench.trust.manage');
          break;
        case 'openWorkingChanges':
          if (shown) {
            await vscode.commands.executeCommand('gitglasses.diffWithHead', {
              uri: shown.uri.toString(),
            });
          }
          break;
        case 'openVersion':
          if (shown) await this.openVersion(shown, message.target);
          break;
        case 'showCommit':
          if (shown && isCommitId(message.sha)) {
            await vscode.commands.executeCommand(SHOW_COMMIT_DETAILS_COMMAND, {
              repoPath: shown.rootPath,
              sha: message.sha,
            });
          }
          break;
        case 'copy':
          await copyText(message.text, message.label);
          break;
        case 'openFile':
          if (shown) await openFileDiff(shown.repoId, shown.rootPath, message.target);
          break;
        case 'openChanges':
          if (shown)
            await openAllChanges(this.deps.engine, shown.repoId, message.target, this.deps.log);
          break;
      }
    } catch (error) {
      this.deps.log(`line story: ${message.type} failed: ${errorMessage(error)}`);
      void vscode.window.showErrorMessage(`GitGlasses: ${errorMessage(error)}`);
    }
  }

  /** One earlier version's change to the file, in a diff editor. */
  private async openVersion(shown: Shown, target: VersionTarget): Promise<void> {
    if (!isCommitId(target.sha) || typeof target.path !== 'string' || target.path === '') return;
    const renamed = target.previousPath !== undefined && target.previousPath !== target.path;
    await openFileDiff(shown.repoId, shown.rootPath, {
      kind: 'commit',
      sha: target.sha,
      file: {
        path: target.path,
        origPath: renamed ? target.previousPath : undefined,
        status: target.previousPath === undefined ? 'A' : renamed ? 'R' : 'M',
        additions: 0,
        deletions: 0,
        binary: false,
      },
    });
  }

  private onPanelDisposed(panel: vscode.WebviewPanel): void {
    if (this.panel !== panel) return;
    for (const disposable of this.panelDisposables.splice(0)) disposable.dispose();
    this.panel = undefined;
    this.target = undefined;
    this.shown = undefined;
    this.last = undefined;
  }

  dispose(): void {
    this.panel?.dispose();
    for (const disposable of this.disposables.splice(0)) disposable.dispose();
  }
}

function isPanelState(value: unknown): value is LineStoryPanelState {
  return isLineStoryArgs(value);
}

/**
 * Registers gitglasses.showLineStory and the serializer that brings the panel
 * back after a reload. With LineStoryArgs the command tells that line's
 * story; otherwise (the palette, the editor's context menu) the active
 * editor's cursor line. It resolves with the story once every part of it is
 * in.
 */
export function registerLineStory(deps: LineStoryDeps): vscode.Disposable[] {
  const panel = new LineStoryPanel(deps);
  return [
    panel,
    vscode.window.registerWebviewPanelSerializer(LINE_STORY_VIEW_TYPE, {
      deserializeWebviewPanel: async (webviewPanel, state: unknown) => {
        panel.adopt(webviewPanel, isPanelState(state) ? state : undefined);
      },
    }),
    vscode.commands.registerCommand(LINE_STORY_COMMAND, async (arg?: unknown) => {
      let args = isLineStoryArgs(arg) ? arg : undefined;
      if (!args) {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
          void vscode.window.showInformationMessage(
            'GitGlasses: put the cursor on a line of a file to see its story.',
          );
          return undefined;
        }
        args = { uri: editor.document.uri.toString(), line: editor.selection.active.line + 1 };
      }
      try {
        return await panel.show(args);
      } catch (error) {
        deps.log(`line story: showing ${args.uri}:${args.line} failed: ${errorMessage(error)}`);
        void vscode.window.showErrorMessage(
          `GitGlasses: cannot show the line's story: ${errorMessage(error)}`,
        );
        return undefined;
      }
    }),
  ];
}
