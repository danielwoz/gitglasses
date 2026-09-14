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
    ).rejects.toThrow();
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
