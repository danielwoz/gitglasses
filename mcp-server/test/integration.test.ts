// Integration tests against the real gitglasses-engine binary and the built
// CLI. Both suites skip with a console note when their prerequisite is absent.

import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EngineClient } from '@gitglasses/rpc';
import { createEngineClient, resolveEnginePath } from '../src/engine.js';
import { createToolHandlers, type ToolHandlers } from '../src/server.js';

const packageRoot = path.resolve(import.meta.dirname, '..');
const enginePath = resolveEnginePath({ packageRoot });
const cliPath = path.join(packageRoot, 'dist', 'cli.js');

if (!enginePath) {
  console.log('gitglasses-engine binary not found; skipping engine integration tests');
}
if (!existsSync(cliPath)) {
  console.log('dist/cli.js not built; skipping MCP stdio smoke test (run build first)');
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

describe.skipIf(!enginePath)('engine integration', () => {
  let repoDir: string;
  let client: EngineClient;
  let handlers: ToolHandlers;

  beforeAll(async () => {
    repoDir = await mkdtemp(path.join(os.tmpdir(), 'gitglasses-mcp-'));
    git(repoDir, 'init', '-b', 'main');
    git(repoDir, 'config', 'user.name', 'Test Author');
    git(repoDir, 'config', 'user.email', 'test@example.com');
    // Windows checks out CRLF by default, which these tests do not test for.
    git(repoDir, 'config', 'core.autocrlf', 'false');
    await writeFile(path.join(repoDir, 'hello.txt'), 'one\ntwo\nthree\n');
    git(repoDir, 'add', '.');
    git(repoDir, 'commit', '-m', 'Initial commit');
    await writeFile(path.join(repoDir, 'untracked.txt'), 'later\n');

    client = createEngineClient({ enginePath });
    handlers = createToolHandlers({ client, env: {} });
  }, 30000);

  afterAll(async () => {
    client?.dispose();
    if (repoDir) await rm(repoDir, { recursive: true, force: true });
  });

  it('completes the initialize handshake and discovers the fixture repo', async () => {
    await client.start();
    const info = await client.request('repo/discover', { path: repoDir });
    expect(info.repoId).toBeTruthy();
  });

  it('git_status reports the branch and the untracked file', async () => {
    const text = await handlers.git_status({ repoPath: repoDir });
    expect(text).toContain('branch: main');
    expect(text).toContain('untracked (1):');
    expect(text).toContain('untracked.txt');
  });

  it('git_blame attributes every line to the initial commit', async () => {
    const text = await handlers.git_blame({ repoPath: repoDir, file: 'hello.txt' });
    expect(text).toContain('blame hello.txt');
    expect(text).toContain('Test Author');
    expect(text).toContain('Initial commit');
    expect(text).toMatch(/L1-3 [0-9a-f]{7} /);
  });

  it('round-trips a work-in-progress patch through create_patch and apply_patch', async () => {
    const file = path.join(repoDir, 'hello.txt');
    // A "wip" patch includes untracked files, and applying it back would
    // collide with the fixture's own untracked file.
    await rm(path.join(repoDir, 'untracked.txt'), { force: true });
    await writeFile(file, 'one\nTWO\nthree\n');
    const patch = await handlers.create_patch({ repoPath: repoDir, source: 'wip' });
    expect(patch).toContain('format: "gitglasses-patch"');
    // The patch keeps its real newlines rather than arriving JSON-escaped.
    expect(patch).toContain('\n--- patch ---\n');
    expect(patch).not.toContain('\\n');

    git(repoDir, 'checkout', '--', 'hello.txt');
    const applied = await handlers.apply_patch({ repoPath: repoDir, envelopeJson: patch });
    expect(applied).toContain('applied: true');
    expect(await readFile(file, 'utf8')).toBe('one\nTWO\nthree\n');

    git(repoDir, 'checkout', '--', 'hello.txt');
  });

  it('refuses to apply a truncated patch', async () => {
    await writeFile(path.join(repoDir, 'hello.txt'), 'one\nTWO\nthree\n');
    const patch = await handlers.create_patch({
      repoPath: repoDir,
      source: 'wip',
      maxChars: 200,
    });
    expect(patch).toMatch(/\(truncated to 200 characters;/);
    await expect(
      handlers.apply_patch({ repoPath: repoDir, envelopeJson: patch }),
    ).rejects.toThrow(/truncated/);
    git(repoDir, 'checkout', '--', 'hello.txt');
  });

  it('surfaces engine errors as plain messages', async () => {
    await expect(
      handlers.git_status({ repoPath: path.join(os.tmpdir(), 'definitely-not-a-repo') }),
    ).rejects.toThrow(/no git repository at or above/);
  });

  it('git_diff renders unstaged hunks and separates them from staged ones', async () => {
    git(repoDir, 'reset', '--hard', 'HEAD');
    await writeFile(path.join(repoDir, 'diffme.txt'), 'one\ntwo\nthree\n');
    git(repoDir, 'add', 'diffme.txt');
    git(repoDir, 'commit', '-m', 'Add diffme');
    await writeFile(path.join(repoDir, 'diffme.txt'), 'one\nTWO\nthree\nfour\n');
    await writeFile(path.join(repoDir, 'staged.txt'), 'indexed\n');
    git(repoDir, 'add', 'staged.txt');
    try {
      const unstaged = await handlers.git_diff({ repoPath: repoDir });
      expect(unstaged).toContain('M  diffme.txt (+2 -1)');
      expect(unstaged).toContain('-two');
      expect(unstaged).toContain('+TWO');
      expect(unstaged).not.toContain('staged.txt');

      const staged = await handlers.git_diff({ repoPath: repoDir, staged: true });
      expect(staged).toContain('A  staged.txt (+1 -0)');
      expect(staged).toContain('+indexed');

      const one = await handlers.git_diff({ repoPath: repoDir, file: 'diffme.txt' });
      expect(one).toBe(
        'diff unstaged (1 file):\nM  diffme.txt (+2 -1)\n@@ -1,3 +1,4 @@\n one\n-two\n+TWO\n three\n+four',
      );
      expect(await handlers.git_diff({ repoPath: repoDir, file: 'diffme.txt', staged: true })).toBe(
        'No staged changes in diffme.txt',
      );
    } finally {
      git(repoDir, 'reset', '--hard', 'HEAD~1');
      await rm(path.join(repoDir, 'staged.txt'), { force: true });
      await rm(path.join(repoDir, 'diffme.txt'), { force: true });
    }
  });

  it('git_diff marks a binary file rather than showing it as unchanged', async () => {
    await writeFile(path.join(repoDir, 'blob.bin'), Buffer.from([0, 1, 2, 0, 3]));
    git(repoDir, 'add', 'blob.bin');
    git(repoDir, 'commit', '-m', 'Add blob');
    await writeFile(path.join(repoDir, 'blob.bin'), Buffer.from([0, 9, 9, 0, 4, 4]));
    try {
      expect(await handlers.git_diff({ repoPath: repoDir, file: 'blob.bin' })).toBe(
        'diff unstaged (1 file):\nM  blob.bin (binary)',
      );
      const shown = await handlers.git_commit_show({ repoPath: repoDir, sha: 'HEAD' });
      expect(shown).toContain('A  blob.bin (binary)');
    } finally {
      git(repoDir, 'reset', '--hard', 'HEAD~1');
      await rm(path.join(repoDir, 'blob.bin'), { force: true });
    }
  });

  it('git_commit_show resolves a ref and includes the patch on request', async () => {
    const byRef = await handlers.git_commit_show({ repoPath: repoDir, sha: 'HEAD' });
    const byName = await handlers.git_commit_show({ repoPath: repoDir, sha: 'main' });
    expect(byRef).toBe(byName);
    expect(byRef).toContain('A  hello.txt (+3 -0)');
    expect(byRef).not.toContain('diff:');

    const withDiff = await handlers.git_commit_show({
      repoPath: repoDir,
      sha: 'HEAD',
      includeDiff: true,
    });
    expect(withDiff).toContain('\ndiff:\n');
    expect(withDiff).toContain('diff --git a/hello.txt b/hello.txt');
    expect(withDiff).toContain('+one');
  });

  it('git_refs lists branches and tags with the sha each points at', async () => {
    git(repoDir, 'tag', 'v9.9');
    try {
      const text = await handlers.git_refs({ repoPath: repoDir });
      expect(text).toMatch(/^branches \(1\):\n {2}main [0-9a-f]{7} \(current\)$/m);
      expect(text).toMatch(/^tags \(1\):\n {2}v9\.9 [0-9a-f]{7}$/m);
    } finally {
      git(repoDir, 'tag', '-d', 'v9.9');
    }
  });

  // Without a cursor no call reaches a commit past the limit, whatever it is.
  it('pages the log and file history past the limit with the cursor it returns', async () => {
    for (let i = 0; i < 3; i += 1) {
      await writeFile(path.join(repoDir, 'hello.txt'), `revision ${i}\n`);
      git(repoDir, 'commit', '-am', `Revision ${i}`);
    }
    try {
      const first = await handlers.git_log_search({ repoPath: repoDir, limit: 2 });
      const cursor = /cursor: "([^"]+)"/.exec(first)?.[1];
      expect(cursor).toBeTruthy();
      const second = await handlers.git_log_search({ repoPath: repoDir, limit: 2, cursor });
      expect(second).toContain('Revision 0');
      expect(second).not.toContain('Revision 2');

      const history = await handlers.git_file_history({
        repoPath: repoDir,
        file: 'hello.txt',
        limit: 2,
      });
      const historyCursor = /cursor: "([^"]+)"/.exec(history)?.[1];
      expect(historyCursor).toBeTruthy();
      expect(
        await handlers.git_file_history({
          repoPath: repoDir,
          file: 'hello.txt',
          limit: 2,
          cursor: historyCursor,
        }),
      ).toContain('Revision 0');
    } finally {
      git(repoDir, 'reset', '--hard', 'HEAD~3');
    }
  });

  // The engine streams hunks in blame order, so a page is selected by line
  // rather than by order of arrival.
  it('git_blame returns hunks in line order and pages by startLine', async () => {
    await writeFile(path.join(repoDir, 'many.txt'), 'a\nb\nc\nd\n');
    git(repoDir, 'add', 'many.txt');
    git(repoDir, 'commit', '-m', 'Add many');
    await writeFile(path.join(repoDir, 'many.txt'), 'a\nB\nc\nd\n');
    git(repoDir, 'commit', '-am', 'Edit line 2');
    try {
      const page = await handlers.git_blame({ repoPath: repoDir, file: 'many.txt', limit: 2 });
      const lines = page.split('\n');
      expect(lines[1]).toMatch(/^L1 /);
      expect(lines[2]).toMatch(/^L2 /);
      expect(page).toContain('pass startLine: 3 for the next page');

      const next = await handlers.git_blame({
        repoPath: repoDir,
        file: 'many.txt',
        limit: 2,
        startLine: 3,
      });
      expect(next.split('\n')[1]).toMatch(/^L3-4 /);
    } finally {
      git(repoDir, 'reset', '--hard', 'HEAD~2');
      await rm(path.join(repoDir, 'many.txt'), { force: true });
    }
  });
});

