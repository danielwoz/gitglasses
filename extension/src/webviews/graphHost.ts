// Extension-host side of the commit graph webview: a singleton panel that
// streams graph/rows pages to the canvas renderer and services its requests.

import * as crypto from 'node:crypto';
import * as vscode from 'vscode';
import { GraphRow } from '@gitglasses/protocol';
import { EngineClient } from '../engine/engineClient';
import { RepositoryService } from '../model/repositoryService';
import { firstWorkspaceRepo } from '../views/viewBase';
import { openCommitDoc } from '../views/nodes';
import { shortSha } from '../views/viewLogic';

const PAGE_LIMIT = 200;
const REFRESH_DEBOUNCE_MS = 300;

type HostToWebviewMessage =
  | { type: 'reset' }
  | { type: 'rows'; rows: GraphRow[]; nextCursor?: string }
  | { type: 'theme' };

type WebviewToHostMessage =
  | { type: 'ready' }
  | { type: 'loadMore'; cursor: string }
  | { type: 'select'; shas: string[] }
  | { type: 'openCommit'; sha: string }
  | { type: 'copySha'; sha: string };

export class GraphWebviewHost implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private panelDisposables: vscode.Disposable[] = [];
  private rowsBySha = new Map<string, GraphRow>();
  private repoId: string | undefined;
  private refetchTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly engine: EngineClient,
    private readonly repos: RepositoryService,
  ) {}

  show(): void {
    if (this.panel) {
      this.panel.reveal();
      return;
    }
    const distRoot = vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webviews');
    const panel = vscode.window.createWebviewPanel(
      'gitglasses.graph',
      'Commit Graph',
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [distRoot],
      },
    );
    this.panel = panel;
    panel.iconPath = vscode.Uri.joinPath(this.context.extensionUri, 'media', 'gitglasses.svg');
    panel.webview.html = this.renderHtml(panel.webview, distRoot);

    this.panelDisposables.push(
      panel.webview.onDidReceiveMessage((message: WebviewToHostMessage) =>
        this.onMessage(message),
      ),
      this.engine.onNotification('repo/didChange', (params) => {
        if (!Array.isArray(params?.changed)) return;
        const relevant = ['HEAD', 'refs', 'stash', 'index'] as const;
        if (relevant.some((kind) => params.changed.includes(kind))) this.scheduleRefetch();
      }),
      vscode.window.onDidChangeActiveColorTheme(() => {
        void this.post({ type: 'theme' });
      }),
      panel.onDidDispose(() => this.onPanelDisposed()),
    );
  }

  private onPanelDisposed(): void {
    if (this.refetchTimer !== undefined) clearTimeout(this.refetchTimer);
    this.refetchTimer = undefined;
    for (const disposable of this.panelDisposables) disposable.dispose();
    this.panelDisposables = [];
    this.panel = undefined;
    this.rowsBySha.clear();
  }

  dispose(): void {
    this.panel?.dispose();
    this.onPanelDisposed();
  }

  private async post(message: HostToWebviewMessage): Promise<void> {
    await this.panel?.webview.postMessage(message);
  }

  private async onMessage(message: WebviewToHostMessage): Promise<void> {
    switch (message.type) {
      case 'ready':
        await this.fetchAndPost();
        break;
      case 'loadMore':
        await this.fetchAndPost(message.cursor);
        break;
      case 'openCommit': {
        const row = this.rowsBySha.get(message.sha);
        if (row) {
          await openCommitDoc({
            sha: row.sha,
            parents: row.parents,
            author: row.author,
            committer: row.author,
            summary: row.summary,
          });
        }
        break;
      }
      case 'copySha':
        await vscode.env.clipboard.writeText(message.sha);
        vscode.window.setStatusBarMessage(`Copied ${shortSha(message.sha)}`, 3000);
        break;
      case 'select':
        break; // Selection currently only drives webview-local rendering.
    }
  }

  private async fetchAndPost(cursor?: string): Promise<void> {
    if (!this.panel) return;
    try {
      if (!this.repoId) {
        const repo = await firstWorkspaceRepo(this.repos);
        if (!repo) return;
        this.repoId = repo.repoId;
      }
      const result = await this.engine.request('graph/rows', {
        repoId: this.repoId,
        cursor,
        limit: PAGE_LIMIT,
        include: { stashes: true, wip: true },
      });
      for (const row of result.rows) this.rowsBySha.set(row.sha, row);
      await this.post({ type: 'rows', rows: result.rows, nextCursor: result.nextCursor });
    } catch {
      // Engine unavailable or restarting; the next repo change refetches.
    }
  }

  private scheduleRefetch(): void {
    if (this.refetchTimer !== undefined) clearTimeout(this.refetchTimer);
    this.refetchTimer = setTimeout(() => {
      this.refetchTimer = undefined;
      this.rowsBySha.clear();
      void this.post({ type: 'reset' }).then(() => this.fetchAndPost());
    }, REFRESH_DEBOUNCE_MS);
  }

  private renderHtml(webview: vscode.Webview, distRoot: vscode.Uri): string {
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(distRoot, 'graph.js'));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(distRoot, 'graph.css'));
    const nonce = crypto.randomBytes(16).toString('base64');
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource}`,
      `img-src ${webview.cspSource} data:`,
      `font-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
    ].join('; ');
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${styleUri.toString()}">
  <title>Commit Graph</title>
</head>
<body>
  <script nonce="${nonce}" src="${scriptUri.toString()}"></script>
</body>
</html>`;
  }
}

/** Registers the show-graph command; the host lazily creates its panel. */
export function registerGraphWebview(
  context: vscode.ExtensionContext,
  engine: EngineClient,
  repos: RepositoryService,
): vscode.Disposable[] {
  const host = new GraphWebviewHost(context, engine, repos);
  return [host, vscode.commands.registerCommand('gitglasses.showGraph', () => host.show())];
}
