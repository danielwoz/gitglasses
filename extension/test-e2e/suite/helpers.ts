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

/** Where the extension places a file: its repository and repo-relative path. */
export interface Located {
  repoId: string;
  /** The repository root in the spelling of the located path. */
  rootPath: string;
  relativePath: string;
}

/** A repository the views can act on. */
export interface ListedRepo {
  repoId: string;
  rootPath: string;
  name: string;
}

// Polls the extension's own resolution of a file to a repository, the first
// stage every file feature depends on.
export async function waitForLocate(uri: vscode.Uri): Promise<Located> {
  return poll(
    async () => vscode.commands.executeCommand<Located | undefined>('_gitglasses.locate', uri),
    `the extension never placed ${uri.fsPath} in a repository (see the GitGlasses log)`,
  );
}

/** The repositories the views can act on. */
export async function listRepositories(): Promise<ListedRepo[]> {
  return (await vscode.commands.executeCommand<ListedRepo[]>('_gitglasses.repositories')) ?? [];
}

// Polls the blame hover on a committed file until it names `author` or a
// commit sha. Resolution to a repository is awaited first, so a failure says
// whether locating the file or blaming it stalled.
export async function waitForBlameHover(
  uri: vscode.Uri,
  author: string = FIXTURE.authorName,
): Promise<string> {
  const located = await waitForLocate(uri);
  const where = `${located.relativePath} in ${located.repoId} at ${located.rootPath}`;
  return poll(async () => {
    const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
      'vscode.executeHoverProvider',
      uri,
      new vscode.Position(0, 0),
    );
    const text = hoverText(hovers);
    if (text.includes(author) || SHA_RE.test(text)) return text;
    return undefined;
  }, `no blame hover for ${uri.fsPath} (${where}); the engine never answered blame`);
}
