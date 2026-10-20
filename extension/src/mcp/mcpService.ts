// The bundled MCP server in the desktop extension: its registration with the
// editor's agents, the commands that add it to other agents, and its section
// in the Home view.

import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { registerMcpCommands } from './mcpCommands';
import { mcpHomeSection } from './mcpHome';
import type { NodeRuntime } from './mcpLogic';
import { registerMcpServer, type McpApi, type McpRegistration } from './mcpRegistration';
import { resolveNodeRuntime } from './nodeRuntime';
import type { ViewNode } from '../views/viewBase';

/** The setting that turns the editor registration off. */
export const MCP_ENABLED_SETTING = 'gitglasses.mcp.enabled';

/** How long after activation the Node runtime is checked, off the startup path. */
const RUNTIME_CHECK_DELAY_MS = 3000;

export interface McpServiceOptions {
  enginePath: string;
  log: (line: string) => void;
  /** Called with the Home view's MCP section whenever it may have changed. */
  setHomeSection: (section: () => ViewNode[]) => void;
}

function hasGit(dir: string): boolean {
  try {
    fs.statSync(path.join(dir, '.git'));
    return true;
  } catch {
    return false;
  }
}

/**
 * `dir` with symlinks and Windows 8.3 short names resolved, as the server
 * compares paths: the home directory must be recognised however a folder
 * spells it.
 */
function canonical(dir: string): string {
  try {
    return fs.realpathSync.native(dir);
  } catch {
    return dir;
  }
}

function localFolders(): string[] {
  return (vscode.workspace.workspaceFolders ?? [])
    .filter((folder) => folder.uri.scheme === 'file')
    .map((folder) => canonical(folder.uri.fsPath));
}

export function startMcpService(
  context: vscode.ExtensionContext,
  options: McpServiceOptions,
): vscode.Disposable[] {
  const cli = context.asAbsolutePath(path.join('dist', 'mcp', 'cli.js'));
  const changed = new vscode.EventEmitter<void>();
  let runtime: Promise<NodeRuntime | undefined> | undefined;

  const registration: McpRegistration = registerMcpServer({
    api: vscode as unknown as McpApi,
    folders: localFolders,
    trusted: () => vscode.workspace.isTrusted,
    enabled: () => vscode.workspace.getConfiguration().get<boolean>(MCP_ENABLED_SETTING, true),
    onDidChangeWorkspace: changed.event,
    runtime: () =>
      (runtime ??= resolveNodeRuntime({
        execPath: process.execPath,
        electron: typeof process.versions.electron === 'string',
        env: process.env,
        platform: process.platform,
      }).then((resolved) => {
        options.log(
          resolved
            ? `MCP server: runs with ${resolved.command}${resolved.electron ? ' (ELECTRON_RUN_AS_NODE)' : ''}`
            : 'MCP server: no Node.js runtime found',
        );
        return resolved;
      })),
    cliPath: fs.existsSync(cli) ? cli : undefined,
    enginePath: options.enginePath,
    version: String(context.extension.packageJSON.version ?? ''),
    home: canonical(os.homedir()),
    hasGit,
    toUri: (fsPath) => vscode.Uri.file(fsPath),
    log: options.log,
  });

  const refreshHome = (): void =>
    options.setHomeSection(() => mcpHomeSection(registration.status(), registration.gitRoots()));
  refreshHome();

  const timer = setTimeout(() => {
    void registration.launch([]).then(() => refreshHome());
  }, RUNTIME_CHECK_DELAY_MS);
  timer.unref?.();

  return [
    changed,
    registration,
    { dispose: () => clearTimeout(timer) },
    registration.onDidChangeStatus(() => refreshHome()),
    vscode.workspace.onDidChangeWorkspaceFolders(() => changed.fire()),
    vscode.workspace.onDidGrantWorkspaceTrust(() => changed.fire()),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(MCP_ENABLED_SETTING)) changed.fire();
    }),
    ...registerMcpCommands({ registration, log: options.log }),
    // Internal: where the registration stands and what the editor's agents
    // start, so a test or a bug report can check both.
    vscode.commands.registerCommand('_gitglasses.mcp.status', async () => ({
      status: registration.status(),
      launch: await registration.launch(registration.gitRoots()),
    })),
  ];
}
