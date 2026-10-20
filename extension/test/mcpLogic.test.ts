import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CodexConfigConflict,
  allowedRootsFor,
  buildLaunch,
  claudeAddJsonArgs,
  codexServerToml,
  detectMcpHost,
  findOnPath,
  isAlreadyExistsOutput,
  isNodeVersionOutput,
  isSupportedNodeVersion,
  mcpServersJson,
  mergeCodexConfig,
  unifiedDiff,
  type McpLaunch,
} from '../src/mcp/mcpLogic';

const launch: McpLaunch = buildLaunch({
  runtime: { command: '/usr/share/code/code', electron: true },
  cliPath: '/ext/dist/mcp/cli.js',
  enginePath: '/ext/bin/gitglasses-engine',
  allowedRoots: ['/work/app', '/work/lib'],
  delimiter: ':',
});

describe('buildLaunch', () => {
  it("runs the bundled script with the editor's Node, the extension's engine and the allowed roots", () => {
    expect(launch).toEqual({
      command: '/usr/share/code/code',
      args: ['/ext/dist/mcp/cli.js'],
      env: {
        ELECTRON_RUN_AS_NODE: '1',
        GITGLASSES_ENGINE: '/ext/bin/gitglasses-engine',
        GITGLASSES_ALLOWED_ROOTS: '/work/app:/work/lib',
      },
    });
  });

  it('sets the allowed roots even when there are none, so the environment cannot widen them', () => {
    const plain = buildLaunch({
      runtime: { command: '/usr/bin/node', electron: false },
      cliPath: '/ext/dist/mcp/cli.js',
      enginePath: '/ext/bin/gitglasses-engine',
      allowedRoots: [],
    });
    expect(plain.env).toEqual({
      GITGLASSES_ENGINE: '/ext/bin/gitglasses-engine',
      GITGLASSES_ALLOWED_ROOTS: '',
    });
  });
});

describe('allowedRootsFor', () => {
  const home = path.resolve('/home/dev');
  const repos = new Set([path.resolve('/home/dev/mono'), path.resolve('/srv/site')]);
  const hasGit = (dir: string): boolean => repos.has(dir);

  it('allows nothing in an untrusted workspace', () => {
    expect(
      allowedRootsFor({ trusted: false, folders: [path.resolve('/home/dev/mono')], home, hasGit }),
    ).toEqual([]);
  });

  it('allows each workspace folder, widened to the repository that holds it', () => {
    expect(
      allowedRootsFor({
        trusted: true,
        folders: [
          path.resolve('/home/dev/mono/packages/app'),
          path.resolve('/home/dev/notes'),
          path.resolve('/srv/site/docs'),
        ],
        home,
        hasGit,
      }),
    ).toEqual([
      path.resolve('/home/dev/mono'),
      path.resolve('/home/dev/notes'),
      path.resolve('/srv/site'),
    ]);
  });

  it('never allows the home directory, a directory above it or a filesystem root', () => {
    const everything = new Set([home, path.resolve('/')]);
    expect(
      allowedRootsFor({
        trusted: true,
        folders: [home, path.resolve('/home'), path.resolve('/'), path.resolve('/home/dev/x')],
        home,
        // A dotfiles repository at the home directory is not widened to.
        hasGit: (dir) => everything.has(dir),
      }),
    ).toEqual([path.resolve('/home/dev/x')]);
  });

  it('lists a folder inside another allowed folder once', () => {
    expect(
      allowedRootsFor({
        trusted: true,
        folders: [path.resolve('/srv/site/a'), path.resolve('/srv/site')],
        home,
        hasGit,
      }),
    ).toEqual([path.resolve('/srv/site')]);
  });
});