// Every tool names the empty repository. "branch: <blank> / working tree clean"
// and "nothing found" both read as a healthy repository worth querying further.
describe.skipIf(!enginePath)('repository with no commits', () => {
  let repoDir: string;
  let client: EngineClient;
  let handlers: ToolHandlers;

  beforeAll(async () => {
    repoDir = await mkdtemp(path.join(os.tmpdir(), 'gitglasses-mcp-empty-'));
    git(repoDir, 'init', '-b', 'main');
    git(repoDir, 'config', 'core.autocrlf', 'false');
    client = createEngineClient({ enginePath });
    handlers = createToolHandlers({ client, env: {} });
  }, 30000);

  afterAll(async () => {
    client?.dispose();
    if (repoDir) await rm(repoDir, { recursive: true, force: true });
  });

  it('git_status says there are no commits instead of naming a blank branch', async () => {
    expect(await handlers.git_status({ repoPath: repoDir })).toBe(
      'branch: (no commits yet)\nworking tree clean',
    );
  });

  for (const [name, call] of [
    ['git_log_search', (h: ToolHandlers, p: string) => h.git_log_search({ repoPath: p, limit: 20 })],
    ['git_graph_summary', (h: ToolHandlers, p: string) => h.git_graph_summary({ repoPath: p, limit: 30 })],
    ['git_refs', (h: ToolHandlers, p: string) => h.git_refs({ repoPath: p })],
    ['git_file_history', (h: ToolHandlers, p: string) => h.git_file_history({ repoPath: p, file: 'x', limit: 20 })],
    ['git_blame', (h: ToolHandlers, p: string) => h.git_blame({ repoPath: p, file: 'x' })],
  ] as const) {
    it(`${name} reports the empty repository rather than "nothing found"`, async () => {
      expect(await call(handlers, repoDir)).toContain('no commits yet');
    });
  }

  for (const [name, call] of [
    ['create_patch', (h: ToolHandlers, p: string) => h.create_patch({ repoPath: p, source: 'wip' })],
    ['git_commit_show', (h: ToolHandlers, p: string) => h.git_commit_show({ repoPath: p, sha: 'HEAD' })],
  ] as const) {
    it(`${name} fails with the empty repository, not raw git output`, async () => {
      const error = await call(handlers, repoDir).then(
        () => undefined,
        (caught: Error) => caught,
      );
      expect(error?.message).toContain('no commits yet');
      expect(error?.message).not.toContain('fatal:');
      expect(error?.message.split('\n')).toHaveLength(1);
    });
  }

  it('git_diff still reports untracked work, which exists before the first commit', async () => {
    await writeFile(path.join(repoDir, 'draft.txt'), 'first\n');
    const text = await handlers.git_diff({ repoPath: repoDir });
    expect(text).toContain('?  draft.txt (+1 -0)');
    expect(text).toContain('+first');
  });

  it('git_status names a detached HEAD once there are commits', async () => {
    git(repoDir, 'add', '.');
    git(repoDir, 'commit', '-m', 'First');
    git(repoDir, 'commit', '--allow-empty', '-m', 'Second');
    git(repoDir, 'checkout', '--detach', 'HEAD~1');
    expect(await handlers.git_status({ repoPath: repoDir })).toMatch(
      /^branch: \(detached at [0-9a-f]{7}\)$/m,
    );
  });
});

describe.skipIf(!existsSync(cliPath))('MCP stdio smoke', () => {
  it('dist/cli.js answers an MCP initialize request over stdio', async () => {
    const child = spawn(process.execPath, [cliPath], { stdio: ['pipe', 'pipe', 'pipe'] });
    try {
      const response = await new Promise<Record<string, any>>((resolve, reject) => {
        let buffer = '';
        const timer = setTimeout(() => reject(new Error('initialize timed out')), 10000);
        child.stdout.on('data', (chunk: Buffer) => {
          buffer += chunk.toString('utf8');
          const newline = buffer.indexOf('\n');
          if (newline >= 0) {
            clearTimeout(timer);
            resolve(JSON.parse(buffer.slice(0, newline)));
          }
        });
        child.on('error', reject);
        child.stdin.write(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: {
              protocolVersion: '2024-11-05',
              capabilities: {},
              clientInfo: { name: 'smoke-test', version: '0.0.0' },
            },
          }) + '\n',
        );
      });
      expect(response.id).toBe(1);
      expect(response.result?.serverInfo?.name).toBe('gitglasses');
      expect(response.result?.capabilities?.tools).toBeDefined();
    } finally {
      child.kill();
    }
  }, 15000);
});
