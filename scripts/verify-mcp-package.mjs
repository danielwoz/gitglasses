#!/usr/bin/env node
// Checks the gitglasses-mcp npm package before it is published: installs the
// packed tarball into an empty directory, as `npx gitglasses-mcp` would, then
// starts the installed CLI and completes an MCP handshake and tools/list.
// Usage:
//   node scripts/verify-mcp-package.mjs <gitglasses-mcp-x.y.z.tgz> [--version <v>]

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { smokeTestMcpServer } from './lib/mcp-smoke.mjs';

// Everything the package may contain; anything else is a packaging mistake.
const EXPECTED_FILES = ['LICENSE', 'README.md', 'dist/cli.js', 'package.json'];

const args = process.argv.slice(2);
const tarball = args.find((arg) => !arg.startsWith('--') && args[args.indexOf(arg) - 1] !== '--version');
const versionIndex = args.indexOf('--version');
const version = versionIndex >= 0 ? args[versionIndex + 1] : undefined;
if (!tarball || !existsSync(tarball)) {
  console.error('usage: verify-mcp-package.mjs <gitglasses-mcp-x.y.z.tgz> [--version <v>]');
  process.exit(2);
}

function listFiles(dir, prefix = '') {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? listFiles(full, `${prefix}${name}/`) : [`${prefix}${name}`];
  });
}

const dir = mkdtempSync(path.join(tmpdir(), 'gitglasses-mcp-package-'));
try {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  execFileSync(npm, ['install', '--prefix', dir, '--no-audit', '--no-fund', '--omit=dev', path.resolve(tarball)], {
    stdio: ['ignore', 'ignore', 'inherit'],
    shell: process.platform === 'win32',
  });
  const installed = path.join(dir, 'node_modules', 'gitglasses-mcp');
  const files = listFiles(installed).filter((file) => !file.startsWith('node_modules/')).sort();
  if (JSON.stringify(files) !== JSON.stringify(EXPECTED_FILES)) {
    throw new Error(`package contents are ${files.join(', ')}; expected ${EXPECTED_FILES.join(', ')}`);
  }
  // No engine is configured, so the server must start without one.
  const { serverInfo, tools } = await smokeTestMcpServer(path.join(installed, 'dist', 'cli.js'), {
    version,
    env: { GITGLASSES_ENGINE: '' },
  });
  console.log(`${path.basename(tarball)}: ok, ${serverInfo.name} ${serverInfo.version} with ${tools.length} tools`);
} catch (error) {
  console.error(`verify-mcp-package: ${path.basename(tarball)}: ${error.message}`);
  process.exitCode = 1;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
