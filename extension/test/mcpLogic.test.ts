import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CodexConfigConflict,
  MIN_NODE_MAJOR,
  allowedRootsFor,
  buildLaunch,
  claudeAddJsonArgs,
  codexServerToml,
  detectMcpHost,
  findOnPath,
  isAlreadyExistsOutput,
  isSupportedNodeVersion,
  launchGitRoots,
  launchReadRoots,
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
});

describe('buildLaunch', () => {
  it("runs the bundled script with the editor's Node, the extension's engine and the allowed roots", () => {
    expect(launch).toEqual({
      command: '/usr/share/code/code',
      args: ['/ext/dist/mcp/cli.js', '--allow=/work/app', '--allow=/work/lib'],
      env: {
        ELECTRON_RUN_AS_NODE: '1',
        GITGLASSES_ENGINE: '/ext/bin/gitglasses-engine',
        GITGLASSES_ALLOWED_ROOTS: '',
      },
    });
    expect(launchGitRoots(launch)).toEqual(['/work/app', '/work/lib']);
  });

  // The server splits GITGLASSES_ALLOWED_ROOTS at ':' (';' on Windows): a
  // folder named so would admit other directories, or "*" every one.
  it('passes each root as one argument, whatever its name holds', () => {
    const odd = ['/work/client:legacy', '/work/proj:*', 'C:\\code\\a;b', '/work/trailing '];
    const built = buildLaunch({
      runtime: { command: '/usr/bin/node', electron: false },
      cliPath: '/ext/dist/mcp/cli.js',
      enginePath: '/ext/bin/gitglasses-engine',
      allowedRoots: odd,
    });
    expect(built.args.slice(1)).toEqual(odd.map((root) => `--allow=${root}`));
    expect(built.env.GITGLASSES_ALLOWED_ROOTS).toBe('');
    expect(launchGitRoots(built)).toEqual(odd);
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

describe('read roots', () => {
  it('names directories read without git after those where git runs', () => {
    const built = buildLaunch({
      runtime: { command: '/usr/bin/node', electron: false },
      cliPath: '/ext/dist/mcp/cli.js',
      enginePath: '/ext/bin/gitglasses-engine',
      allowedRoots: ['/work/app'],
      readRoots: ['/work/docs:old', '/work/site'],
    });
    expect(built.args).toEqual([
      '/ext/dist/mcp/cli.js',
      '--allow=/work/app',
      '--read=/work/docs:old',
      '--read=/work/site',
    ]);
    expect(launchGitRoots(built)).toEqual(['/work/app']);
    expect(launchReadRoots(built)).toEqual(['/work/docs:old', '/work/site']);
    expect(launchReadRoots(launch)).toEqual([]);
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
  it('accepts Node 20 and newer', () => {
    expect(isSupportedNodeVersion('v20.0.0')).toBe(true);
    // VS Code 1.90's own Node.
    expect(isSupportedNodeVersion('v20.9.0\n')).toBe(true);
    expect(isSupportedNodeVersion('v24.1.0\n')).toBe(true);
    expect(isSupportedNodeVersion('v18.20.8')).toBe(false);
    expect(isSupportedNodeVersion('v18.0.0')).toBe(false);
    expect(isSupportedNodeVersion('v16.20.2')).toBe(false);
  });

  it("refuses output that is not Node's --version", () => {
    // An editor that ignores ELECTRON_RUN_AS_NODE prints its own version.
    expect(isSupportedNodeVersion('1.105.0\nabcdef\nx64\n')).toBe(false);
    expect(isSupportedNodeVersion('')).toBe(false);
    expect(isSupportedNodeVersion('node')).toBe(false);
    expect(isSupportedNodeVersion('v22')).toBe(false);
  });

  it('asks for the Node the bundled server is built for', () => {
    const build = readFileSync(path.join(__dirname, '..', 'esbuild.mjs'), 'utf8');
    const target = /const mcpConfig = \{[^}]*?\btarget: '([^']+)'/.exec(build)?.[1];
    expect(target).toBe(`node${MIN_NODE_MAJOR}`);
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
          args: ['/ext/dist/mcp/cli.js', '--allow=/work/app', '--allow=/work/lib'],
          env: {
            ELECTRON_RUN_AS_NODE: '1',
            GITGLASSES_ENGINE: '/ext/bin/gitglasses-engine',
            GITGLASSES_ALLOWED_ROOTS: '',
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
      args: launch.args,
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

  // Only the delimiter that opened a multi-line string closes it: ''' inside
  // """ (or """ inside ''') is part of the string.
  it('tells the two multi-line string delimiters apart', () => {
    for (const existing of [
      `[x]\ns = """ it's '''here\n[mcp_servers.gitglasses]\n"""\n`,
      `[x]\ns = ''' say """hi\n[mcp_servers.gitglasses]\n'''\n`,
      `[x]\ns = """ escaped \\""" still open\n[mcp_servers.gitglasses]\n"""\n`,
      `[x]\ns = "''' in a one-line string" # and """ in a comment\n`,
    ]) {
      const { content, replaced } = mergeCodexConfig(existing, launch);
      expect(replaced, existing).toBe(false);
      expect(content, existing).toBe(`${existing}\n${codexServerToml(launch)}`);
    }
  });

  it('closes a multi-line string that ends in extra quotes', () => {
    const existing = `s = """a ""quoted"""""\n[mcp_servers.gitglasses]\ncommand = "old"\n`;
    const { content, replaced } = mergeCodexConfig(existing, launch);
    expect(replaced).toBe(true);
    expect(content).toBe(`s = """a ""quoted"""""\n${codexServerToml(launch)}`);
  });

  it('leaves a header-like line inside a multi-line array alone', () => {
    const existing = 'matrix = [\n  [1],\n  [2]\n]\n[mcp_servers.gitglasses]\ncommand = "old"\n';
    const { content, replaced } = mergeCodexConfig(existing, launch);
    expect(replaced).toBe(true);
    expect(content).toBe(`matrix = [\n  [1],\n  [2]\n]\n${codexServerToml(launch)}`);
  });

  it('keeps the comments that end the old table, which introduce the next one', () => {
    const existing = [
      '[mcp_servers.gitglasses]',
      '# about gitglasses',
      'command = "old"',
      '',
      '# My other server, keep this comment',
      '[mcp_servers.other]',
      'command = "y"',
      '',
    ].join('\n');
    const { content } = mergeCodexConfig(existing, launch);
    expect(content).toBe(
      [
        codexServerToml(launch),
        '# My other server, keep this comment',
        '[mcp_servers.other]',
        'command = "y"',
        '',
      ].join('\n'),
    );
    expect(mergeCodexConfig(content, launch).content).toBe(content);

    const unspaced = '[mcp_servers.gitglasses]\ncommand = "old"\n# next\n[tui]\n';
    expect(mergeCodexConfig(unspaced, launch).content).toBe(
      `${codexServerToml(launch)}\n# next\n[tui]\n`,
    );
    const atEnd = 'model = "o3"\n[mcp_servers.gitglasses]\ncommand = "old"\n# the end\n';
    expect(mergeCodexConfig(atEnd, launch).content).toBe(
      `model = "o3"\n${codexServerToml(launch)}\n# the end\n`,
    );
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
