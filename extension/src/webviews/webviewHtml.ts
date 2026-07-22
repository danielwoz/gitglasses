// Shared HTML shell for gitglasses webview panels: strict CSP with a script
// nonce, one stylesheet, one bundle.

import * as crypto from 'node:crypto';
import * as vscode from 'vscode';

export interface WebviewBundle {
  /** Script filename inside dist/webviews (e.g. 'graph.js'). */
  script: string;
  /** Stylesheet filename inside dist/webviews (e.g. 'graph.css'). */
  style: string;
  title: string;
}

export function renderWebviewHtml(
  webview: vscode.Webview,
  distRoot: vscode.Uri,
  bundle: WebviewBundle,
): string {
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(distRoot, bundle.script));
  const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(distRoot, bundle.style));
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
  <title>${bundle.title}</title>
</head>
<body>
  <script nonce="${nonce}" src="${scriptUri.toString()}"></script>
</body>
</html>`;
}
