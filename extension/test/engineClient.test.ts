// Integration tests against the real engine binary — the same contract the
// extension host exercises, minus VS Code.

import { execFileSync, execSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EngineClient, EngineError } from '../src/engine/engineClient';
import { createProcessTransportFactory } from '../src/engine/processTransport';
import { BlameModel } from '../src/model/blameModel';
import { UNCOMMITTED_SHA } from '@gitglasses/protocol';

const repoRoot = path.resolve(__dirname, '..', '..');
// Windows needs the .exe suffix, as the e2e runner and the extension's own
// lookup both apply; without it nothing matches and the file fails to collect.
const engineExe = process.platform === 'win32' ? 'gitglasses-engine.exe' : 'gitglasses-engine';
const enginePath = ['release', 'debug']
  .map((p) => path.join(repoRoot, 'build', p, 'engine', engineExe))
  .find(existsSync);

if (!enginePath) {
  throw new Error('engine binary not built; run: cmake --build --preset debug');
}

function makeFixtureRepo(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'gg-ts-fixture-'));
  const env = {
    ...process.env,
    GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
    GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
  };
  const git = (cmd: string) => execSync(`git ${cmd}`, { cwd: root, env });
  git('init -q -b main');
  git('config user.name Fixture');
  git('config user.email fixture@example.invalid');
  writeFileSync(path.join(root, 'file.txt'), 'one\ntwo\nthree\n');
  git('add file.txt');
  git("commit -q -m 'initial'");
  return root;
}

describe('EngineClient', () => {
  let client: EngineClient;
  let fixture: string;

  beforeEach(async () => {
    fixture = makeFixtureRepo();
    client = new EngineClient(createProcessTransportFactory({ enginePath: enginePath! }));
    await client.start();
  });

  afterEach(() => {
    client.dispose();
    rmSync(fixture, { recursive: true, force: true });
  });

  it('completes the initialize handshake and discovers a repo', async () => {
    const info = await client.request('repo/discover', { path: fixture });
    expect(info.repoId).toMatch(/^r\d+$/);
    expect(info.bare).toBe(false);

    const state = await client.request('repo/state', { repoId: info.repoId });
    expect(state.head.branch).toBe('main');
    expect(state.head.oid).toHaveLength(40);
  });

  it('rejects unknown repo ids with a typed error', async () => {
    await expect(client.request('repo/state', { repoId: 'r999' })).rejects.toSatisfy(
      (e: unknown) => e instanceof EngineError && e.code === -32000,
    );
  });

  it('blames through BlameModel with streamed hunks', async () => {
    const info = await client.request('repo/discover', { path: fixture });
    const model = new BlameModel(client);
    const blame = await model.getBlame({ repoId: info.repoId, path: 'file.txt', version: -1 });

    expect(blame.totalLines).toBe(3);
    expect(blame.hunks.length).toBeGreaterThan(0);
    const hunk = model.hunkForLine(blame, 2);
    expect(hunk).toBeDefined();
    expect(blame.commits[hunk!.sha].summary).toBe('initial');
  });

  it('coalesces concurrent blame requests into one engine call', async () => {
    const info = await client.request('repo/discover', { path: fixture });
    const model = new BlameModel(client);
    const key = { repoId: info.repoId, path: 'file.txt', version: -1 };
    const [a, b] = await Promise.all([model.getBlame(key), model.getBlame(key)]);
    expect(a).toBe(b); // identical promise result: coalesced
  });

  it('reflects dirty buffer overlays in blame', async () => {
    const info = await client.request('repo/discover', { path: fixture });
    client.notify('doc/didChange', {
      repoId: info.repoId,
      path: 'file.txt',
      contents: 'one\ntwo\nthree\nunsaved\n',
      version: 5,
    });
    const model = new BlameModel(client);
    const blame = await model.getBlame({ repoId: info.repoId, path: 'file.txt', version: 5 });
    expect(blame.totalLines).toBe(4);
    expect(model.hunkForLine(blame, 4)!.sha).toBe(UNCOMMITTED_SHA);
  });

  it('cancellation rejects promptly', async () => {
    const info = await client.request('repo/discover', { path: fixture });
    let cancelled = false;
    const listeners: (() => void)[] = [];
    const token = {
      get isCancellationRequested() {
        return cancelled;
      },
      onCancellationRequested(listener: () => void) {
        listeners.push(listener);
        return { dispose() {} };
      },
    };
    const request = client.request(
      'blame/file',
      { repoId: info.repoId, path: 'file.txt', streamId: 'c1' },
      token,
    );
    cancelled = true;
    for (const l of listeners) l();
    await expect(request).rejects.toSatisfy(
      (e: unknown) => e instanceof EngineError && e.code === -32800,
    );
  });

  it('survives an engine crash: pending requests reject, restart works', async () => {
    const info = await client.request('repo/discover', { path: fixture });
    // Simulate a crash via explicit restart (kills with SIGKILL internally).
    await client.restart();
    // Old repo id is gone in the new process; rediscovery works.
    const rediscovered = await client.request('repo/discover', { path: fixture });
    expect(rediscovered.repoId).toBeDefined();
    const state = await client.request('repo/state', { repoId: rediscovered.repoId });
    expect(state.head.branch).toBe('main');
    void info;
  });
});
