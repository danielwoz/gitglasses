// git_log_search's code-change, path and date filters, against the real
// engine: git log -S/-G answers them, so they need an allow-listed repository.

import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EngineClient } from '@gitglasses/rpc';
import { createEngineClient, resolveEnginePath } from '../src/engine.js';
import { createToolHandlers, type ToolHandlers } from '../src/server.js';

const enginePath = resolveEnginePath({ packageRoot: path.resolve(import.meta.dirname, '..') });

function git(cwd: string, env: Record<string, string>, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...env } });
}

describe.skipIf(!enginePath)('git_log_search content, path and date filters', () => {
  let repoDir: string;
  let full: EngineClient;
  let restricted: EngineClient;
  let trusted: ToolHandlers;
  let readOnly: ToolHandlers;

  const commitOn = (date: string, message: string): void => {
    git(repoDir, { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }, 'add', '-A');
    git(repoDir, { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }, 'commit', '-m', message);
  };

  beforeAll(async () => {
    repoDir = await mkdtemp(path.join(os.tmpdir(), 'gitglasses-mcp-logsearch-'));
    git(repoDir, {}, 'init', '-b', 'main');
    git(repoDir, {}, 'config', 'user.name', 'Test Author');
    git(repoDir, {}, 'config', 'user.email', 'test@example.com');
    git(repoDir, {}, 'config', 'core.autocrlf', 'false');
    git(repoDir, {}, 'config', 'commit.gpgsign', 'false');
    await writeFile(path.join(repoDir, 'README.md'), 'readme\n');
    commitOn('2024-01-01T12:00:00Z', 'Initial commit');
    await writeFile(path.join(repoDir, 'parser.ts'), 'export function parseWidget() {}\n');
    commitOn('2024-02-01T12:00:00Z', 'Add the widget parser');
    await writeFile(path.join(repoDir, 'docs.md'), 'Call parseWidget() to parse.\n');
    commitOn('2024-03-01T12:00:00Z', 'Document parsing');
    await writeFile(path.join(repoDir, 'parser.ts'), 'export function parseGadget() {}\n');
    commitOn('2024-04-01T12:00:00Z', 'Rename the parser');

    full = createEngineClient({ enginePath });
    restricted = createEngineClient({ enginePath, restricted: true });
    trusted = createToolHandlers({ client: full, allow: [repoDir], env: {} });
    readOnly = createToolHandlers({
      client: full,
      restrictedClient: restricted,
      clientRoots: async () => [repoDir],
      env: {},
    });
  }, 30000);

  afterAll(async () => {
    full?.dispose();
    restricted?.dispose();
    if (repoDir) await rm(repoDir, { recursive: true, force: true });
  });

  const summaries = (text: string): string[] =>
    text.split('\n').map((line) => line.replace(/^[0-9a-f]{7} Test Author \S+ /, ''));

  it('finds the commits that added and removed a string', async () => {
    const text = await trusted.git_log_search({
      repoPath: repoDir,
      content: 'parseWidget',
      limit: 20,
    });
    expect(summaries(text)).toEqual([
      'Rename the parser',
      'Document parsing',
      'Add the widget parser',
    ]);
  });

  it('matches a regular expression against changed lines with regex', async () => {
    const text = await trusted.git_log_search({
      repoPath: repoDir,
      content: 'parse(Gadget|Nothing)\\(',
      regex: true,
      limit: 20,
    });
    expect(summaries(text)).toEqual(['Rename the parser']);
  });

  it('narrows by path and by commit date, combined with AND', async () => {
    expect(
      summaries(
        await trusted.git_log_search({
          repoPath: repoDir,
          content: 'parseWidget',
          path: 'parser.ts',
          limit: 20,
        }),
      ),
    ).toEqual(['Rename the parser', 'Add the widget parser']);
    expect(
      summaries(
        await trusted.git_log_search({
          repoPath: repoDir,
          since: '2024-02-15',
          until: '2024-03-15',
          limit: 20,
        }),
      ),
    ).toEqual(['Document parsing']);
    expect(
      summaries(
        await trusted.git_log_search({
          repoPath: repoDir,
          path: 'docs.md',
          text: 'doc',
          limit: 20,
        }),
      ),
    ).toEqual(['Document parsing']);
  });

  it('says when more matches exist than it returned', async () => {
    const text = await trusted.git_log_search({ repoPath: repoDir, content: 'parse', limit: 1 });
    expect(text).toMatch(/\(showing the first 1 matches; more exist/);
  });

  it('refuses combinations it cannot answer, saying what to do instead', async () => {
    await expect(
      trusted.git_log_search({ repoPath: repoDir, content: 'x', sha: 'abc', limit: 5 }),
    ).rejects.toThrow(/sha cannot be combined .* git_commit_show/);
    await expect(
      trusted.git_log_search({ repoPath: repoDir, regex: true, limit: 5 }),
    ).rejects.toThrow(/regex applies to "content"/);
  });

  it('explains that a code search needs an allowed repository, while message search still works', async () => {
    await expect(
      readOnly.git_log_search({ repoPath: repoDir, content: 'parseWidget', limit: 5 }),
    ).rejects.toThrow(/git_log_search needs git for searching code changes, paths and dates/);
    expect(
      await readOnly.git_log_search({ repoPath: repoDir, text: 'parser', limit: 5 }),
    ).toContain('Add the widget parser');
  });
});
