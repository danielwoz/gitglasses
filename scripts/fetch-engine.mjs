#!/usr/bin/env node
// Downloads a prebuilt engine for TypeScript-only work, so the extension, its
// tests, the e2e suite and the MCP server run without a C++ toolchain.
//
// CI uploads the release engine of every push to main as an artifact named
// after a key of the engine's sources (engine/, the CMake files, vcpkg.json
// and ci/). This script computes the key of the checkout and downloads the
// build with exactly that key, so the engine always speaks the protocol the
// TypeScript code expects; it never substitutes an engine built from other
// sources. The binary lands in build/release/engine/, where everything that
// needs an engine looks first.
//
// Usage: node scripts/fetch-engine.mjs [--force]
//          --force  replace an engine that was built locally
//        node scripts/fetch-engine.mjs --print-key
//          print the engine source key of HEAD (CI names artifacts with it)
//
// GitHub only serves artifacts to signed-in clients, even for a public
// repository: set GITHUB_TOKEN (or GH_TOKEN), or sign in with `gh auth login`.

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inflateRawSync } from 'node:zlib';

// Everything the engine binary is built from.
export const ENGINE_SOURCES = ['engine', 'CMakeLists.txt', 'CMakePresets.json', 'vcpkg.json', 'ci'];

// Hosts CI builds an engine for, keyed by `${process.platform}-${process.arch}`.
const CI_TARGETS = new Set(['linux-x64', 'darwin-arm64', 'win32-x64']);

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function git(cwd, args, input) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', input });
}

// A short hash of the git trees and blobs of ENGINE_SOURCES at `rev`. Equal
// keys mean byte-identical engine sources.
export function engineKey(cwd, rev = 'HEAD') {
  const objects = git(cwd, ['rev-parse', ...ENGINE_SOURCES.map((source) => `${rev}:${source}`)]);
  return git(cwd, ['hash-object', '--stdin'], objects).trim().slice(0, 16);
}

// True when the working tree changes an engine source, which the key of HEAD
// does not reflect.
export function engineSourcesModified(cwd) {
  return git(cwd, ['status', '--porcelain', '--', ...ENGINE_SOURCES]).trim() !== '';
}

// The CI artifact target for a host, or undefined when CI builds none for it.
export function hostTarget(platform = process.platform, arch = process.arch) {
  const target = `${platform}-${arch}`;
  return CI_TARGETS.has(target) ? target : undefined;
}

export function artifactName(target, key) {
  return `ci-engine-${target}-${key}`;
}

// "owner/name" of the upstream repository, from the extension manifest.
export function repositorySlug(cwd) {
  if (process.env.GITGLASSES_REPO) return process.env.GITGLASSES_REPO;
  const manifest = JSON.parse(readFileSync(path.join(cwd, 'extension', 'package.json'), 'utf8'));
  const url =
    typeof manifest.repository === 'string' ? manifest.repository : manifest.repository?.url;
  const match = /github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?$/.exec(url ?? '');
  if (!match) throw new Error(`cannot find the GitHub repository in extension/package.json`);
  return match[1];
}

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

// What `engineFile` holds: nothing ({ kind: 'none' }), the engine this script
// installed ({ kind: 'prebuilt', key }), or an engine built or replaced
// locally ({ kind: 'local' }). The marker records the digest of the binary
// it installed, so a local build over a fetched engine counts as local even
// though the marker is still there.
export function installedEngine(engineFile, markerFile) {
  if (!existsSync(engineFile)) return { kind: 'none' };
  let marker;
  try {
    marker = JSON.parse(readFileSync(markerFile, 'utf8'));
  } catch {
    return { kind: 'local' };
  }
  if (typeof marker?.sha256 !== 'string' || marker.sha256 !== sha256(readFileSync(engineFile))) {
    return { kind: 'local' };
  }
  return { kind: 'prebuilt', key: marker.key };
}

// The newest unexpired artifact from a run of this repository's own main
// branch. Pull-request runs (including runs of forks) are never trusted.
export function pickArtifact(artifacts) {
  return artifacts
    .filter(
      (artifact) =>
        !artifact.expired &&
        artifact.workflow_run?.head_branch === 'main' &&
        artifact.workflow_run.head_repository_id === artifact.workflow_run.repository_id,
    )
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0];
}

