#!/usr/bin/env node
// End-to-end harness for the wasm engine build (build preset: wasm).
//
// Creates real git fixture repos on the host (the wasm engine itself has no
// git CLI), mounts them into the Emscripten FS via NODEFS, and drives the
// JSON-RPC protocol through gg_wasm_init/gg_wasm_handle, collecting every
// outbound message from the gg_wasm_emit callback.
//
// Usage:  node engine/wasm-test/run.mjs
// No package manager or framework needed; exits non-zero on any mismatch.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const modulePath = fileURLToPath(
  new URL('../../build/wasm/engine/gitglasses-engine-wasm.mjs', import.meta.url));
if (!existsSync(modulePath)) {
  console.error(`wasm module not found: ${modulePath}\nbuild it first: cmake --preset wasm && cmake --build --preset wasm`);
  process.exit(2);
}

// ---------------------------------------------------------------- fixtures

const ALICE = { GIT_AUTHOR_NAME: 'Alice', GIT_AUTHOR_EMAIL: 'alice@example.com' };
const BOB = { GIT_AUTHOR_NAME: 'Bob', GIT_AUTHOR_EMAIL: 'bob@example.com' };

function git(cwd, args, extraEnv = {}, tick = 0) {
  const date = `@${1700000000 + 60 * tick} +0000`;
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.com',
      GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date,
      GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
      ...extraEnv,
    },
  });
}

const scratch = mkdtempSync(join(tmpdir(), 'gg-wasm-test-'));
process.on('exit', () => rmSync(scratch, { recursive: true, force: true }));

// Repo A: the flagship two-commit blame fixture plus branches/merge for the
// graph, a tag for refs, and dirty working-tree state for status.
const repoA = join(scratch, 'repoA');
git(scratch, ['init', '-q', '-b', 'main', 'repoA']);
writeFileSync(join(repoA, 'app.txt'), 'one\ntwo\n');
writeFileSync(join(repoA, 'lib.txt'), 'lib v1\n');
git(repoA, ['add', 'app.txt', 'lib.txt']);
git(repoA, ['commit', '-q', '-m', 'add app'], ALICE, 1);
const commit1 = git(repoA, ['rev-parse', 'HEAD']).trim();
writeFileSync(join(repoA, 'app.txt'), 'one\ntwo\nthree\n');
git(repoA, ['add', 'app.txt']);
git(repoA, ['commit', '-q', '-m', 'extend app'], BOB, 2);
const commit2 = git(repoA, ['rev-parse', 'HEAD']).trim();
git(repoA, ['checkout', '-q', '-b', 'side', commit1]);
writeFileSync(join(repoA, 'side.txt'), 'branch work\n');
git(repoA, ['add', 'side.txt']);
git(repoA, ['commit', '-q', '-m', 'side work'], ALICE, 3);
git(repoA, ['checkout', '-q', 'main']);
git(repoA, ['merge', '-q', '--no-ff', '-m', 'merge side', 'side'], ALICE, 4);
const mergeSha = git(repoA, ['rev-parse', 'HEAD']).trim();
git(repoA, ['tag', 'v1']);
const revList = git(repoA, ['rev-list', '--topo-order', 'HEAD']).trim().split('\n');
// Dirty state: one unstaged modification, one untracked file.
writeFileSync(join(repoA, 'lib.txt'), 'lib v2\n');
writeFileSync(join(repoA, 'untracked.txt'), 'loose\n');

// Repo B: independent second repository (multi-repo state).
const repoB = join(scratch, 'repoB');
git(scratch, ['init', '-q', '-b', 'main', 'repoB']);
writeFileSync(join(repoB, 'other.txt'), 'entirely separate\n');
git(repoB, ['add', 'other.txt']);
git(repoB, ['commit', '-q', '-m', 'repo B initial'], BOB, 5);
const repoBHead = git(repoB, ['rev-parse', 'HEAD']).trim();
// Pack all of repo B's objects so wasm reads go through a packfile (mmap
// territory in libgit2), not just loose objects.
git(repoB, ['repack', '-adq']);

// ------------------------------------------------------------- wasm engine

const factory = (await import(modulePath)).default;
const messages = [];
const Module = await factory({
  printErr: (line) => process.stderr.write(`[wasm] ${line}\n`),
});
Module.gg_wasm_emit = (json) => messages.push(JSON.parse(json));

