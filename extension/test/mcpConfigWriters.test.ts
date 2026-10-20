// Writing the MCP server into Codex's config.toml and Claude Code's
// configuration, against a throwaway home directory: the user's own
// configuration is never touched.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ConfigChangedError,
  addToClaudeCode,
  codexConfigPath,
  planCodexWrite,
  runProgram,
  writeCodexConfig,
  type RunResult,
} from '../src/mcp/mcpConfigWriters';
import { codexServerToml, findOnPath, type McpLaunch } from '../src/mcp/mcpLogic';

const launch: McpLaunch = {
  command: '/opt/editor/code',
  args: ['/ext/dist/mcp/cli.js'],
  env: {
    ELECTRON_RUN_AS_NODE: '1',
    GITGLASSES_ENGINE: '/ext/bin/gitglasses-engine',
    GITGLASSES_ALLOWED_ROOTS: '',
  },
};

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'gitglasses-mcp-home-'));
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe('Codex config.toml', () => {
  it('lives in ~/.codex unless CODEX_HOME says otherwise', () => {
    expect(codexConfigPath({}, home)).toBe(path.join(home, '.codex', 'config.toml'));
    expect(codexConfigPath({ CODEX_HOME: path.join(home, 'codex') }, home)).toBe(
      path.join(home, 'codex', 'config.toml'),
    );
  });

  it('creates the file, private to the user, and is idempotent', () => {
    const file = codexConfigPath({}, home);
    const plan = planCodexWrite(file, launch, '~/.codex/config.toml');
    expect(plan).toMatchObject({ existed: false, before: '', replaced: false });
    expect(plan.diff.split('\n').slice(0, 3)).toEqual([
      '--- ~/.codex/config.toml',
      '+++ ~/.codex/config.toml',
      '+[mcp_servers.gitglasses]',
    ]);
    // Planning writes nothing.
    expect(fs.existsSync(file)).toBe(false);

    writeCodexConfig(plan);
    expect(fs.readFileSync(file, 'utf8')).toBe(codexServerToml(launch));
    if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(path.dirname(file))).toEqual(['config.toml']);

    const again = planCodexWrite(file, launch);
    expect(again.after).toBe(again.before);
  });

  it('merges into an existing file, keeping its other settings and its mode', () => {
    const file = codexConfigPath({}, home);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const existing =
      'model = "o3"\n\n[mcp_servers.gitglasses]\ncommand = "/old/node"\n\n[tui]\nx = 1\n';
    fs.writeFileSync(file, existing, { mode: 0o640 });
    if (process.platform !== 'win32') fs.chmodSync(file, 0o640);

    const plan = planCodexWrite(file, launch);
    expect(plan).toMatchObject({ existed: true, replaced: true });
    expect(plan.diff).toContain('-command = "/old/node"');
    writeCodexConfig(plan);
    expect(fs.readFileSync(file, 'utf8')).toBe(
      `model = "o3"\n\n${codexServerToml(launch)}\n[tui]\nx = 1\n`,
    );
    if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o777).toBe(0o640);
  });

  it('refuses to write over a file that changed after the user saw the diff', () => {
    const file = codexConfigPath({}, home);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'model = "o3"\n');
    const plan = planCodexWrite(file, launch);
    fs.writeFileSync(file, 'model = "o4"\n');
    expect(() => writeCodexConfig(plan)).toThrow(ConfigChangedError);
    expect(fs.readFileSync(file, 'utf8')).toBe('model = "o4"\n');
  });
});

describe('Claude Code', () => {
  const scripted = (results: RunResult[]) => {
    const calls: string[][] = [];
    return {
      calls,
      run: async (_command: string, args: string[]) => {
        calls.push(args);
        return results.shift() ?? { ok: false, output: 'unexpected call' };
      },
    };
  };

  it('adds the server to the user configuration with claude mcp add-json', async () => {
    const { run, calls } = scripted([{ ok: true, output: 'Added stdio MCP server gitglasses' }]);
    expect(await addToClaudeCode('/bin/claude', launch, run)).toEqual({
      ok: true,
      output: 'Added stdio MCP server gitglasses',
      replaced: false,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].slice(0, 5)).toEqual(['mcp', 'add-json', '--scope', 'user', 'gitglasses']);
  });

  it('replaces a gitglasses server that is already there', async () => {
    const { run, calls } = scripted([
      { ok: false, output: 'MCP server gitglasses already exists in user config' },
      { ok: true, output: 'Removed MCP server gitglasses from user config' },
      { ok: true, output: 'Added stdio MCP server gitglasses to user config' },
    ]);
    expect(await addToClaudeCode('/bin/claude', launch, run)).toMatchObject({
      ok: true,
      replaced: true,
    });
    expect(calls.map((args) => args.slice(0, 2).join(' '))).toEqual([
      'mcp add-json',
      'mcp remove',
      'mcp add-json',
    ]);
    expect(calls[1]).toEqual(['mcp', 'remove', '--scope', 'user', 'gitglasses']);
  });

  it('reports any other failure without removing anything', async () => {
    const { run, calls } = scripted([{ ok: false, output: 'Invalid JSON' }]);
    expect(await addToClaudeCode('/bin/claude', launch, run)).toEqual({
      ok: false,
      output: 'Invalid JSON',
      replaced: false,
    });
    expect(calls).toHaveLength(1);
  });

  // A stand-in claude CLI on PATH that keeps its configuration under the fake
  // home, run the way the command runs the real one: found on PATH, started
  // without a shell, the JSON passed as one argument.
  it.skipIf(process.platform === 'win32')(
    'runs the claude found on PATH without a shell, the JSON intact',
    async () => {
      const bin = path.join(home, 'bin');
      fs.mkdirSync(bin);
      const config = path.join(home, '.claude.json');
      const claude = path.join(bin, 'claude');
      fs.writeFileSync(
        claude,
        [
          `#!${process.execPath}`,
          "const fs = require('fs');",
          `const file = ${JSON.stringify(config)};`,
          "const servers = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};",
          'const [, , mcp, verb, , scope, name, json] = process.argv;',
          "if (verb === 'add-json' && servers[name]) {",
          "  console.error('MCP server ' + name + ' already exists in ' + scope + ' config');",
          '  process.exit(1);',
          '}',
          "if (verb === 'add-json') servers[name] = JSON.parse(json);",
          "if (verb === 'remove') delete servers[name];",
          'fs.writeFileSync(file, JSON.stringify(servers));',
          "console.log('ok ' + verb);",
          '',
        ].join('\n'),
        { mode: 0o755 },
      );
      const found = findOnPath('claude', {
        env: { PATH: `/nonexistent:${bin}` },
        platform: process.platform,
        isFile: (candidate) => fs.existsSync(candidate),
      });
      expect(found).toBe(claude);

      const tricky: McpLaunch = { ...launch, args: ["/ext dir/it's $(here)/cli.js"] };
      expect(await addToClaudeCode(found!, tricky, runProgram)).toMatchObject({ ok: true });
      expect(JSON.parse(fs.readFileSync(config, 'utf8')).gitglasses.args).toEqual(tricky.args);
      expect(await addToClaudeCode(found!, launch, runProgram)).toMatchObject({
        ok: true,
        replaced: true,
      });
      expect(JSON.parse(fs.readFileSync(config, 'utf8'))).toEqual({
        gitglasses: { type: 'stdio', ...launch },
      });
    },
  );
});
