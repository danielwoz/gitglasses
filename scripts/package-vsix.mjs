#!/usr/bin/env node
// Packages one VSIX for one target. Native targets bundle the engine binary
// in extension/bin/; the `web` target carries only the browser bundle and the
// wasm engine. Usage:
//   node scripts/package-vsix.mjs --target linux-x64 --engine <path-to-binary>
//   node scripts/package-vsix.mjs --target web
// Options:
//   --pre-release    mark the package for the pre-release channel
//   --out-dir <dir>  where the .vsix goes (default: dist/)
//
// The engine must be an executable for the target (checked from its header),
// the root LICENSE and NOTICE are packaged alongside extension/CHANGELOG.md,
// and the finished VSIX is inspected before the script reports success.

import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectVsix } from './lib/vsix.mjs';
import {
  ENGINE_HEADER_BYTES,
  NATIVE_TARGETS,
  WEB_TARGET,
  engineBinaryName,
  engineFormatProblem,
  isNativeTarget,
  wasmProblem,
} from './lib/targets.mjs';

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptsDir, '..');
const extensionDir = path.join(root, 'extension');

const USAGE =
  'usage: package-vsix.mjs --target <target> [--engine <binary>] [--pre-release] [--out-dir <dir>]\n' +
  `  native targets (need --engine): ${NATIVE_TARGETS.join(', ')}\n` +
  `  ${WEB_TARGET} (no --engine): the browser bundle and wasm engine only`;

function fail(message, code = 1) {
  console.error(`package-vsix: ${message}`);
  process.exit(code);
}

function parseArgs(argv) {
  const options = { preRelease: false, outDir: path.join(root, 'dist') };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      if (i + 1 >= argv.length) fail(`${arg} needs a value\n${USAGE}`, 2);
      return argv[++i];
    };
    if (arg === '--target') options.target = value();
    else if (arg === '--engine') options.engine = value();
    else if (arg === '--out-dir') options.outDir = path.resolve(value());
    else if (arg === '--pre-release') options.preRelease = true;
    else fail(`unknown argument ${arg}\n${USAGE}`, 2);
  }
  if (!options.target) fail(USAGE, 2);
  if (options.target === WEB_TARGET) {
    if (options.engine) fail('the web target carries the wasm engine only; drop --engine', 2);
  } else if (!isNativeTarget(options.target)) {
    fail(`unknown target ${options.target}\n${USAGE}`, 2);
  } else if (!options.engine) {
    fail(`--engine is required for ${options.target}\n${USAGE}`, 2);
  }
  return options;
}

function readHeader(file) {
  const buffer = Buffer.alloc(ENGINE_HEADER_BYTES);
  const fd = openSync(file, 'r');
  try {
    const length = readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, length);
  } finally {
    closeSync(fd);
  }
}

const options = parseArgs(process.argv.slice(2));
const { target } = options;
const native = target !== WEB_TARGET;

if (native) {
  if (!existsSync(options.engine)) fail(`engine ${options.engine} does not exist`);
  const problem = engineFormatProblem(readHeader(options.engine), target);
  if (problem) fail(`engine ${options.engine} is not a ${target} executable: ${problem}`);
}

const binDir = path.join(extensionDir, 'bin');
rmSync(binDir, { recursive: true, force: true });
if (native) {
  mkdirSync(binDir, { recursive: true });
  const dest = path.join(binDir, engineBinaryName(target));
  copyFileSync(options.engine, dest);
  if (!target.startsWith('win32-')) chmodSync(dest, 0o755);
}

execFileSync(process.execPath, ['esbuild.mjs'], { cwd: extensionDir, stdio: 'inherit' });
if (!native) {
  const wasm = path.join(extensionDir, 'dist', 'web', 'gitglasses-engine-wasm.wasm');
  if (!existsSync(path.join(extensionDir, 'dist', 'web', 'extension.js')) || !existsSync(wasm)) {
    fail('the web target needs the wasm engine build in build/wasm/engine (cmake --preset wasm)');
  }
  const problem = wasmProblem(readHeader(wasm));
  if (problem) fail(`${wasm}: ${problem}`);
}

// The license and third-party notices live at the repository root; they are
// staged into the extension only for the duration of the packaging.
const staged = ['LICENSE', 'NOTICE'].map((name) => {
  const dest = path.join(extensionDir, name);
  copyFileSync(path.join(root, name), dest);
  return dest;
});

const { version } = JSON.parse(readFileSync(path.join(extensionDir, 'package.json'), 'utf8'));
mkdirSync(options.outDir, { recursive: true });
const out = path.join(options.outDir, `gitglasses-${target}-${version}.vsix`);
// vsce comes from this package's pinned devDependency, not from PATH.
const vsce = path.join(
  path.dirname(createRequire(import.meta.url).resolve('@vscode/vsce/package.json')),
  'vsce',
);
const vsceArgs = [vsce, 'package', '--no-dependencies', '--target', target, '--out', out];
if (options.preRelease) vsceArgs.push('--pre-release');
try {
  execFileSync(process.execPath, vsceArgs, { cwd: extensionDir, stdio: 'inherit' });
} finally {
  for (const file of staged) rmSync(file, { force: true });
}

const { problems, engine } = inspectVsix(readFileSync(out), { target, version });
if (problems.length > 0) {
  rmSync(out, { force: true });
  fail(`${path.basename(out)} failed inspection:\n  ${problems.join('\n  ')}`);
}
const engineNote = engine ? `, engine ${(engine.size / 1048576).toFixed(1)} MiB` : '';
console.log(
  `packaged ${path.relative(root, out)} (${target}${options.preRelease ? ', pre-release' : ''}${engineNote})`,
);
