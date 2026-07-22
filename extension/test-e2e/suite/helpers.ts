import * as vscode from 'vscode';
import { FIXTURE } from '../fixture';

export const POLL_TIMEOUT_MS = 15_000;
export const POLL_INTERVAL_MS = 250;

const SHA_RE = /\b[0-9a-f]{12,40}\b/;

export function workspaceRoot(): vscode.Uri {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    throw new Error('e2e harness error: no workspace folder is open in the test instance');
  }
  return folders[0].uri;
}

// Repeats an async probe until it yields a defined value or the deadline
// passes; every timeout carries the caller's message plus the last error so
// failures point at the stage that stalled.
export async function poll<T>(
  probe: () => Promise<T | undefined>,
  failureMessage: string,
  timeoutMs: number = POLL_TIMEOUT_MS,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  for (;;) {
    try {
      const value = await probe();
      if (value !== undefined) return value;
    } catch (error) {
      lastError = error;
    }
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  const suffix = lastError === undefined ? '' : ` (last error: ${String(lastError)})`;
  throw new Error(`${failureMessage} — timed out after ${timeoutMs}ms${suffix}`);
}

export async function activateExtension(): Promise<vscode.Extension<unknown>> {
  const extension = vscode.extensions.getExtension('gitglasses.gitglasses');
  if (!extension) {
    throw new Error(
      'extension gitglasses.gitglasses not found; check publisher/name in extension/package.json',
    );
  }
  if (!extension.isActive) await extension.activate();
  return extension;
}

// Flattens hover contents (MarkdownString or plain string entries) into one
// searchable string.
export function hoverText(hovers: readonly vscode.Hover[] | undefined): string {
  if (!hovers) return '';
  return hovers
    .flatMap((hover) => hover.contents)
    .map((content) => (typeof content === 'string' ? content : content.value))
    .join('\n');
}

// Polls the blame hover on the fixture's clean committed file until it names
// the fixture author or a commit sha. A successful hover also proves the
// extension has discovered the fixture repo with the engine (repoId r1 in a
// single-repo workspace, since the engine hands out sequential ids).
export async function waitForBlameHover(uri: vscode.Uri): Promise<string> {
  return poll(async () => {
    const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
      'vscode.executeHoverProvider',
      uri,
      new vscode.Position(0, 0),
    );
    const text = hoverText(hovers);
    if (text.includes(FIXTURE.authorName) || SHA_RE.test(text)) return text;
    return undefined;
  }, `no blame hover for ${uri.fsPath}; the engine never answered blame`);
}
