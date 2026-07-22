#!/usr/bin/env node
// Packages platform-specific VSIXes with the engine binary bundled in
// extension/bin/. Usage:
//   node scripts/package-vsix.mjs --engine <path-to-binary> --target linux-x64
// CI calls this once per platform with the matching cross-built engine.

import { execSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, rmSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);

function argValue(flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

const engine = argValue('--engine');
const target = argValue('--target');
if (!engine || !target) {
  console.error('usage: package-vsix.mjs --engine <binary> --target <vsce-target>');
  process.exit(2);
}

const extensionDir = path.join(root, 'extension');
const binDir = path.join(extensionDir, 'bin');
rmSync(binDir, { recursive: true, force: true });
mkdirSync(binDir, { recursive: true });

const binaryName = target.startsWith('win32') ? 'gitglasses-engine.exe' : 'gitglasses-engine';
const dest = path.join(binDir, binaryName);
copyFileSync(engine, dest);
if (!target.startsWith('win32')) chmodSync(dest, 0o755);

execSync('node esbuild.mjs', { cwd: extensionDir, stdio: 'inherit' });
execSync(`npx vsce package --no-dependencies --target ${target} --out ../dist/`, {
  cwd: extensionDir,
  stdio: 'inherit',
});
console.log(`packaged ${target}`);
