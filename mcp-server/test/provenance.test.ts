// git_provenance: the formatter's wording (declared, quoted, never inferred)
// and the tool against a real engine and repository, in Restricted Mode too.

import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CommitProvenance } from '@gitglasses/protocol';
import type { EngineClient } from '@gitglasses/rpc';
import { createEngineClient, resolveEnginePath } from '../src/engine.js';
import { createToolHandlers, type ToolHandlers } from '../src/server.js';
import { formatProvenance, type ProvenanceReport } from '../src/tools/provenance.js';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const ZERO = '0'.repeat(40);

function report(overrides: Partial<ProvenanceReport> = {}): ProvenanceReport {
  const commit = (summary: string) => ({
    author: { name: 'Jane', email: 'jane@example.com', time: 1767225600 },
    committer: { name: 'Jane', email: 'jane@example.com', time: 1767225600 },
    summary,
    boundary: false,
  });
  const declared: CommitProvenance = {
    declared: 'agent',
    declarations: [
      {
        source: 'trailer',
        kind: 'agent',
        name: 'Claude',
        model: 'Opus 4.7',
        via: 'Co-authored-by',
        value: 'Claude Opus 4.7 <noreply@anthropic.com>',
        url: 'https://example.com/s/1',
      },
    ],
  };
  return {
    file: 'src/a.ts',
    startLine: 1,
    totalLines: 9,
    hunks: [
      { sha: A, resultLine: 1, originalLine: 1, lineCount: 3, path: 'src/a.ts' },
      { sha: B, resultLine: 4, originalLine: 4, lineCount: 4, path: 'src/a.ts' },
      { sha: A, resultLine: 8, originalLine: 8, lineCount: 1, path: 'src/a.ts' },
      { sha: ZERO, resultLine: 9, originalLine: 9, lineCount: 1, path: 'src/a.ts' },
    ],
    truncated: false,
    commits: { [A]: commit('Teach the "parser"'), [B]: commit('Initial') },
    provenance: {
      [A]: declared,
      [B]: {
        declared: 'unknown',
        declarations: [],
        note: { read: false, ref: 'refs/notes/ai', schemaVersion: 'authorship/4.0.0' },
      },
    },
    ...overrides,
  };
}

describe('formatProvenance', () => {
  it('reports each hunk and each commit once, quoting what the repository wrote', () => {
    expect(formatProvenance(report())).toBe(
      [
        'provenance src/a.ts L1-9: what each commit declares (git-ai notes in refs/notes/ai ' +
          "or a remote's copy, trailers such as Co-authored-by, known agent identities). " +
          'Nothing is inferred from the code; "unknown" means the commit declares nothing.',
        '',
        'hunks:',
        'L1-3 aaaaaaa agent (trailer)',
        'L4-7 bbbbbbb unknown',
        'L8 aaaaaaa agent (trailer)',
        'L9 uncommitted',
        '',
        'commits:',
        'aaaaaaa Jane 2026-01-01 "Teach the \\"parser\\""',
        '  - agent "Claude" model "Opus 4.7" via trailer Co-authored-by: ' +
          '"Claude Opus 4.7 <noreply@anthropic.com>"; session link https://example.com/s/1 (not fetched)',
        'bbbbbbb Jane 2026-01-01 "Initial"',
        '  declares nothing',
        '  a git-ai note is attached in refs/notes/ai but not read (schema "authorship/4.0.0")',
      ].join('\n'),
    );
  });

  it('names the git-ai session a note declares, and the next page', () => {
    const text = formatProvenance(
      report({
        endLine: 3,
        truncated: true,
        hunks: [{ sha: A, resultLine: 1, originalLine: 1, lineCount: 3, path: 'src/a.ts' }],
        provenance: {
          [A]: {
            declared: 'agent',
            declarations: [
              {
                source: 'notes',
                kind: 'agent',
                name: 'Cursor',
                model: 'gpt-5',
                via: 'refs/notes/ai',
                value: '6ef2299e',
              },
            ],
            note: { read: true, ref: 'refs/notes/ai', schemaVersion: 'authorship/3.0.0' },
          },
        },
      }),
    );
    expect(text).toContain('provenance src/a.ts L1-3:');
    expect(text).toContain('L1-3 aaaaaaa agent (notes)');
    expect(text).toContain(
      '  - agent "Cursor" model "gpt-5" via git-ai note in refs/notes/ai (session "6ef2299e")',
    );
    expect(text).toContain('(showing the first 1 hunks; pass startLine: 4 for the rest)');
  });

  it('labels a known human in a note by identity, not as a session', () => {
    const text = formatProvenance(
      report({
        hunks: [{ sha: A, resultLine: 1, originalLine: 1, lineCount: 3, path: 'src/a.ts' }],
        provenance: {
          [A]: {
            declared: 'human',
            declarations: [
              {
                source: 'notes',
                kind: 'human',
                name: 'Jane <jane@example.com>',
                via: 'refs/notes/ai-remote/origin',
                value: 'Jane <jane@example.com>',
              },
            ],
            note: { read: true, ref: 'refs/notes/ai-remote/origin' },
          },
        },
      }),
    );
    expect(text.split('\n')).toContain(
      '  - human "Jane <jane@example.com>" via git-ai note in refs/notes/ai-remote/origin',
    );
    expect(text).not.toContain('session');
  });

  it('says when no hunk covers the range', () => {
    expect(formatProvenance(report({ hunks: [] }))).toMatch(/No blame hunks cover this range\.$/);
  });
});