Module.FS.mkdir('/repo');
Module.FS.mount(Module.FS.filesystems.NODEFS, { root: repoA }, '/repo');
Module.FS.mkdir('/repo2');
Module.FS.mount(Module.FS.filesystems.NODEFS, { root: repoB }, '/repo2');

Module.ccall('gg_wasm_init', null, [], []);

let nextId = 1;
function rpc(method, params) {
  const id = nextId++;
  Module.ccall('gg_wasm_handle', null, ['string'],
               [JSON.stringify({ jsonrpc: '2.0', id, method, params })]);
  const response = messages.find((m) => m.id === id);
  if (!response) throw new Error(`no response for ${method} (id ${id})`);
  return response;
}
function notify(method, params) {
  Module.ccall('gg_wasm_handle', null, ['string'],
               [JSON.stringify({ jsonrpc: '2.0', method, params })]);
}
function result(method, params) {
  const response = rpc(method, params);
  if (response.error) {
    throw new Error(`${method} failed: ${JSON.stringify(response.error)}`);
  }
  return response.result;
}
function notifications(method) {
  return messages.filter((m) => m.id === undefined && m.method === method);
}

// -------------------------------------------------------------- assertions

import { strict as assert } from 'node:assert';

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${name}\n${error.message}\n`);
  }
}

const UNCOMMITTED = '0'.repeat(40);
let repoId;
let repoId2;

check('initialize reports wasm capabilities', () => {
  const init = result('initialize', { protocolVersion: '0.1.0' });
  assert.equal(init.protocolVersion, '0.1.0');
  // watchBackend names the mechanism behind repo/didChange; the wasm build
  // has no watcher at all.
  assert.deepEqual(init.capabilities, {
    gitCli: false,
    watch: false,
    watchBackend: 'none',
    threads: false,
  });
});

check('repo/discover finds /repo', () => {
  const discovered = result('repo/discover', { path: '/repo' });
  repoId = discovered.repoId;
  assert.ok(repoId, `no repoId in ${JSON.stringify(discovered)}`);
  assert.equal(discovered.bare, false);
});

check('repo/state resolves HEAD', () => {
  const state = result('repo/state', { repoId });
  assert.equal(state.head.oid, mergeSha);
  assert.equal(state.head.branch, 'main');
  assert.equal(state.head.detached, false);
});

check('status/summary splits unstaged and untracked', () => {
  const summary = result('status/summary', { repoId });
  assert.equal(summary.branch, 'main');
  assert.deepEqual(summary.staged, []);
  assert.deepEqual(summary.unstaged.map((c) => [c.path, c.status]), [['lib.txt', 'M']]);
  assert.deepEqual(summary.untracked, ['untracked.txt']);
});

check('blame/file attributes both commits (libgit2 blame in wasm)', () => {
  const blame = result('blame/file', { repoId, path: 'app.txt', streamId: 'w1' });
  assert.equal(blame.totalLines, 3);
  assert.deepEqual(Object.keys(blame.commits).sort(), [commit1, commit2].sort());
  assert.equal(blame.commits[commit1].author.name, 'Alice');
  assert.equal(blame.commits[commit2].author.name, 'Bob');
  const hunks = notifications('blame/hunks')
    .filter((n) => n.params.streamId === 'w1')
    .flatMap((n) => n.params.hunks);
  assert.ok(hunks.length >= 2, `expected streamed hunks, got ${JSON.stringify(hunks)}`);
  const lineSha = new Array(3);
  for (const hunk of hunks) {
    for (let i = 0; i < hunk.lineCount; i += 1) lineSha[hunk.resultLine - 1 + i] = hunk.sha;
  }
  assert.deepEqual(lineSha, [commit1, commit1, commit2]);
});

check('log/commits matches rev-list order', () => {
  const log = result('log/commits', { repoId, limit: 100 });
  assert.deepEqual(log.commits.map((c) => c.sha), revList);
  const merge = log.commits.find((c) => c.sha === mergeSha);
  assert.equal(merge.parents.length, 2);
});

check('graph/rows lays out two lanes', () => {
  const graph = result('graph/rows',
                       { repoId, limit: 100, include: { stashes: false, wip: false } });
  assert.equal(graph.rows.length, revList.length);
  assert.deepEqual(graph.rows.map((r) => r.sha), revList);
  for (const row of graph.rows) {
    assert.ok(Number.isInteger(row.lane) && row.lane >= 0, `bad lane in ${JSON.stringify(row)}`);
  }
  assert.equal(graph.rows[0].lane, 0);  // merge commit on the main lane
  assert.ok(graph.rows.some((r) => r.lane > 0), 'expected a second lane for the side branch');
});

check('refs/list reports branches and tags', () => {
  const refs = result('refs/list', { repoId });
  const branchNames = refs.branches.map((b) => b.name).sort();
  assert.deepEqual(branchNames, ['main', 'side']);
  assert.deepEqual(refs.tags.map((t) => t.name), ['v1']);
});

check('rev/fileAtRev returns historical contents', () => {
  const atFirst = result('rev/fileAtRev', { repoId, path: 'app.txt', rev: commit1 });
  assert.equal(atFirst.contents, 'one\ntwo\n');
  const atHead = result('rev/fileAtRev', { repoId, path: 'app.txt', rev: 'HEAD' });
  assert.equal(atHead.contents, 'one\ntwo\nthree\n');
});

check('diff/commit reports the extend-app change', () => {
  const diff = result('diff/commit', { repoId, sha: commit2 });
  assert.deepEqual(diff.files,
                   [{ path: 'app.txt', status: 'M', additions: 1, deletions: 0 }]);
});

check('search/commits streams matches', () => {
  const search = result('search/commits',
                        { repoId, streamId: 'q1', limit: 50, query: { text: 'extend' } });
  assert.equal(search.total, 1);
  assert.equal(search.truncated, false);
  const shas = notifications('search/matches')
    .filter((n) => n.params.streamId === 'q1')
    .flatMap((n) => n.params.matches.map((m) => m.sha));
  assert.deepEqual(shas, [commit2]);
});

check('doc/didChange overlay attributes the dirty line as uncommitted', () => {
  notify('doc/didChange', {
    repoId, path: 'app.txt', contents: 'one\ntwo\nthree\nunsaved\n', version: 1,
  });
  const blame = result('blame/file', { repoId, path: 'app.txt', streamId: 'w2' });
  assert.equal(blame.totalLines, 4);
  assert.ok(blame.commits[UNCOMMITTED], 'no uncommitted pseudo-commit in overlay blame');
  const hunks = notifications('blame/hunks')
    .filter((n) => n.params.streamId === 'w2')
    .flatMap((n) => n.params.hunks);
  const last = hunks.find((h) => h.resultLine <= 4 && 4 < h.resultLine + h.lineCount);
  assert.equal(last.sha, UNCOMMITTED);
  notify('doc/didClose', { repoId, path: 'app.txt' });
});

check('mutate/commit is rejected without a git CLI', () => {
  const response = rpc('mutate/commit', { repoId, message: 'nope' });
  assert.ok(response.error, `expected error, got ${JSON.stringify(response)}`);
  assert.equal(response.error.code, -32003);
});

check('second repo works independently (multi-repo state)', () => {
  const discovered = result('repo/discover', { path: '/repo2' });
  repoId2 = discovered.repoId;
  assert.ok(repoId2 && repoId2 !== repoId);
  const state = result('repo/state', { repoId: repoId2 });
  assert.equal(state.head.oid, repoBHead);
  const log = result('log/commits', { repoId: repoId2, limit: 10 });
  assert.deepEqual(log.commits.map((c) => c.sha), [repoBHead]);
  // Repo B is fully packed: blame reading from a packfile must work too.
  const blame = result('blame/file', { repoId: repoId2, path: 'other.txt', streamId: 'w3' });
  assert.equal(blame.totalLines, 1);
  assert.deepEqual(Object.keys(blame.commits), [repoBHead]);
  const list = result('repo/list', {});
  assert.deepEqual(list.repos.map((r) => r.repoId).sort(),
                   [repoId, repoId2].sort());
  // Repo A answers unchanged after B was added.
  const stateA = result('repo/state', { repoId });
  assert.equal(stateA.head.oid, mergeSha);
});

check('shutdown succeeds', () => {
  result('shutdown', {});
});

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall wasm harness checks passed');
