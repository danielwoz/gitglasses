// Suggest Change against the real engine: the head check reads the file at
// the pull request head through rev/fileAtRev, and the fallback patch built
// from that content must be one patch/apply accepts. Local edits and
// untracked files never reach the patch.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EngineClient } from '@gitglasses/rpc';
import { createProcessTransportFactory } from '@gitglasses/rpc/node';
import { parseEnvelope, envelopeToJson } from '../src/patches/patchLogic';
import {
  buildSuggestionEnvelope,
  buildSuggestionPatch,
  firstMismatchedLine,
} from '../src/reviews/suggestLogic';

const repoRoot = path.resolve(__dirname, '..', '..');
const engineExe = process.platform === 'win32' ? 'gitglasses-engine.exe' : 'gitglasses-engine';
const enginePath = ['release', 'debug']
  .map((p) => path.join(repoRoot, 'build', p, 'engine', engineExe))
  .find(existsSync);

if (!enginePath) {
  throw new Error('engine binary not built; run: cmake --build --preset debug');
}

const BASE = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

/** A repository with BASE committed at src/app.txt, the "pull request head". */
function makeRepo(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'gg-suggest-engine-'));
  git(root, 'init', '-q', '-b', 'feature');
  git(root, 'config', 'core.autocrlf', 'false');
  git(root, 'config', 'commit.gpgsign', 'false');
  git(root, 'config', 'user.name', 'Fixture');
  git(root, 'config', 'user.email', 'fixture@example.invalid');
  mkdirSync(path.join(root, 'src'));
  writeFileSync(path.join(root, 'src', 'app.txt'), BASE);
  writeFileSync(path.join(root, 'other.txt'), 'unrelated\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'head');
  return root;
}

describe('suggestion against the pull request head', () => {
  let client: EngineClient;
  const repos: string[] = [];

  beforeEach(async () => {
    client = new EngineClient(createProcessTransportFactory({ enginePath: enginePath! }));
    await client.start();
  });

  afterEach(() => {
    client.dispose();
    for (const dir of repos.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('refuses a selection that saved but uncommitted edits have shifted', async () => {
    const root = makeRepo();
    repos.push(root);
    const { repoId } = await client.request('repo/discover', { path: root });
    const { head } = await client.request('repo/state', { repoId });
    const atHead = await client.request('rev/fileAtRev', {
      repoId,
      path: 'src/app.txt',
      rev: head.oid,
    });

    // A line added above the selection and saved: the buffer is clean, the
    // file differs from the head.
    const local = BASE.replace('line 2\n', 'line 2\nadded locally\n');
    expect(firstMismatchedLine(local, atHead.contents, 8)).toBe(3);
    expect(firstMismatchedLine(BASE, atHead.contents, 8)).toBeUndefined();
  });

  it('shares a patch of only the suggested lines, which patch/apply applies', async () => {
    const root = makeRepo();
    repos.push(root);
    const { repoId } = await client.request('repo/discover', { path: root });
    const { head } = await client.request('repo/state', { repoId });
    // Unrelated work in progress, including an untracked secret.
    writeFileSync(path.join(root, 'other.txt'), 'unrelated edit\n');
    writeFileSync(path.join(root, 'scratch-notes.txt'), 'API_KEY=sk-test-123\n');

    const atHead = await client.request('rev/fileAtRev', {
      repoId,
      path: 'src/app.txt',
      rev: head.oid,
    });
    const patch = buildSuggestionPatch({
      path: 'src/app.txt',
      headText: atHead.contents,
      startLine: 6,
      endLine: 7,
      replacement: 'six\nseven\n',
    });
    const envelope = buildSuggestionEnvelope({
      headSha: head.oid,
      headRef: 'feature',
      summary: 'Suggestion for src/app.txt (PR #1)',
      patch: patch!,
      createdAtIso: '2026-01-01T00:00:00.000Z',
    });
    const json = envelopeToJson(envelope!);
    expect(json).not.toContain('other.txt');
    expect(json).not.toContain('scratch-notes');
    expect(json).not.toContain('API_KEY');

    // The pull request author applies it in their own checkout of the head.
    const recipient = mkdtempSync(path.join(tmpdir(), 'gg-suggest-recipient-'));
    repos.push(recipient);
    // Checked out without line-ending conversion, as the pull request head
    // stores the file: a CRLF working tree would not take an LF patch.
    git(recipient, 'clone', '-q', '-c', 'core.autocrlf=false', root, '.');
    const parsed = parseEnvelope(json);
    expect(parsed.ok).toBe(true);
    const target = await client.request('repo/discover', { path: recipient });
    const result = await client.request('patch/apply', {
      repoId: target.repoId,
      envelope: parsed.ok ? parsed.envelope : envelope!,
    });
    expect(result).toMatchObject({ applied: true, conflicts: false, baseFound: true });
    expect(readFileSync(path.join(recipient, 'src', 'app.txt'), 'utf8')).toBe(
      BASE.replace('line 6\nline 7\n', 'six\nseven\n'),
    );
    // The suggested file is the only change it brings (--3way stages it).
    expect(git(recipient, 'status', '--porcelain')).toBe('M  src/app.txt\n');
  });
});