// Returns the bytes of the entry called `name` in a zip archive, or undefined
// when the archive has no such entry. Supports the stored and deflated
// entries GitHub's artifact archives contain.
export function extractZipEntry(zip, name) {
  let end = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 0xffff); i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error('not a zip archive');
  const entries = zip.readUInt16LE(end + 10);
  let offset = zip.readUInt32LE(end + 16);
  for (let entry = 0; entry < entries; entry++) {
    if (zip.readUInt32LE(offset) !== 0x02014b50) throw new Error('corrupt zip directory');
    const method = zip.readUInt16LE(offset + 10);
    const compressedSize = zip.readUInt32LE(offset + 20);
    const size = zip.readUInt32LE(offset + 24);
    const nameLength = zip.readUInt16LE(offset + 28);
    const extraLength = zip.readUInt16LE(offset + 30);
    const commentLength = zip.readUInt16LE(offset + 32);
    const localHeader = zip.readUInt32LE(offset + 42);
    const entryName = zip.toString('utf8', offset + 46, offset + 46 + nameLength);
    offset += 46 + nameLength + extraLength + commentLength;
    if (entryName !== name) continue;

    if (zip.readUInt32LE(localHeader) !== 0x04034b50) throw new Error('corrupt zip entry');
    const dataStart =
      localHeader + 30 + zip.readUInt16LE(localHeader + 26) + zip.readUInt16LE(localHeader + 28);
    const data = zip.subarray(dataStart, dataStart + compressedSize);
    let bytes;
    if (method === 0) bytes = Buffer.from(data);
    else if (method === 8) bytes = inflateRawSync(data);
    else throw new Error(`unsupported zip compression method ${method}`);
    if (bytes.length !== size) throw new Error(`zip entry ${name} is truncated`);
    return bytes;
  }
  return undefined;
}

function githubToken() {
  const fromEnv = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (fromEnv) return fromEnv;
  const gh = spawnSync('gh', ['auth', 'token'], { encoding: 'utf8' });
  return gh.status === 0 ? gh.stdout.trim() : undefined;
}

async function github(url, token) {
  const response = await fetch(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'User-Agent': 'gitglasses-fetch-engine',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status} ${response.statusText}`);
  return response;
}

async function main(argv) {
  if (argv.includes('--print-key')) {
    console.log(engineKey(repoRoot));
    return 0;
  }
  const force = argv.includes('--force');

  const target = hostTarget();
  if (!target) {
    console.error(
      `CI builds no engine for ${process.platform}-${process.arch}; build it instead (see README.md, Building).`,
    );
    return 1;
  }
  const key = engineKey(repoRoot);
  if (engineSourcesModified(repoRoot)) {
    console.warn(
      'warning: the working tree changes engine sources; the prebuilt engine matches HEAD, not them',
    );
  }

  const binary = process.platform === 'win32' ? 'gitglasses-engine.exe' : 'gitglasses-engine';
  const outDir = path.join(repoRoot, 'build', 'release', 'engine');
  const outFile = path.join(outDir, binary);
  const markerFile = path.join(outDir, 'prebuilt-engine.json');
  const installed = installedEngine(outFile, markerFile);
  if (installed.kind === 'prebuilt' && installed.key === key) {
    console.log(`${path.relative(repoRoot, outFile)} already matches engine sources ${key}`);
    return 0;
  }
  if (installed.kind === 'local' && !force) {
    console.error(
      `${path.relative(repoRoot, outFile)} was built locally; pass --force to replace it`,
    );
    return 1;
  }

  const token = githubToken();
  if (!token) {
    console.error(
      'GitHub serves CI artifacts only to signed-in clients: set GITHUB_TOKEN or run `gh auth login`',
    );
    return 1;
  }

  const slug = repositorySlug(repoRoot);
  const name = artifactName(target, key);
  const listing = await github(
    `https://api.github.com/repos/${slug}/actions/artifacts?per_page=100&name=${name}`,
    token,
  );
  const artifact = pickArtifact((await listing.json()).artifacts ?? []);
  if (!artifact) {
    console.error(
      `no CI build of main has engine sources ${key} (${name}).\n` +
        'The engine differs from every recent main build, or its artifacts have expired;\n' +
        'build it instead: see README.md, Building.',
    );
    return 1;
  }

  const run = await (
    await github(
      `https://api.github.com/repos/${slug}/actions/runs/${artifact.workflow_run.id}`,
      token,
    )
  ).json();
  if (run.event !== 'push' || !String(run.path).startsWith('.github/workflows/ci.yml')) {
    console.error(`artifact ${name} comes from an unexpected run (${run.html_url}); not using it`);
    return 1;
  }

  console.log(`downloading ${name} from ${run.html_url}`);
  // The API answers with a redirect to short-lived storage; fetch drops the
  // Authorization header when it follows it to another origin.
  const archive = await github(artifact.archive_download_url, token);
  const bytes = extractZipEntry(Buffer.from(await archive.arrayBuffer()), binary);
  if (!bytes) throw new Error(`artifact ${name} does not contain ${binary}`);

  mkdirSync(outDir, { recursive: true });
  const partial = `${outFile}.partial`;
  writeFileSync(partial, bytes);
  chmodSync(partial, 0o755);
  renameSync(partial, outFile);
  writeFileSync(
    markerFile,
    JSON.stringify(
      { key, sha256: sha256(bytes), artifact: name, run: run.html_url, commit: run.head_sha },
      null,
      2,
    ) + '\n',
  );
  console.log(`installed ${path.relative(repoRoot, outFile)} (engine sources ${key})`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
