// Registers the bundled MCP server with the editor's agents, through whichever
// API the editor has: VS Code's MCP server definition provider (1.101 and
// newer) or Cursor's own registration. engines.vscode stays at 1.90, so both
// are found at runtime rather than typed. No vscode import: the host passes
// the API surface in, which keeps the logic testable.

import {
  MCP_SERVER_NAME,
  allowedRootsFor,
  buildLaunch,
  detectMcpHost,
  type McpHost,
  type McpLaunch,
  type NodeRuntime,
} from './mcpLogic';

/** The id declared under contributes.mcpServerDefinitionProviders. */
export const MCP_PROVIDER_ID = 'gitglasses.mcp';

/** The label agents show for the server. */
export const MCP_SERVER_LABEL = 'GitGlasses';

interface Disposable {
  dispose(): unknown;
}

type Event<T> = (listener: (value: T) => unknown) => Disposable;

/** VS Code's McpStdioServerDefinition, as far as registration uses it. */
export interface StdioDefinition {
  cwd?: unknown;
}

/** The registration APIs, typed as registration calls them. */
export interface McpApi {
  lm?: {
    registerMcpServerDefinitionProvider?: (
      id: string,
      provider: {
        onDidChangeMcpServerDefinitions?: Event<void>;
        provideMcpServerDefinitions(token?: unknown): Promise<StdioDefinition[]>;
      },
    ) => Disposable;
  };
  McpStdioServerDefinition?: new (
    label: string,
    command: string,
    args?: string[],
    env?: Record<string, string | number | null>,
    version?: string,
  ) => StdioDefinition;
  cursor?: {
    mcp?: {
      registerServer?: (config: {
        name: string;
        server: { command: string; args: string[]; env: Record<string, string> };
      }) => void;
      unregisterServer?: (name: string) => void;
    };
  };
}

export interface McpRegistrationHost {
  api: McpApi;
  /** Local workspace folders, in order. */
  folders(): string[];
  trusted(): boolean;
  /** The gitglasses.mcp.enabled setting. */
  enabled(): boolean;
  /** Fires when folders, trust or the setting may have changed. */
  onDidChangeWorkspace: Event<void>;
  /** The program that runs the server, resolved once and cached by the caller. */
  runtime(): Promise<NodeRuntime | undefined>;
  /** The bundled server script, or undefined when the build has none. */
  cliPath: string | undefined;
  enginePath: string;
  /** The extension's version, which tells the editor when tools may differ. */
  version: string;
  home: string;
  hasGit(dir: string): boolean;
  /** Turns a directory into the editor's Uri, for the server's cwd. */
  toUri(fsPath: string): unknown;
  log(line: string): void;
}

/** Where the editor's own registration stands, for the Home view. */
export type McpStatus =
  | { state: 'registered'; host: McpHost; gitRoots: string[]; folders: number; trusted: boolean }
  | { state: 'off'; host?: McpHost }
  | { state: 'noFolder'; host: McpHost }
  | { state: 'noHost' }
  | { state: 'unavailable'; reason: string; host?: McpHost };

export interface McpRegistration extends Disposable {
  status(): McpStatus;
  readonly onDidChangeStatus: Event<McpStatus>;
  /**
   * How to start the server with git allowed in `allowedRoots`, or undefined
   * (with the reason logged) when no runtime or bundled script exists.
   */
  launch(allowedRoots: readonly string[]): Promise<McpLaunch | undefined>;
  /** Where the editor's server runs git right now. */
  gitRoots(): string[];
}