const enginePath = resolveEnginePath({ packageRoot: path.resolve(import.meta.dirname, '..') });

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

describe.skipIf(!enginePath)('git_provenance against the engine', () => {
  let repoDir: string;
  let client: EngineClient;
  let restricted: EngineClient;
  let handlers: ToolHandlers;

  beforeAll(async () => {
    repoDir = await mkdtemp(path.join(os.tmpdir(), 'gitglasses-mcp-provenance-'));
    git(repoDir, 'init', '-q', '-b', 'main');
    git(repoDir, 'config', 'user.name', 'Test Author');
    git(repoDir, 'config', 'user.email', 'test@example.com');
    git(repoDir, 'config', 'core.autocrlf', 'false');
    await writeFile(path.join(repoDir, 'a.txt'), 'one\ntwo\n');
    git(repoDir, 'add', '.');
    git(repoDir, 'commit', '-q', '-m', 'Initial commit');
    await writeFile(path.join(repoDir, 'a.txt'), 'one\ntwo\nthree\nfour\n');
    git(
      repoDir,
      'commit',
      '-q',
      '-am',
      'Add lines',
      '-m',
      'Co-authored-by: Cursor <cursoragent@cursor.com>',
    );
    client = createEngineClient({ enginePath });
    restricted = createEngineClient({ enginePath, restricted: true });
    handlers = createToolHandlers({ client, allow: [repoDir], env: {} });
  }, 30000);

  afterAll(async () => {
    client?.dispose();
    restricted?.dispose();
    if (repoDir) await rm(repoDir, { recursive: true, force: true });
  });

  it('reports the declared co-author of the lines an agent helped write', async () => {
    const text = await handlers.git_provenance({ repoPath: repoDir, file: 'a.txt' });
    expect(text).toMatch(/^L1-2 [0-9a-f]{7} unknown$/m);
    expect(text).toMatch(/^L3-4 [0-9a-f]{7} agent \(trailer\)$/m);
    expect(text).toContain(
      '  - agent "Cursor" via trailer Co-authored-by: "Cursor <cursoragent@cursor.com>"',
    );
    const range = await handlers.git_provenance({
      repoPath: repoDir,
      file: 'a.txt',
      startLine: 3,
      endLine: 3,
    });
    expect(range).toContain('provenance a.txt L3-3:');
    expect(range).not.toMatch(/^L1-2/m);
  });

  it('refuses a range that ends before it starts', async () => {
    await expect(
      handlers.git_provenance({ repoPath: repoDir, file: 'a.txt', startLine: 3, endLine: 2 }),
    ).rejects.toThrow('endLine (2) is before startLine (3)');
  });

  it('works where git may not run', async () => {
    const workspace = createToolHandlers({
      client,
      restrictedClient: restricted,
      clientRoots: async () => [repoDir],
      env: {},
    });
    const text = await workspace.git_provenance({ repoPath: repoDir, file: 'a.txt' });
    expect(text).toMatch(/^L3-4 [0-9a-f]{7} agent \(trailer\)$/m);
  });
});
