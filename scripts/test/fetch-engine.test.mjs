// Tests for scripts/fetch-engine.mjs: the engine source key, artifact
// selection and archive extraction. Nothing here talks to GitHub.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'vitest';
import { deflateRawSync } from 'node:zlib';

import {
  artifactName,
  engineKey,
  engineSourcesModified,
  extractZipEntry,
  hostTarget,
  installedEngine,
  pickArtifact,
  repositorySlug,
  sha256,
} from '../fetch-engine.mjs';

let repo;

function git(...args) {
  return execFileSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
      GIT_COMMITTER_NAME: 'Fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
      GIT_CONFIG_NOSYSTEM: '1',
    },
  });
}

function write(file, contents) {
  mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
  writeFileSync(path.join(repo, file), contents);
}

function commitAll(message) {
  git('add', '-A');
  git('commit', '-q', '-m', message);
}

beforeEach(() => {
  repo = mkdtempSync(path.join(tmpdir(), 'gg-fetch-engine-'));
  git('init', '-q', '-b', 'main');
  git('config', 'commit.gpgsign', 'false');
  write('engine/src/main.cpp', 'int main() { return 0; }\n');
  write('CMakeLists.txt', 'project(x)\n');
  write('CMakePresets.json', '{}\n');
  write('vcpkg.json', '{}\n');
  write('ci/triplets/x.cmake', '\n');
  write('README.md', 'readme\n');
  commitAll('initial');
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe('engineKey', () => {
  it('changes with the engine sources and nothing else', () => {
    const initial = engineKey(repo);
    assert.match(initial, /^[0-9a-f]{16}$/);

    write('README.md', 'edited\n');
    write('extension/src/a.ts', 'export {};\n');
    commitAll('docs and extension');
    assert.equal(engineKey(repo), initial);

    write('engine/src/main.cpp', 'int main() { return 1; }\n');
    commitAll('engine');
    assert.notEqual(engineKey(repo), initial);
    assert.equal(engineKey(repo, 'HEAD~2'), initial);

    write('vcpkg.json', '{ "dependencies": [] }\n');
    commitAll('dependencies');
    assert.notEqual(engineKey(repo), engineKey(repo, 'HEAD~1'));
  });
});

describe('engineSourcesModified', () => {
  it('reports uncommitted engine changes only', () => {
    assert.equal(engineSourcesModified(repo), false);
    write('README.md', 'edited\n');
    assert.equal(engineSourcesModified(repo), false);
    write('engine/src/new.cpp', '\n');
    assert.equal(engineSourcesModified(repo), true);
  });
});

describe('hostTarget', () => {
  it('names the hosts CI builds an engine for', () => {
    assert.equal(hostTarget('linux', 'x64'), 'linux-x64');
    assert.equal(hostTarget('darwin', 'arm64'), 'darwin-arm64');
    assert.equal(hostTarget('win32', 'x64'), 'win32-x64');
    assert.equal(hostTarget('linux', 'arm64'), undefined);
    assert.equal(hostTarget('darwin', 'x64'), undefined);
  });

  it('combines with the key into the CI artifact name', () => {
    assert.equal(
      artifactName('linux-x64', '0123456789abcdef'),
      'ci-engine-linux-x64-0123456789abcdef',
    );
  });
});

describe('repositorySlug', () => {
  afterEach(() => {
    delete process.env.GITGLASSES_REPO;
  });

  it('reads the repository from the extension manifest', () => {
    write(
      'extension/package.json',
      JSON.stringify({ repository: { type: 'git', url: 'https://github.com/owner/name.git' } }),
    );
    assert.equal(repositorySlug(repo), 'owner/name');
    write('extension/package.json', JSON.stringify({ repository: 'git@github.com:owner/other' }));
    assert.equal(repositorySlug(repo), 'owner/other');
  });

  it('prefers GITGLASSES_REPO', () => {
    process.env.GITGLASSES_REPO = 'fork/gitglasses';
    assert.equal(repositorySlug(repo), 'fork/gitglasses');
  });
});

describe('installedEngine', () => {
  const fetched = Buffer.from('\x7fELF fetched engine');
  let engineFile;
  let markerFile;

  beforeEach(() => {
    engineFile = path.join(repo, 'build', 'release', 'engine', 'gitglasses-engine');
    markerFile = path.join(repo, 'build', 'release', 'engine', 'prebuilt-engine.json');
    mkdirSync(path.dirname(engineFile), { recursive: true });
  });

  function writeMarker(fields) {
    writeFileSync(markerFile, JSON.stringify({ key: '0123456789abcdef', ...fields }));
  }

  it('finds nothing when there is no engine, even with a marker left over', () => {
    assert.deepEqual(installedEngine(engineFile, markerFile), { kind: 'none' });
    writeMarker({ sha256: sha256(fetched) });
    assert.deepEqual(installedEngine(engineFile, markerFile), { kind: 'none' });
  });

  it('treats an engine without a marker as a local build', () => {
    writeFileSync(engineFile, 'local build');
    assert.deepEqual(installedEngine(engineFile, markerFile), { kind: 'local' });
  });

  it('recognises the engine it fetched by its digest', () => {
    writeFileSync(engineFile, fetched);
    writeMarker({ sha256: sha256(fetched) });
    assert.deepEqual(installedEngine(engineFile, markerFile), {
      kind: 'prebuilt',
      key: '0123456789abcdef',
    });
  });

  it('treats a local build over a fetched engine as local although the marker remains', () => {
    writeFileSync(engineFile, fetched);
    writeMarker({ sha256: sha256(fetched) });
    writeFileSync(engineFile, 'rebuilt by cmake --build --preset release');
    assert.deepEqual(installedEngine(engineFile, markerFile), { kind: 'local' });
  });

  it('treats a marker without a digest, or an unreadable one, as a local build', () => {
    writeFileSync(engineFile, fetched);
    writeMarker({});
    assert.deepEqual(installedEngine(engineFile, markerFile), { kind: 'local' });
    writeFileSync(markerFile, '{ not json');
    assert.deepEqual(installedEngine(engineFile, markerFile), { kind: 'local' });
  });
});

describe('pickArtifact', () => {
  const artifact = (id, created, run, expired = false) => ({
    id,
    expired,
    created_at: created,
    workflow_run: { repository_id: 1, head_repository_id: 1, head_branch: 'main', ...run },
  });

  it('takes the newest unexpired build of main from this repository', () => {
    const picked = pickArtifact([
      artifact(1, '2026-10-01T00:00:00Z', {}),
      artifact(2, '2026-10-03T00:00:00Z', {}),
      artifact(3, '2026-10-05T00:00:00Z', {}, true),
      artifact(4, '2026-10-06T00:00:00Z', { head_branch: 'feature' }),
      // A fork's pull request from its own main branch.
      artifact(5, '2026-10-07T00:00:00Z', { head_repository_id: 2 }),
    ]);
    assert.equal(picked?.id, 2);
  });

  it('finds nothing when no build qualifies', () => {
    assert.equal(
      pickArtifact([artifact(5, '2026-10-07T00:00:00Z', { head_branch: 'x' })]),
      undefined,
    );
    assert.equal(pickArtifact([]), undefined);
  });
});

// Builds a zip archive. `streamed` entries leave the sizes out of the local
// header, as archives written to a stream (GitHub's among them) do.
function makeZip(entries) {
  const records = [];
  const directory = [];
  let offset = 0;
  for (const { name, data, deflate = false, streamed = false } of entries) {
    const fileName = Buffer.from(name);
    const body = deflate ? deflateRawSync(data) : data;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(streamed ? 0x08 : 0, 6);
    local.writeUInt16LE(deflate ? 8 : 0, 8);
    local.writeUInt32LE(streamed ? 0 : body.length, 18);
    local.writeUInt32LE(streamed ? 0 : data.length, 22);
    local.writeUInt16LE(fileName.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(streamed ? 0x08 : 0, 8);
    central.writeUInt16LE(deflate ? 8 : 0, 10);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(fileName.length, 28);
    central.writeUInt32LE(offset, 42);
    records.push(local, fileName, body);
    directory.push(central, fileName);
    offset += local.length + fileName.length + body.length;
  }
  const centralDirectory = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...records, centralDirectory, end]);
}

describe('extractZipEntry', () => {
  const binary = Buffer.from('\x7fELF'.repeat(5000));

  it('extracts stored, deflated and streamed entries', () => {
    const zip = makeZip([
      { name: 'notes.txt', data: Buffer.from('stored') },
      { name: 'gitglasses-engine', data: binary, deflate: true, streamed: true },
      { name: 'gitglasses-engine.exe', data: binary, deflate: true },
    ]);
    assert.equal(extractZipEntry(zip, 'notes.txt')?.toString(), 'stored');
    assert.deepEqual(extractZipEntry(zip, 'gitglasses-engine'), binary);
    assert.deepEqual(extractZipEntry(zip, 'gitglasses-engine.exe'), binary);
    assert.equal(extractZipEntry(zip, 'missing'), undefined);
  });

  it('rejects data that is not a zip archive', () => {
    assert.throws(() => extractZipEntry(Buffer.from('<html>not found</html>'), 'x'), /not a zip/);
  });

  it('rejects an entry whose size does not match its directory record', () => {
    const zip = makeZip([{ name: 'engine', data: binary, deflate: true }]);
    const directory = zip.length - 22 - (46 + 'engine'.length);
    zip.writeUInt32LE(binary.length + 1, directory + 24);
    assert.throws(() => extractZipEntry(zip, 'engine'), /truncated/);
  });
});
