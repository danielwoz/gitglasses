// Web smoke suite, executed inside the browser's worker extension host by
// @vscode/test-web. No mocha: a linear set of asserts with polling keeps the
// bundle free of node-flavored test frameworks. run() rejecting fails the
// harness.

import * as vscode from 'vscode';

const POLL_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 250;

interface WebApi {
  capabilities(): { gitCli: boolean; watch: boolean } | undefined;
  mode: 'wasm' | 'dormant';
}

function log(message: string): void {
  console.log(`[gitglasses-web-suite] ${message}`);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`assertion failed: ${message}`);
}

async function poll<T>(
  probe: () => Promise<T | undefined> | T | undefined,
  failureMessage: string,
  timeoutMs = POLL_TIMEOUT_MS,
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

function hoverText(hovers: readonly vscode.Hover[] | undefined): string {
  if (!hovers) return '';
  return hovers
    .flatMap((hover) => hover.contents)
    .map((content) => (typeof content === 'string' ? content : content.value))
    .join('\n');
}

export async function run(): Promise<void> {
  // --- activation -------------------------------------------------------
  const extension = vscode.extensions.getExtension('gitglasses.gitglasses');
  assert(extension, 'extension gitglasses.gitglasses not found in the web host');
  const api = (await extension.activate()) as WebApi;
  log('extension activated');
  assert(extension.isActive, 'extension did not report active');
  assert(api && api.mode === 'wasm', `expected wasm mode, got ${JSON.stringify(api?.mode)}`);

  // --- engine initialize (wasm capabilities) ----------------------------
  const caps = await poll(
    () => api.capabilities(),
    'engine initialize handshake never completed',
  );
  log(`capabilities: ${JSON.stringify(caps)}`);
  assert(caps.gitCli === false, `wasm engine must report gitCli:false, got ${caps.gitCli}`);
  assert(caps.watch === false, `wasm engine must report watch:false, got ${caps.watch}`);

  // --- blame hover over the fixture file --------------------------------
  const folders = vscode.workspace.workspaceFolders;
  assert(folders && folders.length > 0, 'no workspace folder in the web host');
  const fileUri = vscode.Uri.joinPath(folders[0].uri, 'app.txt');
  const document = await vscode.workspace.openTextDocument(fileUri);
  await vscode.window.showTextDocument(document);
  log(`opened ${fileUri.toString()}`);

  const text = await poll(async () => {
    const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
      'vscode.executeHoverProvider',
      fileUri,
      new vscode.Position(0, 1),
    );
    const flattened = hoverText(hovers);
    return /Alice|\b[0-9a-f]{12,40}\b/.test(flattened) ? flattened : undefined;
  }, 'blame hover never returned commit attribution');
  log(`hover: ${text.split('\n')[0]}`);
  assert(
    text.includes('Alice') || /\b[0-9a-f]{12,40}\b/.test(text),
    `hover lacked fixture author and sha; got: ${text}`,
  );

  // Line 3 belongs to Bob's commit in the fixture.
  const bobText = await poll(async () => {
    const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
      'vscode.executeHoverProvider',
      fileUri,
      new vscode.Position(2, 1),
    );
    const flattened = hoverText(hovers);
    return flattened.includes('Bob') ? flattened : undefined;
  }, 'hover on line 3 never attributed Bob');
  log(`hover line 3: ${bobText.split('\n')[0]}`);

  log('all web smoke checks passed');
}