describe('detectMcpHost', () => {
  const fn = (): void => undefined;
  class Definition {}

  it('uses the definition provider API of VS Code 1.101 and newer', () => {
    expect(
      detectMcpHost({
        lm: { registerMcpServerDefinitionProvider: fn },
        McpStdioServerDefinition: Definition,
      }),
    ).toBe('vscode');
  });

  it("prefers Cursor's own registration where it exists", () => {
    expect(
      detectMcpHost({
        lm: { registerMcpServerDefinitionProvider: fn },
        McpStdioServerDefinition: Definition,
        cursor: { mcp: { registerServer: fn, unregisterServer: fn } },
      }),
    ).toBe('cursor');
  });

  it('finds nothing in older editors or with half an API', () => {
    expect(detectMcpHost({})).toBeUndefined();
    expect(detectMcpHost({ lm: {} })).toBeUndefined();
    expect(detectMcpHost({ lm: { registerMcpServerDefinitionProvider: fn } })).toBeUndefined();
    expect(detectMcpHost({ cursor: { mcp: { registerServer: fn } } })).toBeUndefined();
  });
});

describe('Node runtime checks', () => {
  it("tells Node's --version from an editor's", () => {
    expect(isNodeVersionOutput('v22.20.0\n')).toBe(true);
    // An editor that ignores ELECTRON_RUN_AS_NODE prints its own version.
    expect(isNodeVersionOutput('1.105.0\nabcdef\nx64\n')).toBe(false);
    expect(isNodeVersionOutput('')).toBe(false);
  });

  it('accepts Node 18 and newer', () => {
    expect(isSupportedNodeVersion('v18.19.0')).toBe(true);
    expect(isSupportedNodeVersion('v24.1.0\n')).toBe(true);
    expect(isSupportedNodeVersion('v16.20.2')).toBe(false);
    expect(isSupportedNodeVersion('node')).toBe(false);
  });
});

describe('findOnPath', () => {
  it('finds an executable in an absolute PATH entry only', () => {
    const files = new Set(['/opt/claude/bin/claude', 'bin/claude']);
    expect(
      findOnPath('claude', {
        env: { PATH: 'bin:/usr/bin::/opt/claude/bin' },
        platform: 'linux',
        isFile: (candidate) => files.has(candidate),
      }),
    ).toBe('/opt/claude/bin/claude');
    expect(
      findOnPath('claude', { env: { PATH: 'bin' }, platform: 'linux', isFile: () => true }),
    ).toBeUndefined();
  });

  it('takes only .exe files on Windows, from Path in any case', () => {
    const files = new Set(['C:\\npm\\claude.cmd', 'C:\\Users\\u\\.local\\bin\\claude.exe']);
    const options = {
      env: { Path: 'C:\\npm;"C:\\Users\\u\\.local\\bin"' },
      platform: 'win32' as const,
      isFile: (candidate: string) => files.has(candidate),
    };
    expect(findOnPath('claude', options)).toBe('C:\\Users\\u\\.local\\bin\\claude.exe');
    files.delete('C:\\Users\\u\\.local\\bin\\claude.exe');
    expect(findOnPath('claude', options)).toBeUndefined();
  });
});

describe('configuration for other agents', () => {
  it('writes an mcpServers map with absolute paths', () => {
    expect(JSON.parse(mcpServersJson(launch))).toEqual({
      mcpServers: {
        gitglasses: {
          command: '/usr/share/code/code',
          args: ['/ext/dist/mcp/cli.js'],
          env: {
            ELECTRON_RUN_AS_NODE: '1',
            GITGLASSES_ENGINE: '/ext/bin/gitglasses-engine',
            GITGLASSES_ALLOWED_ROOTS: '/work/app:/work/lib',
          },
        },
      },
    });
  });

  it("adds a stdio server to Claude Code's user scope", () => {
    const args = claudeAddJsonArgs(launch);
    expect(args.slice(0, 5)).toEqual(['mcp', 'add-json', '--scope', 'user', 'gitglasses']);
    expect(JSON.parse(args[5])).toEqual({
      type: 'stdio',
      command: '/usr/share/code/code',
      args: ['/ext/dist/mcp/cli.js'],
      env: launch.env,
    });
    expect(isAlreadyExistsOutput('MCP server gitglasses already exists in user config')).toBe(true);
    expect(isAlreadyExistsOutput('Added stdio MCP server gitglasses to user config')).toBe(false);
  });
});

