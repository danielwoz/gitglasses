// Tests for .github/actions/setup-vcpkg/install.sh, run against a stand-in
// vcpkg that records how it was called and what the install directory held.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, it } from 'node:test';

const installScript = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../.github/actions/setup-vcpkg/install.sh',
);

let root;
let workspace;
let installRoot;
let callLog;

// Records its working directory, its arguments and whether the install
// directory still held the stale package, then installs a fresh one.
const fakeVcpkg = `#!/usr/bin/env bash
set -eu
root=""
for arg in "$@"; do
  case "$arg" in --x-install-root=*) root="\${arg#--x-install-root=}" ;; esac
done
stale=no
if [ -e "$root/vcpkg/info/libgit2_1.9.4.list" ]; then stale=yes; fi
{ echo "cwd=$PWD"; echo "stale=$stale"; printf 'arg=%s\\n' "$@"; } > "$CALL_LOG"
mkdir -p "$root/vcpkg/info"
touch "$root/vcpkg/info/libgit2_1.9.7.list"
`;

function install(env) {
  execFileSync('bash', [installScript], {
    cwd: workspace,
    encoding: 'utf8',
    env: {
      ...process.env,
      VCPKG_ROOT: path.join(root, 'vcpkg'),
      TRIPLET: 'wasm32-emscripten-gg',
      INSTALL_ROOT: installRoot,
      PACKAGES: '',
      CACHE_HIT: '',
      VCPKG_DEFAULT_BINARY_CACHE: path.join(root, 'archives'),
      GITHUB_WORKSPACE: workspace,
      RUNNER_TEMP: path.join(root, 'temp'),
      CALL_LOG: callLog,
      ...env,
    },
  });
  const lines = readFileSync(callLog, 'utf8').trimEnd().split('\n');
  return {
    cwd: lines.find((line) => line.startsWith('cwd=')).slice(4),
    stale: lines.includes('stale=yes'),
    args: lines.filter((line) => line.startsWith('arg=')).map((line) => line.slice(4)),
  };
}

// An install directory as an older baseline left it.
function seedStaleInstall() {
  mkdirSync(path.join(installRoot, 'vcpkg', 'info'), { recursive: true });
  writeFileSync(path.join(installRoot, 'vcpkg', 'info', 'libgit2_1.9.4.list'), '');
}

describe('setup-vcpkg install.sh', { skip: process.platform === 'win32' }, () => {
  beforeEach(() => {
    root = realpathSync(mkdtempSync(path.join(tmpdir(), 'gg-setup-vcpkg-')));
    workspace = path.join(root, 'workspace');
    installRoot = path.join(root, 'cache', 'vcpkg_wasm');
    callLog = path.join(root, 'calls.txt');
    mkdirSync(path.join(root, 'vcpkg'));
    mkdirSync(path.join(root, 'temp'));
    mkdirSync(workspace);
    writeFileSync(path.join(root, 'vcpkg', 'vcpkg'), fakeVcpkg);
    chmodSync(path.join(root, 'vcpkg', 'vcpkg'), 0o755);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('starts from an empty install directory when the cache fell back to an older entry', () => {
    seedStaleInstall();
    const call = install({ PACKAGES: 'libgit2[core,pcre2] nlohmann-json', CACHE_HIT: 'false' });
    assert.equal(call.stale, false);
    assert.equal(existsSync(path.join(installRoot, 'vcpkg', 'info', 'libgit2_1.9.4.list')), false);
    assert.equal(existsSync(path.join(installRoot, 'vcpkg', 'info', 'libgit2_1.9.7.list')), true);
  });

  it('starts from an empty install directory when the cache had nothing', () => {
    seedStaleInstall();
    assert.equal(install({ CACHE_HIT: '' }).stale, false);
  });

  it('keeps an install directory restored for exactly this request', () => {
    seedStaleInstall();
    assert.equal(install({ CACHE_HIT: 'true' }).stale, true);
  });

  it('installs listed packages in classic mode from outside the checkout', () => {
    const call = install({ PACKAGES: 'libgit2[core,pcre2] nlohmann-json' });
    assert.equal(call.cwd, path.join(root, 'temp'));
    assert.deepEqual(call.args, [
      'install',
      '--triplet',
      'wasm32-emscripten-gg',
      `--overlay-triplets=${path.join(workspace, 'ci', 'triplets')}`,
      `--x-install-root=${installRoot}`,
      'libgit2[core,pcre2]',
      'nlohmann-json',
    ]);
    assert.equal(existsSync(path.join(root, 'archives')), true);
  });

  it('installs vcpkg.json from the checkout when no packages are listed', () => {
    const call = install({ TRIPLET: 'x64-linux' });
    assert.equal(call.cwd, workspace);
    assert.deepEqual(call.args, [
      'install',
      '--triplet',
      'x64-linux',
      `--overlay-triplets=${path.join(workspace, 'ci', 'triplets')}`,
      `--x-install-root=${installRoot}`,
    ]);
  });
});
