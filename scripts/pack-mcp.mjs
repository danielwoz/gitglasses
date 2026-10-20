#!/usr/bin/env node
// Packs gitglasses-mcp for npm from a staging directory, so the tarball holds
// only what an npm user needs: the bundled CLI, the licence, the manifest
// without its build-only fields (and with the engine packages as optional
// dependencies), and the npm README (mcp-server/npm-readme.md for this
// version) as README.md in place of the repository README, which describes
// running the server from a clone.
//
// With --engines, also packs an @gitglasses/engine-* package for every
// engine build found there, from <dir>/engine-<target>/gitglasses-engine[.exe]
// (the layout the release workflow downloads its engine artifacts into). Each
// engine must be an executable for its target. --all-engines makes a missing
// one an error, as a release needs every package its optional dependencies
// name.
// Usage:
//   node scripts/pack-mcp.mjs [--out <dir>] [--engines <dir> [--all-engines]]
// Build first (pnpm --filter "gitglasses-mcp..." build). The tarballs go to
// --out (default dist-npm/) and their paths are printed, one per line.

import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ENGINE_PACKAGES,
  NPM_README_TEMPLATE,
  engineManifest,
  engineReadme,
  npmReadmeProblems,
  publishedManifest,
  renderNpmReadme,
} from './lib/mcp-package.mjs';
import { ENGINE_HEADER_BYTES, engineFormatProblem } from './lib/targets.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageDir = path.join(root, 'mcp-server');
const USAGE = 'usage: pack-mcp.mjs [--out <dir>] [--engines <dir> [--all-engines]]';
const options = { out: path.join(root, 'dist-npm'), allEngines: false };
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const value = () => {
    if (i + 1 >= args.length) {
      console.error(USAGE);
      process.exit(2);
    }
    return path.resolve(args[++i]);
  };
  if (args[i] === '--out') options.out = value();
  else if (args[i] === '--engines') options.engines = value();
  else if (args[i] === '--all-engines') options.allEngines = true;
  else {
    console.error(USAGE);
    process.exit(2);
  }
}
if (options.allEngines && !options.engines) {
  console.error(USAGE);
  process.exit(2);
}
const { out } = options;

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
const readme = renderNpmReadme(
  readFileSync(path.join(root, NPM_README_TEMPLATE), 'utf8'),
  manifest.version,
);
const problems = npmReadmeProblems(readme, manifest.version);
if (problems.length > 0) fail(`${NPM_README_TEMPLATE}: ${problems.join('; ')}`);

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

/** Packs the staged directory into `out` and prints the tarball's path. */
function pack(stage) {
  mkdirSync(out, { recursive: true });
  const packed = execFileSync(
    npm,
    ['pack', '--json', '--ignore-scripts', '--pack-destination', out],
    {
      cwd: stage,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
      shell: process.platform === 'win32',
    },
  );
  console.log(path.join(out, JSON.parse(packed)[0].filename));
}

// Every engine is checked before anything is packed, so a bad one never
// leaves a partial set behind.
const engines = [];
if (options.engines) {
  for (const engine of ENGINE_PACKAGES) {
    const binary = path.join(
      options.engines,
      `engine-${engine.target}`,
      path.basename(engine.binary),
    );
    if (!existsSync(binary)) {
      if (options.allEngines) fail(`no ${engine.target} engine at ${binary}`);
      continue;
    }
    const header = readFileSync(binary).subarray(0, ENGINE_HEADER_BYTES);
    const problem = engineFormatProblem(header, engine.target);
    if (problem) fail(`${binary} is not a ${engine.target} executable: ${problem}`);
    engines.push({ engine, binary });
  }
  if (engines.length === 0) fail(`no engine builds under ${options.engines}`);
}

for (const { engine, binary } of engines) {
  const stage = mkdtempSync(path.join(tmpdir(), 'gitglasses-engine-stage-'));
  try {
    writeFileSync(
      path.join(stage, 'package.json'),
      `${JSON.stringify(engineManifest(engine, manifest), null, 2)}\n`,
    );
    writeFileSync(path.join(stage, 'README.md'), engineReadme(engine, manifest.version));
    copyFileSync(path.join(root, 'LICENSE'), path.join(stage, 'LICENSE'));
    copyFileSync(path.join(root, 'NOTICE'), path.join(stage, 'NOTICE'));
    mkdirSync(path.join(stage, 'bin'));
    copyFileSync(binary, path.join(stage, engine.binary));
    chmodSync(path.join(stage, engine.binary), 0o755);
    pack(stage);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

const stage = mkdtempSync(path.join(tmpdir(), 'gitglasses-mcp-stage-'));
try {
  writeFileSync(
    path.join(stage, 'package.json'),
    `${JSON.stringify(publishedManifest(manifest), null, 2)}\n`,
  );
  writeFileSync(path.join(stage, 'README.md'), readme);
  for (const file of ['LICENSE', ...manifest.files]) {
    mkdirSync(path.dirname(path.join(stage, file)), { recursive: true });
    copyFileSync(path.join(packageDir, file), path.join(stage, file));
  }
  // npm packs files with their mode on disk; the CLI must be executable.
  for (const bin of Object.values(manifest.bin)) chmodSync(path.join(stage, bin), 0o755);
  pack(stage);
} finally {
  rmSync(stage, { recursive: true, force: true });
}