describe('mergeCodexConfig', () => {
  const windowsLaunch: McpLaunch = {
    command: 'C:\\Program Files\\Microsoft VS Code\\Code.exe',
    args: ['C:\\Users\\u\\.vscode\\extensions\\gg\\dist\\mcp\\cli.js'],
    env: { ELECTRON_RUN_AS_NODE: '1', GITGLASSES_ALLOWED_ROOTS: '' },
  };

  it('writes a TOML table with escaped strings', () => {
    expect(codexServerToml(windowsLaunch)).toBe(
      [
        '[mcp_servers.gitglasses]',
        'command = "C:\\\\Program Files\\\\Microsoft VS Code\\\\Code.exe"',
        'args = ["C:\\\\Users\\\\u\\\\.vscode\\\\extensions\\\\gg\\\\dist\\\\mcp\\\\cli.js"]',
        'env = { ELECTRON_RUN_AS_NODE = "1", GITGLASSES_ALLOWED_ROOTS = "" }',
        '',
      ].join('\n'),
    );
  });

  it('creates the file content when there is none', () => {
    expect(mergeCodexConfig('', launch)).toEqual({
      content: codexServerToml(launch),
      replaced: false,
    });
  });

  it('appends the table after the existing settings, keeping them as they are', () => {
    const existing = 'model = "o3"  # pinned\n\n[mcp_servers.other]\ncommand = "x"\n\n\n';
    const { content, replaced } = mergeCodexConfig(existing, launch);
    expect(replaced).toBe(false);
    expect(content).toBe(
      `model = "o3"  # pinned\n\n[mcp_servers.other]\ncommand = "x"\n\n${codexServerToml(launch)}`,
    );
  });

  it('replaces an earlier gitglasses table and its sub-tables where they stand', () => {
    const existing = [
      'model = "o3"',
      '',
      '[mcp_servers.gitglasses]',
      'command = "/old/node"',
      'args = ["/old/cli.js"]',
      '',
      '[mcp_servers.gitglasses.env]',
      'GITGLASSES_ENGINE = "/old/engine"',
      '',
      '[mcp_servers."other"]',
      'command = "y"',
      '',
    ].join('\n');
    const { content, replaced } = mergeCodexConfig(existing, launch);
    expect(replaced).toBe(true);
    expect(content).toBe(
      [
        'model = "o3"',
        '',
        codexServerToml(launch),
        '[mcp_servers."other"]',
        'command = "y"',
        '',
      ].join('\n'),
    );
    // Writing it again changes nothing.
    expect(mergeCodexConfig(content, launch).content).toBe(content);
  });

  it('recognises the table under a quoted or spaced header, and keeps CRLF line ends', () => {
    const existing =
      '[ mcp_servers . "gitglasses" ]\r\ncommand = "old"\r\n[profiles.x]\r\nmodel = "y"\r\n';
    const { content, replaced } = mergeCodexConfig(existing, launch);
    expect(replaced).toBe(true);
    expect(content).toBe(
      `${codexServerToml(launch).replace(/\n/g, '\r\n')}\r\n[profiles.x]\r\nmodel = "y"\r\n`,
    );
  });

  it('leaves a header-like line inside a multi-line string alone', () => {
    const existing = 'notes = """\n[mcp_servers.gitglasses]\n"""\n';
    const { content, replaced } = mergeCodexConfig(existing, launch);
    expect(replaced).toBe(false);
    expect(content.startsWith(existing)).toBe(true);
  });

  it('refuses a definition it cannot replace line by line', () => {
    for (const existing of [
      '[mcp_servers]\ngitglasses = { command = "x" }\n',
      'mcp_servers.gitglasses.command = "x"\n',
      '[mcp_servers]\n"gitglasses".command = "x"\n',
    ]) {
      expect(() => mergeCodexConfig(existing, launch), existing).toThrow(CodexConfigConflict);
    }
  });
});

describe('unifiedDiff', () => {
  it('shows added and removed lines with their context', () => {
    const before = 'a\nb\nc\nd\ne\nf\ng\n';
    const after = 'a\nb\nc\nD\ne\nf\ng\nh\n';
    expect(unifiedDiff(before, after, 'config.toml', 1)).toBe(
      ['--- config.toml', '+++ config.toml', ' c', '-d', '+D', ' e', '...', ' g', '+h'].join('\n'),
    );
  });

  it('shows a new file as all additions', () => {
    expect(unifiedDiff('', 'x\ny\n', 'f')).toBe('--- f\n+++ f\n+x\n+y');
  });
});
