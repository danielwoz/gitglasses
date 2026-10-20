#!/usr/bin/env node
// Checks the gitglasses-mcp npm package before it is published: installs the
// tarball from pack-mcp.mjs into an empty directory, as `npx gitglasses-mcp`
// would, checks its files and the README npm will show, then starts the
// installed CLI and completes an MCP handshake and tools/list.
//
// With --engine-package, the engine package for this machine is installed
// alongside, as npm would install it from the optional dependencies. The
// server must then find the engine on its own, without GITGLASSES_ENGINE,
// and read a new repository with it.
// Usage:
//   node scripts/verify-mcp-package.mjs <gitglasses-mcp-x.y.z.tgz> [--version <v>]
//     [--engine-package <gitglasses-engine-<platform>-x.y.z.tgz>]

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import {
  ENGINE_PACKAGES,
  PACKAGE_FILES,
  enginePackageFiles,
  npmReadmeProblems,
} from './lib/mcp-package.mjs';
import { smokeTestMcpServer } from './lib/mcp-smoke.mjs';
import { readTarGz } from './lib/tar.mjs';

const USAGE =
  'usage: verify-mcp-package.mjs <gitglasses-mcp-x.y.z.tgz> [--version <v>] [--engine-package <tgz>]';
const options = {};
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--version') options.version = args[++i];
  else if (args[i] === '--engine-package') options.enginePackage = args[++i];
  else if (!args[i].startsWith('--') && !options.tarball) options.tarball = args[i];
  else options.bad = true;
}
const { tarball, version, enginePackage } = options;
if (
  options.bad ||
  !tarball ||
  !existsSync(tarball) ||
  (args.includes('--version') && !version) ||
  (args.includes('--engine-package') && !(enginePackage && existsSync(enginePackage)))
) {
  console.error(USAGE);
  process.exit(2);
}

function listFiles(dir, prefix = '') {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory()
      ? listFiles(full, `${prefix}${name}/`)
      : [`${prefix}${name}`];
  });
}

const dir = mkdtempSync(path.join(tmpdir(), 'gitglasses-mcp-package-'));
try {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  // Only the tarballs given are installed: the optional engine packages are
  // not fetched from the registry, where they may not be published yet.
  const specs = [tarball, enginePackage].filter(Boolean).map((file) => path.resolve(file));
  execFileSync(
    npm,
    [
      'install',
      '--prefix',
      dir,
      '--no-audit',
      '--no-fund',
      '--omit=dev',
      '--omit=optional',
      ...specs,
    ],
    {
      stdio: ['ignore', 'ignore', 'inherit'],
      shell: process.platform === 'win32',
    },
  );
  const installed = path.join(dir, 'node_modules', 'gitglasses-mcp');
  const files = listFiles(installed)
    .filter((file) => !file.startsWith('node_modules/'))
    .sort();
  if (JSON.stringify(files) !== JSON.stringify(PACKAGE_FILES)) {
    throw new Error(
      `package contents are ${files.join(', ')}; expected ${PACKAGE_FILES.join(', ')}`,
    );
  }
  const manifest = JSON.parse(readFileSync(path.join(installed, 'package.json'), 'utf8'));
  const missing = ENGINE_PACKAGES.filter(
    (engine) => manifest.optionalDependencies?.[engine.name] !== manifest.version,
  );
  if (missing.length > 0) {
    throw new Error(
      `optionalDependencies lack ${missing.map((engine) => `${engine.name}@${manifest.version}`).join(', ')}`,
    );
  }
  const readmeProblems = npmReadmeProblems(
    readFileSync(path.join(installed, 'README.md'), 'utf8'),
    version ?? manifest.version,
  );
  if (readmeProblems.length > 0)
    throw new Error(`${readmeProblems.join('; ')} (pack it with scripts/pack-mcp.mjs)`);

  const cli = path.join(installed, 'dist', 'cli.js');
  if (!enginePackage) {
    // No engine is configured, so the server must start without one.
    const { serverInfo, tools } = await smokeTestMcpServer(cli, {
      version,
      env: { GITGLASSES_ENGINE: '' },
    });
    console.log(
      `${path.basename(tarball)}: ok, ${serverInfo.name} ${serverInfo.version} with ${tools.length} tools`,
    );
  } else {
    const engineManifest = JSON.parse(
      readTarGz(readFileSync(enginePackage)).get('package/package.json').data.toString('utf8'),
    );
    const engine = ENGINE_PACKAGES.find((candidate) => candidate.name === engineManifest.name);
    if (!engine) throw new Error(`${engineManifest.name} is not a gitglasses engine package`);
    const engineDir = path.join(dir, 'node_modules', ...engine.name.split('/'));
    const engineFiles = listFiles(engineDir).sort();
    if (JSON.stringify(engineFiles) !== JSON.stringify(enginePackageFiles(engine))) {
      throw new Error(
        `${engine.name} contents are ${engineFiles.join(', ')}; expected ${enginePackageFiles(engine).join(', ')}`,
      );
    }
    if (
      process.platform !== 'win32' &&
      (statSync(path.join(engineDir, engine.binary)).mode & 0o111) === 0
    ) {
      throw new Error(`${engine.name}: ${engine.binary} is not executable`);
    }
    // The server finds the engine package by itself and reads a repository
    // in its working directory, the root a client offering none is given.
    const repo = path.join(dir, 'repo');
    mkdirSync(repo);
    execFileSync('git', ['init', '-q', repo], { stdio: 'ignore' });
    const { serverInfo, tools, text } = await smokeTestMcpServer(cli, {
      version,
      env: { GITGLASSES_ENGINE: '', GITGLASSES_ALLOWED_ROOTS: '' },
      cwd: repo,
      call: { name: 'git_status', arguments: { repoPath: repo } },
    });
    if (!text.includes('no commits yet')) throw new Error(`git_status answered: ${text}`);
    console.log(
      `${path.basename(tarball)}: ok, ${serverInfo.name} ${serverInfo.version} with ${tools.length} tools, ` +
        `reading a repository through ${engine.name}`,
    );
  }
} catch (error) {
  console.error(`verify-mcp-package: ${path.basename(tarball)}: ${error.message}`);
  process.exitCode = 1;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
