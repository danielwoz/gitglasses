// Commit search against the real engine: message, author and date criteria
// answer the same in a trusted folder (git log) and in Restricted Mode, where
// no git runs and the date window is applied to the libgit2 search's
// matches; code and file criteria are refused there.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CommitSummaryInfo, ErrorCodes } from '@gitglasses/protocol';
import { EngineClient, EngineError } from '@gitglasses/rpc';
import { createProcessTransportFactory } from '@gitglasses/rpc/node';
import { DATE_SCAN_LIMIT, isGitRefusal, searchCommitHistory } from '../src/views/commitSearch';
import type { CommitSearchQuery } from '../src/views/searchQuery';

const repoRoot = path.resolve(__dirname, '..', '..');
const engineExe = process.platform === 'win32' ? 'gitglasses-engine.exe' : 'gitglasses-engine';
const enginePath = ['release', 'debug']
  .map((p) => path.join(repoRoot, 'build', p, 'engine', engineExe))
  .find(existsSync);

if (!enginePath) {
  throw new Error('engine binary not built; run: cmake --build --preset debug');
}

// Commits at noon UTC, so a local-time day boundary is never within reach.
const COMMITS = [
  { subject: 'fix login crash', author: 'Alice', date: '2025-01-10T12:00:00Z' },
  { subject: 'add login form', author: 'Bob', date: '2025-02-10T12:00:00Z' },
  { subject: 'fix login crash again', author: 'Alice', date: '2025-03-10T12:00:00Z' },
  { subject: 'tidy docs', author: 'Alice', date: '2025-03-20T12:00:00Z' },
];

function makeRepo(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'gg-commit-search-'));
  const git = (args: string[], env: Record<string, string> = {}): string =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8', env: { ...process.env, ...env } });
  git(['init', '-q', '-b', 'main']);
  git(['config', 'commit.gpgsign', 'false']);
  COMMITS.forEach((commit, index) => {
    writeFileSync(path.join(root, `file${index}.txt`), `${commit.subject}\n`);
    git(['add', '-A']);
    const email = `${commit.author.toLowerCase()}@example.invalid`;
    git(['commit', '-q', '-m', commit.subject], {
      GIT_AUTHOR_NAME: commit.author,
      GIT_AUTHOR_EMAIL: email,
      GIT_AUTHOR_DATE: commit.date,
      GIT_COMMITTER_NAME: commit.author,
      GIT_COMMITTER_EMAIL: email,
      GIT_COMMITTER_DATE: commit.date,
    });
  });
  return root;
}

let root: string;
const engines: { trusted?: EngineClient; restricted?: EngineClient } = {};

beforeAll(async () => {
  root = makeRepo();
  engines.trusted = new EngineClient(createProcessTransportFactory({ enginePath: enginePath! }));
  engines.restricted = new EngineClient(
    createProcessTransportFactory({ enginePath: enginePath!, restricted: true }),
  );
  await engines.trusted.start();
  await engines.restricted.start();
});

afterAll(() => {
  engines.trusted?.dispose();
  engines.restricted?.dispose();
  rmSync(root, { recursive: true, force: true });
});

let streams = 0;
async function search(engine: EngineClient, query: CommitSearchQuery, limit = 50) {
  const { repoId } = await engine.request('repo/discover', { path: root });
  const found: CommitSummaryInfo[] = [];
  const outcome = await searchCommitHistory(
    engine,
    { repoId, streamId: `test-${streams++}`, limit, query },
    (matches) => found.push(...matches),
  );
  return { subjects: found.map((commit) => commit.summary), ...outcome };
}

describe('commit search by date', () => {
  const query = { text: 'login', since: '2025-02-01', until: '2025-03-15' };

  it('finds the same commits in a trusted folder and in Restricted Mode', async () => {
    const trusted = await search(engines.trusted!, query);
    expect(trusted.subjects).toEqual(['fix login crash again', 'add login form']);
    const restricted = await search(engines.restricted!, query);
    expect(restricted).toEqual(trusted);
    expect(restricted.partial).toBe(false);
  });

  it('applies the window to author searches and stops at the limit', async () => {
    const byAlice = await search(engines.restricted!, { author: 'alice', since: '2025-03-01' });
    expect(byAlice.subjects).toEqual(['tidy docs', 'fix login crash again']);
    const first = await search(engines.restricted!, { since: '2025-01-01' }, 1);
    expect(first).toEqual({ subjects: ['tidy docs'], truncated: true, partial: false });
  });

  it('refuses code and file criteria where git may not run', async () => {
    for (const refused of [
      { content: 'login', since: '2025-01-01' },
      { path: 'file1.txt' },
    ] satisfies CommitSearchQuery[]) {
      const error = await search(engines.restricted!, refused).catch((e: unknown) => e);
      expect(isGitRefusal(error), JSON.stringify(refused)).toBe(true);
      expect((error as EngineError).code).toBe(ErrorCodes.Restricted);
    }
    expect((await search(engines.trusted!, { path: 'file1.txt' })).subjects).toEqual([
      'add login form',
    ]);
  });
});

describe('a date window applied to a long history', () => {
  it('says when older commits were not searched', async () => {
    const matches = (count: number, time: number): CommitSummaryInfo[] =>
      Array.from({ length: count }, (_, i) => ({
        sha: i.toString(16).padStart(40, '0'),
        parents: [],
        author: { name: 'a', email: 'a@x', time },
        committer: { name: 'a', email: 'a@x', time },
        summary: `commit ${i}`,
      }));
    let handler: ((params: { streamId: string; matches: CommitSummaryInfo[] }) => void) | undefined;
    const limits: number[] = [];
    const engine = {
      onNotification: (_method: string, listener: typeof handler) => {
        handler = listener;
        return { dispose: () => (handler = undefined) };
      },
      request: async (method: string, params: { streamId: string; limit: number }) => {
        if (method === 'search/log') throw new EngineError(ErrorCodes.MethodNotSupported, 'no git');
        limits.push(params.limit);
        // Every match is too new for the window, and history goes on.
        handler?.({ streamId: params.streamId, matches: matches(params.limit, 2_000_000_000) });
        return { streamId: params.streamId, total: params.limit, truncated: true };
      },
    } as unknown as EngineClient;
    const found: CommitSummaryInfo[] = [];
    const outcome = await searchCommitHistory(
      engine,
      { repoId: 'r', streamId: 's', limit: 10, query: { until: '2020-01-01' } },
      (batch) => found.push(...batch),
    );
    expect(limits).toEqual([DATE_SCAN_LIMIT]);
    expect(found).toEqual([]);
    expect(outcome).toEqual({ truncated: true, partial: true });
  });
});
