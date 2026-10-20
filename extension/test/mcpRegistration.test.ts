// The editor registration of the bundled MCP server, against stand-ins for
// VS Code's definition provider API and Cursor's registerServer, including
// editors that have neither.

import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { NodeRuntime } from '../src/mcp/mcpLogic';
import {
  MCP_PROVIDER_ID,
  registerMcpServer,
  type McpApi,
  type McpRegistrationHost,
  type StdioDefinition,
} from '../src/mcp/mcpRegistration';
import { mcpStatusSummary } from '../src/mcp/mcpStatusText';
import { resolveNodeRuntime } from '../src/mcp/nodeRuntime';

const folderA = path.resolve('/work/app');
const folderB = path.resolve('/work/lib');

class Definition implements StdioDefinition {
  cwd?: unknown;
  constructor(
    readonly label: string,
    readonly command: string,
    readonly args?: string[],
    readonly env?: Record<string, string | number | null>,
    readonly version?: string,
  ) {}
}

interface Provider {
  onDidChangeMcpServerDefinitions?: (listener: () => unknown) => { dispose(): unknown };
  provideMcpServerDefinitions(): Promise<StdioDefinition[]>;
}

/** A host whose workspace the test changes, plus what the APIs were called with. */
function setup(api: McpApi, overrides: Partial<McpRegistrationHost> = {}) {
  const state = {
    folders: [folderA, folderB],
    trusted: true,
    enabled: true,
    runtime: { command: '/opt/editor/code', electron: true } as NodeRuntime | undefined,
    logs: [] as string[],
  };
  const listeners = new Set<() => unknown>();
  const host: McpRegistrationHost = {
    api,
    folders: () => state.folders,
    trusted: () => state.trusted,
    enabled: () => state.enabled,
    onDidChangeWorkspace: (listener) => {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
    runtime: async () => state.runtime,
    cliPath: '/ext/dist/mcp/cli.js',
    enginePath: '/ext/bin/gitglasses-engine',
    version: '0.4.0',
    home: path.resolve('/home/dev'),
    hasGit: () => false,
    toUri: (fsPath) => ({ fsPath }),
    log: (line) => state.logs.push(line),
    ...overrides,
  };
  const changeWorkspace = (): void => {
    for (const listener of [...listeners]) listener();
  };
  return { state, host, changeWorkspace };
}

function vscodeApi() {
  const registered: { id: string; provider: Provider }[] = [];
  const api: McpApi = {
    lm: {
      registerMcpServerDefinitionProvider: (id, provider) => {
        registered.push({ id, provider: provider as Provider });
        return { dispose: () => undefined };
      },
    },
    McpStdioServerDefinition: Definition,
  };
  return { api, registered };
}

function cursorApi() {
  const calls: unknown[] = [];
  const api: McpApi = {
    cursor: {
      mcp: {
        registerServer: (config) => calls.push(['register', config]),
        unregisterServer: (name) => calls.push(['unregister', name]),
      },
    },
  };
  return { api, calls };
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('VS Code registration', () => {
  it('provides a stdio definition that runs the bundled server with the workspace as allowed roots', async () => {
    const { api, registered } = vscodeApi();
    const { host } = setup(api);
    const registration = registerMcpServer(host);
    expect(registered.map((entry) => entry.id)).toEqual([MCP_PROVIDER_ID]);

    const [definition] =
      (await registered[0].provider.provideMcpServerDefinitions()) as Definition[];
    expect(definition).toMatchObject({
      label: 'GitGlasses',
      command: '/opt/editor/code',
      args: ['/ext/dist/mcp/cli.js', `--allow=${folderA}`, `--allow=${folderB}`],
      version: '0.4.0',
      cwd: { fsPath: folderA },
    });
    expect(definition.env).toEqual({
      ELECTRON_RUN_AS_NODE: '1',
      GITGLASSES_ENGINE: '/ext/bin/gitglasses-engine',
      GITGLASSES_ALLOWED_ROOTS: '',
    });
    expect(registration.status()).toEqual({
      state: 'registered',
      host: 'vscode',
      gitRoots: [folderA, folderB],
      folders: 2,
      trusted: true,
    });
  });

  it('allows git nowhere in an untrusted workspace, and asks again once trust is granted', async () => {
    const { api, registered } = vscodeApi();
    const { state, host, changeWorkspace } = setup(api);
    state.trusted = false;
    registerMcpServer(host);
    const provider = registered[0].provider;
    let changes = 0;
    provider.onDidChangeMcpServerDefinitions?.(() => changes++);

    const [untrusted] = (await provider.provideMcpServerDefinitions()) as Definition[];
    expect(untrusted.env?.GITGLASSES_ALLOWED_ROOTS).toBe('');
    expect(untrusted.args).toEqual(['/ext/dist/mcp/cli.js']);

    state.trusted = true;
    changeWorkspace();
    expect(changes).toBe(1);
    const [trusted] = (await provider.provideMcpServerDefinitions()) as Definition[];
    expect(trusted.env?.GITGLASSES_ALLOWED_ROOTS).toBe('');
    expect(trusted.args).toEqual([
      '/ext/dist/mcp/cli.js',
      `--allow=${folderA}`,
      `--allow=${folderB}`,
    ]);
  });

  it('withdraws the server when the setting is off or no folder is open', async () => {
    const { api, registered } = vscodeApi();
    const { state, host } = setup(api);
    const registration = registerMcpServer(host);
    const provider = registered[0].provider;

    state.enabled = false;
    expect(await provider.provideMcpServerDefinitions()).toEqual([]);
    expect(registration.status()).toEqual({ state: 'off', host: 'vscode' });

    state.enabled = true;
    state.folders = [];
    expect(await provider.provideMcpServerDefinitions()).toEqual([]);
    expect(registration.status()).toEqual({ state: 'noFolder', host: 'vscode' });
  });

  it('provides nothing, and says why, without a runtime or a bundled script', async () => {
    const noRuntime = vscodeApi();
    const first = setup(noRuntime.api);
    first.state.runtime = undefined;
    const registration = registerMcpServer(first.host);
    expect(await noRuntime.registered[0].provider.provideMcpServerDefinitions()).toEqual([]);
    expect(registration.status()).toMatchObject({ state: 'unavailable', host: 'vscode' });
    expect(first.state.logs.join('\n')).toContain('node 18 or newer on PATH');

    const noScript = vscodeApi();
    const second = setup(noScript.api, { cliPath: undefined });
    const withoutScript = registerMcpServer(second.host);
    expect(await noScript.registered[0].provider.provideMcpServerDefinitions()).toEqual([]);
    expect(withoutScript.status()).toEqual({
      state: 'unavailable',
      host: 'vscode',
      reason: 'this build has no bundled server',
    });
  });
});

describe('Cursor registration', () => {
  it('registers the server by name and replaces it when the workspace changes', async () => {
    const { api, calls } = cursorApi();
    const { state, host, changeWorkspace } = setup(api);
    const registration = registerMcpServer(host);
    await settle();
    expect(calls).toEqual([
      [
        'register',
        {
          name: 'gitglasses',
          server: {
            command: '/opt/editor/code',
            args: ['/ext/dist/mcp/cli.js', `--allow=${folderA}`, `--allow=${folderB}`],
            env: {
              ELECTRON_RUN_AS_NODE: '1',
              GITGLASSES_ENGINE: '/ext/bin/gitglasses-engine',
              GITGLASSES_ALLOWED_ROOTS: '',
            },
          },
        },
      ],
    ]);
    expect(registration.status()).toMatchObject({ state: 'registered', host: 'cursor' });

    state.folders = [folderA];
    changeWorkspace();
    await settle();
    expect(calls.slice(1).map((call) => (call as unknown[])[0])).toEqual([
      'unregister',
      'register',
    ]);

    state.enabled = false;
    changeWorkspace();
    await settle();
    expect(calls.slice(3)).toEqual([['unregister', 'gitglasses']]);

    state.enabled = true;
    changeWorkspace();
    await settle();
    registration.dispose();
    expect(calls.slice(-1)).toEqual([['unregister', 'gitglasses']]);
  });
});

describe('registration failures and bursts of changes', () => {
  it('reports a registration the editor refuses', () => {
    const api: McpApi = {
      lm: {
        registerMcpServerDefinitionProvider: () => {
          throw new Error('provider gitglasses.mcp is not contributed');
        },
      },
      McpStdioServerDefinition: Definition,
    };
    const { host, state } = setup(api);
    expect(registerMcpServer(host).status()).toEqual({
      state: 'unavailable',
      host: 'vscode',
      reason: 'the editor refused the registration',
    });
    expect(state.logs.join('\n')).toContain('not contributed');
  });

  it('keeps one Cursor registration however quickly the workspace changes', async () => {
    const { api, calls } = cursorApi();
    const { host, changeWorkspace } = setup(api);
    registerMcpServer(host);
    changeWorkspace();
    changeWorkspace();
    for (let i = 0; i < 5; i++) await settle();
    let registered = 0;
    for (const call of calls as unknown[][]) registered += call[0] === 'register' ? 1 : -1;
    expect(registered).toBe(1);
    expect((calls.at(-1) as unknown[])[0]).toBe('register');
  });
});

describe('editors without an MCP registration API', () => {
  it('registers nothing and points at the commands instead', () => {
    const { host, state } = setup({ lm: {} });
    const registration = registerMcpServer(host);
    expect(registration.status()).toEqual({ state: 'noHost' });
    expect(state.logs.join('\n')).toContain('Add MCP Server commands');
  });

  it('still builds a launch for the commands, with the roots they choose', async () => {
    const { host } = setup({});
    const launch = await registerMcpServer(host).launch([]);
    expect(launch?.env.GITGLASSES_ALLOWED_ROOTS).toBe('');
    expect(launch?.args).toEqual(['/ext/dist/mcp/cli.js']);
  });
});

describe('Home view status', () => {
  it('names where the server is available and where git runs', () => {
    const vscode = mcpStatusSummary(
      { state: 'registered', host: 'vscode', gitRoots: [folderA], folders: 1, trusted: true },
      [folderA],
    );
    expect(vscode.description).toBe('available to VS Code agents');
    expect(vscode.detail).toBe('Ready for agents in VS Code, with git in this workspace');
    expect(vscode.tooltip).toContain(`Git runs in: ${folderA}`);

    const cursorReadOnly = mcpStatusSummary(
      { state: 'registered', host: 'cursor', gitRoots: [], folders: 1, trusted: false },
      [],
    );
    expect(cursorReadOnly.description).toBe("available to Cursor's agent");
    expect(cursorReadOnly.detail).toBe("Ready for Cursor's agent, read-only without git");
    expect(cursorReadOnly.tooltip).toContain('Git runs nowhere');
  });

  it('says that VS Code waits for trust before it starts the server', () => {
    const untrusted = mcpStatusSummary(
      { state: 'registered', host: 'vscode', gitRoots: [], folders: 1, trusted: false },
      [],
    );
    expect(untrusted.detail).toBe('VS Code starts it once you trust this folder');
    expect(untrusted.icon).toBe('workspace-untrusted');
  });

  it('says what to do in every other state', () => {
    expect(mcpStatusSummary({ state: 'off', host: 'vscode' }, []).description).toBe('off');
    expect(mcpStatusSummary({ state: 'noFolder', host: 'cursor' }, []).description).toBe(
      'open a folder',
    );
    expect(mcpStatusSummary({ state: 'noHost' }, []).description).toBe('add it to your agent');
    expect(
      mcpStatusSummary({ state: 'unavailable', reason: 'no Node.js runtime to start it with' }, [])
        .detail,
    ).toBe('Not available: no Node.js runtime to start it with');
  });
});

describe('resolveNodeRuntime', () => {
  const runner = (outputs: Record<string, string>) => {
    const calls: { command: string; args: string[]; env: NodeJS.ProcessEnv }[] = [];
    return {
      calls,
      run: async (command: string, args: string[], env: NodeJS.ProcessEnv) => {
        calls.push({ command, args, env });
        return outputs[command] ?? '';
      },
    };
  };
  const base = { env: { PATH: '/usr/bin' }, platform: 'linux' as const };

  it("uses the editor's own binary when it honours ELECTRON_RUN_AS_NODE", async () => {
    const { run, calls } = runner({ '/opt/editor/code': 'v22.20.0\n' });
    expect(
      await resolveNodeRuntime({ ...base, execPath: '/opt/editor/code', electron: true, run }),
    ).toEqual({ command: '/opt/editor/code', electron: true });
    expect(calls[0].args).toEqual(['--version']);
    expect(calls[0].env.ELECTRON_RUN_AS_NODE).toBe('1');
  });

  it('falls back to node on PATH when the editor ignores ELECTRON_RUN_AS_NODE', async () => {
    const { run } = runner({
      '/opt/editor/code': '1.105.0\nabc\nx64\n',
      '/usr/bin/node': 'v20.11.0',
    });
    expect(
      await resolveNodeRuntime({
        ...base,
        execPath: '/opt/editor/code',
        electron: true,
        run,
        isFile: (candidate) => candidate === '/usr/bin/node',
      }),
    ).toEqual({ command: '/usr/bin/node', electron: false });
  });

  it('finds no runtime when node on PATH is too old or missing', async () => {
    const { run } = runner({ '/usr/bin/node': 'v16.20.0' });
    expect(
      await resolveNodeRuntime({
        ...base,
        execPath: '/opt/editor/code',
        electron: true,
        run,
        isFile: (candidate) => candidate === '/usr/bin/node',
      }),
    ).toBeUndefined();
    expect(
      await resolveNodeRuntime({
        ...base,
        execPath: '/opt/editor/code',
        electron: true,
        run,
        isFile: () => false,
      }),
    ).toBeUndefined();
  });

  it('runs a remote extension host on its own Node without probing', async () => {
    const { run, calls } = runner({});
    expect(
      await resolveNodeRuntime({
        ...base,
        execPath: '/srv/vscode-server/node',
        electron: false,
        run,
      }),
    ).toEqual({ command: '/srv/vscode-server/node', electron: false });
    expect(calls).toEqual([]);
  });
});
