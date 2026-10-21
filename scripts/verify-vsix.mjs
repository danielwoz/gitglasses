#!/usr/bin/env node
// Inspects a packaged VSIX and, optionally, runs the engine and the MCP server
// inside it.
// Usage:
//   node scripts/verify-vsix.mjs <file.vsix> --target <target> [options]
// Options:
//   --version <v>             the release version the package must carry
//                             (default: extension/package.json)
//   --run                     run the packaged engine (--version and an
//                             initialize handshake) on this machine, then
//                             the packaged MCP server with it (handshake,
//                             tools/list and git_status on a new repository)
//   --extract-engine <path>   write the packaged engine to <path>, e.g. to
//                             run it inside a container
//
// Exits non-zero, listing every problem, when the package is not releasable.

import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { smokeTestEngine } from './lib/engine-smoke.mjs';
import { smokeTestMcpServer } from './lib/mcp-smoke.mjs';
import { inspectVsix } from './lib/vsix.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function fail(message, code = 1) {
  console.error(`verify-vsix: ${message}`);
  process.exit(code);
}

const args = process.argv.slice(2);
const options = { run: false };
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  const value = () => args[++i] ?? fail(`${arg} needs a value`, 2);
  if (arg === '--target') options.target = value();
  else if (arg === '--version') options.version = value();
  else if (arg === '--extract-engine') options.extract = path.resolve(value());
  else if (arg === '--run') options.run = true;
  else if (!arg.startsWith('--') && !options.vsix) options.vsix = arg;
  else fail(`unknown argument ${arg}`, 2);
}
if (!options.vsix || !options.target) {
  fail(
    'usage: verify-vsix.mjs <file.vsix> --target <target> [--version <v>] [--run] [--extract-engine <path>]',
    2,
  );
}

const readJson = (file) => JSON.parse(readFileSync(path.join(root, file), 'utf8'));
const version = options.version ?? readJson('extension/package.json').version;
const { problems, engine, mcp } = inspectVsix(readFileSync(options.vsix), {
  target: options.target,
  version,
});
if (problems.length > 0) fail(`${path.basename(options.vsix)}:\n  ${problems.join('\n  ')}`);

const writeEngine = (file) => {
  writeFileSync(file, engine.data);
  chmodSync(file, 0o755);
};
if (engine && options.extract) writeEngine(options.extract);
if (engine && options.run) {
  const dir = mkdtempSync(path.join(tmpdir(), 'gitglasses-vsix-'));
  const file = path.join(dir, path.basename(engine.name));
  try {
    writeEngine(file);
    const { protocolVersion } = readJson('packages/protocol/protocol.schema.json');
    const result = await smokeTestEngine(file, { version, protocolVersion });
    console.log(
      `engine ran: ${version}, protocol ${result.protocolVersion}, git CLI ${result.capabilities?.gitCli ? 'found' : 'not found'}`,
    );
  } catch (error) {
    fail(`${path.basename(options.vsix)}: the packaged engine failed to run: ${error.message}`);
  }
  // The MCP server alone in a directory with no node_modules, as the editor
  // runs it, reading a repository through the packaged engine.
  try {
    const cli = path.join(dir, 'mcp', 'cli.js');
    mkdirSync(path.dirname(cli));
    writeFileSync(cli, mcp.data);
    const repo = path.join(dir, 'repo');
    mkdirSync(repo);
    execFileSync('git', ['init', '-q', repo], { stdio: 'ignore' });
    const { tools, text } = await smokeTestMcpServer(cli, {
      version,
      env: { GITGLASSES_ENGINE: file, GITGLASSES_ALLOWED_ROOTS: '' },
      cwd: repo,
      call: { name: 'git_status', arguments: { repoPath: repo } },
    });
    if (!text.includes('no commits yet')) throw new Error(`git_status answered: ${text}`);
    console.log(`MCP server ran: ${tools.length} tools, git_status answered`);
  } catch (error) {
    fail(`${path.basename(options.vsix)}: the packaged MCP server failed to run: ${error.message}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const size = (bytes) => `${(bytes / 1048576).toFixed(1)} MiB`;
const engineNote = engine
  ? `; engine ${size(engine.size)} (${size(engine.compressedSize)} compressed)`
  : '';
console.log(`${path.basename(options.vsix)}: ok for ${options.target} ${version}${engineNote}`);
