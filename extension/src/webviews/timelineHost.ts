// Extension-host side of the visual file history webview: a singleton panel
// that streams history/file pages for one tracked file to the bubble-chart
// renderer and opens sha~1 ↔ sha diffs on bubble clicks. The panel stays on
// the file it was opened for; re-running the command re-targets it.

import * as vscode from 'vscode';
import { FileHistoryEntry } from '@gitglasses/protocol';
import { EngineClient } from '@gitglasses/rpc';
import { LocatedFile, RepositoryService } from '../model/repositoryService';
import { encodeRevisionUri } from '../scm/revisionContentProvider';
import { historyEntryDiffSpec } from '../views/viewLogic';
import { renderWebviewHtml } from './webviewHtml';
import { graphPageSize } from '../system/settings';

const REFRESH_DEBOUNCE_MS = 300;

type HostToWebviewMessage =
  | { type: 'reset'; path: string }
  | { type: 'entries'; entries: FileHistoryEntry[]; nextCursor?: string }
  | { type: 'theme' };

type WebviewToHostMessage =
  | { type: 'ready' }
  | { type: 'loadMore'; cursor: string }
  | { type: 'openDiff'; sha: string };

export class TimelineWebviewHost implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private panelDisposables: vscode.Disposable[] = [];
  private target: LocatedFile | undefined;
  private entriesBySha = new Map<string, FileHistoryEntry>();
  private refetchTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly engine: EngineClient,
    private readonly repos: RepositoryService,
  ) {}

  /** Opens (or re-targets) the panel for the active file editor. */
  async show(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.scheme !== 'file') {
      void vscode.window.showWarningMessage(
        'GitGlasses: open a file to show its visual history.',
      );
      return;
    }
    let located: LocatedFile | undefined;
    try {
      located = await this.repos.locateOrDiscover(editor.document.uri);
    } catch {
      located = undefined;
    }
    if (!located) {
      void vscode.window.showWarningMessage('GitGlasses: file is not in a git repository.');
      return;
    }

    this.target = located;
    this.entriesBySha.clear();
    const title = `Visual History: ${located.relativePath.split('/').pop() ?? located.relativePath}`;

    if (this.panel) {
      this.panel.title = title;
      this.panel.reveal();
      await this.post({ type: 'reset', path: located.relativePath });
      await this.fetchAndPost();
      return;
    }

    const distRoot = vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webviews');
    const panel = vscode.window.createWebviewPanel(
      'gitglasses.timeline',
      title,
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [distRoot],
      },
    );
    this.panel = panel;
    panel.iconPath = vscode.Uri.joinPath(this.context.extensionUri, 'media', 'gitglasses.svg');
    panel.webview.html = renderWebviewHtml(panel.webview, distRoot, {
      script: 'timeline.js',
      style: 'timeline.css',
      title,
    });

    this.panelDisposables.push(
      panel.webview.onDidReceiveMessage((message: WebviewToHostMessage) =>
        this.onMessage(message),
      ),
      this.engine.onNotification('repo/didChange', (params) => {
        if (!Array.isArray(params?.changed)) return;
        if (params.changed.includes('HEAD') || params.changed.includes('refs')) {
          this.scheduleRefetch();
        }
      }),
      vscode.window.onDidChangeActiveColorTheme(() => {
        void this.post({ type: 'theme' });
      }),
      panel.onDidDispose(() => this.onPanelDisposed()),
    );
  }

  private async post(message: HostToWebviewMessage): Promise<void> {
    await this.panel?.webview.postMessage(message);
  }

  private async onMessage(message: WebviewToHostMessage): Promise<void> {
    switch (message.type) {
      case 'ready':
        if (this.target) await this.post({ type: 'reset', path: this.target.relativePath });
        await this.fetchAndPost();
        break;
      case 'loadMore':
        await this.fetchAndPost(message.cursor);
        break;
      case 'openDiff':
        await this.openDiff(message.sha);
        break;
    }
  }

  private async openDiff(sha: string): Promise<void> {
    const target = this.target;
    const entry = this.entriesBySha.get(sha);
    if (!target || !entry) return;
    const spec = historyEntryDiffSpec(target.repoId, entry);
    const left = encodeRevisionUri(spec.left.repoId, spec.left.path, spec.left.rev);
    const right = encodeRevisionUri(spec.right.repoId, spec.right.path, spec.right.rev);
    await vscode.commands.executeCommand('vscode.diff', left, right, spec.title);
  }

  private async fetchAndPost(cursor?: string): Promise<void> {
    const target = this.target;
    if (!this.panel || !target) return;
    try {
      const result = await this.engine.request('history/file', {
        repoId: target.repoId,
        path: target.relativePath,
        cursor,
        limit: graphPageSize(),
      });
      // A re-target while the request was in flight makes this page stale.
      if (this.target !== target) return;
      for (const entry of result.entries) this.entriesBySha.set(entry.sha, entry);
      await this.post({ type: 'entries', entries: result.entries, nextCursor: result.nextCursor });
    } catch {
      // Engine unavailable or restarting; the next repo change refetches.
    }
  }

  private scheduleRefetch(): void {
    if (this.refetchTimer !== undefined) clearTimeout(this.refetchTimer);
    this.refetchTimer = setTimeout(() => {
      this.refetchTimer = undefined;
      const target = this.target;
      if (!target) return;
      this.entriesBySha.clear();
      void this.post({ type: 'reset', path: target.relativePath }).then(() => this.fetchAndPost());
    }, REFRESH_DEBOUNCE_MS);
  }

  private onPanelDisposed(): void {
    if (this.refetchTimer !== undefined) clearTimeout(this.refetchTimer);
    this.refetchTimer = undefined;
    for (const disposable of this.panelDisposables) disposable.dispose();
    this.panelDisposables = [];
    this.panel = undefined;
    this.target = undefined;
    this.entriesBySha.clear();
  }

  dispose(): void {
    this.panel?.dispose();
    this.onPanelDisposed();
  }
}

/** Registers the show-file-history command; the host lazily creates its
 *  panel. */
export function registerTimelineWebview(
  context: vscode.ExtensionContext,
  engine: EngineClient,
  repos: RepositoryService,
): vscode.Disposable[] {
  const host = new TimelineWebviewHost(context, engine, repos);
  return [
    host,
    vscode.commands.registerCommand('gitglasses.showFileHistory', () => host.show()),
  ];
}
