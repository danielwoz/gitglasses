#!/usr/bin/env node
// Packs gitglasses-mcp for npm from a staging directory, so the tarball holds
// only what an npm user needs: the bundled CLI, the licence, the manifest
// without its build-only fields, and the npm README (mcp-server/npm-readme.md
// for this version) as README.md in place of the repository README, which
// describes running the server from a clone.
// Usage:
//   node scripts/pack-mcp.mjs [--out <dir>]
// Build first (pnpm --filter "gitglasses-mcp..." build). The tarball goes to
// --out (default dist-npm/) and its path is printed.

import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NPM_README_TEMPLATE, npmReadmeProblems, publishedManifest, renderNpmReadme } from './lib/mcp-package.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageDir = path.join(root, 'mcp-server');
const args = process.argv.slice(2);
const outIndex = args.indexOf('--out');
if ((outIndex >= 0 && !args[outIndex + 1]) || args.length !== (outIndex >= 0 ? 2 : 0)) {
  console.error('usage: pack-mcp.mjs [--out <dir>]');
  process.exit(2);
}
const out = path.resolve(outIndex >= 0 ? args[outIndex + 1] : path.join(root, 'dist-npm'));

function fail(message) {
  console.error(`pack-mcp: ${message}`);
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(path.join(packageDir, 'package.json'), 'utf8'));
for (const file of manifest.files) {
  if (!existsSync(path.join(packageDir, file))) {
    fail(`mcp-server/${file} is missing; build it first: pnpm --filter "gitglasses-mcp..." build`);
  }
}
const readme = renderNpmReadme(readFileSync(path.join(root, NPM_README_TEMPLATE), 'utf8'), manifest.version);
const problems = npmReadmeProblems(readme, manifest.version);
if (problems.length > 0) fail(`${NPM_README_TEMPLATE}: ${problems.join('; ')}`);

const stage = mkdtempSync(path.join(tmpdir(), 'gitglasses-mcp-stage-'));
try {
  writeFileSync(path.join(stage, 'package.json'), `${JSON.stringify(publishedManifest(manifest), null, 2)}\n`);
  writeFileSync(path.join(stage, 'README.md'), readme);
  for (const file of ['LICENSE', ...manifest.files]) {
    mkdirSync(path.dirname(path.join(stage, file)), { recursive: true });
    copyFileSync(path.join(packageDir, file), path.join(stage, file));
  }
  // npm packs files with their mode on disk; the CLI must be executable.
  for (const bin of Object.values(manifest.bin)) chmodSync(path.join(stage, bin), 0o755);
  mkdirSync(out, { recursive: true });
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const packed = execFileSync(npm, ['pack', '--json', '--ignore-scripts', '--pack-destination', out], {
    cwd: stage,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    shell: process.platform === 'win32',
  });
  console.log(path.join(out, JSON.parse(packed)[0].filename));
} finally {
  rmSync(stage, { recursive: true, force: true });
}