function emitter<T>(): { event: Event<T>; fire(value: T): void } {
  const listeners = new Set<(value: T) => unknown>();
  return {
    event: (listener) => {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
    fire: (value) => {
      for (const listener of [...listeners]) listener(value);
    },
  };
}

export function registerMcpServer(host: McpRegistrationHost): McpRegistration {
  const editor = detectMcpHost(host.api);
  const statusChanged = emitter<McpStatus>();
  const definitionsChanged = emitter<void>();
  const disposables: Disposable[] = [];
  let runtimeMissing = false;
  let cursorRegistered = false;

  const gitRoots = (): string[] =>
    allowedRootsFor({
      trusted: host.trusted(),
      folders: host.folders(),
      home: host.home,
      hasGit: (dir) => host.hasGit(dir),
    });

  const launch = async (allowedRoots: readonly string[]): Promise<McpLaunch | undefined> => {
    if (host.cliPath === undefined) {
      host.log('MCP server: this build has no dist/mcp/cli.js; run the extension build');
      return undefined;
    }
    const runtime = await host.runtime();
    runtimeMissing = runtime === undefined;
    if (!runtime) {
      host.log(
        "MCP server: neither the editor's own Node (ELECTRON_RUN_AS_NODE) nor node 18 or newer on PATH can run it",
      );
      return undefined;
    }
    return buildLaunch({
      runtime,
      cliPath: host.cliPath,
      enginePath: host.enginePath,
      allowedRoots,
    });
  };

  const status = (): McpStatus => {
    if (!editor) return { state: 'noHost' };
    if (!host.enabled()) return { state: 'off', host: editor };
    if (host.cliPath === undefined) {
      return { state: 'unavailable', host: editor, reason: 'this build has no bundled server' };
    }
    if (runtimeMissing) {
      return { state: 'unavailable', host: editor, reason: 'no Node.js runtime to start it with' };
    }
    const folders = host.folders();
    if (folders.length === 0) return { state: 'noFolder', host: editor };
    return {
      state: 'registered',
      host: editor,
      gitRoots: gitRoots(),
      folders: folders.length,
      trusted: host.trusted(),
    };
  };

  // VS Code asks for the definitions whenever its agents may need them, and
  // again after onDidChangeMcpServerDefinitions; an empty list withdraws the
  // server.
  const provideDefinitions = async (): Promise<StdioDefinition[]> => {
    const Definition = host.api.McpStdioServerDefinition;
    const folders = host.folders();
    if (!Definition || !host.enabled() || folders.length === 0) return [];
    const launched = await launch(gitRoots());
    if (!launched) {
      statusChanged.fire(status());
      return [];
    }
    const definition = new Definition(
      MCP_SERVER_LABEL,
      launched.command,
      launched.args,
      launched.env,
      host.version,
    );
    definition.cwd = host.toUri(folders[0]);
    return [definition];
  };

  // Cursor holds one registration per name, so a change replaces it.
  const syncCursor = async (): Promise<void> => {
    const cursor = host.api.cursor?.mcp;
    if (!cursor?.registerServer || !cursor.unregisterServer) return;
    if (cursorRegistered) {
      cursor.unregisterServer(MCP_SERVER_NAME);
      cursorRegistered = false;
    }
    if (!host.enabled() || host.folders().length === 0) return;
    const launched = await launch(gitRoots());
    if (!launched) return;
    cursor.registerServer({
      name: MCP_SERVER_NAME,
      server: { command: launched.command, args: launched.args, env: launched.env },
    });
    cursorRegistered = true;
  };

  if (editor === 'vscode') {
    try {
      disposables.push(
        host.api.lm!.registerMcpServerDefinitionProvider!(MCP_PROVIDER_ID, {
          onDidChangeMcpServerDefinitions: definitionsChanged.event,
          provideMcpServerDefinitions: provideDefinitions,
        }),
      );
      host.log('MCP server: registered with the editor (VS Code MCP server definition provider)');
    } catch (error) {
      host.log(`MCP server: registration failed: ${String(error)}`);
    }
  } else if (editor === 'cursor') {
    const sync = (): void => {
      syncCursor()
        .then(() => statusChanged.fire(status()))
        .catch((error) => host.log(`MCP server: Cursor registration failed: ${String(error)}`));
    };
    sync();
    disposables.push(host.onDidChangeWorkspace(() => sync()));
    host.log('MCP server: registered with Cursor');
  } else {
    host.log(
      'MCP server: this editor has no MCP registration API; the Add MCP Server commands configure agents instead',
    );
  }

  disposables.push(
    host.onDidChangeWorkspace(() => {
      definitionsChanged.fire();
      statusChanged.fire(status());
    }),
  );

  return {
    status,
    onDidChangeStatus: statusChanged.event,
    launch,
    gitRoots,
    dispose: () => {
      for (const disposable of disposables) disposable.dispose();
      if (cursorRegistered) host.api.cursor?.mcp?.unregisterServer?.(MCP_SERVER_NAME);
      cursorRegistered = false;
    },
  };
}
