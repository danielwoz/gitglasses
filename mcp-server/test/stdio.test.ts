// The built CLI over stdio, driven the way an MCP client drives it: it keeps
// serving after a line it cannot read, answers the requests it has already
// read when stdin ends, and exits instead of lingering once the connection is
// gone. Skips without dist/cli.js; the tests that start an engine also skip
// without one.

import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { resolveEnginePath } from '../src/engine.js';

const packageRoot = path.resolve(import.meta.dirname, '..');
const enginePath = resolveEnginePath({ packageRoot });
const cliPath = path.join(packageRoot, 'dist', 'cli.js');

/** The most the SDK's stdio transport buffers of one line (10 MiB). */
const TRANSPORT_BUFFER_BYTES = 10 * 1024 * 1024;

/** How long the server may take to exit once the connection is gone. */
const EXIT_WITHIN_MS = 5000;

/** How long the server waits for answers still owed when stdin ends (cli.ts). */
const ANSWER_GRACE_MS = 10_000;

// The fields of a JSON-RPC response these tests read.
interface Response {
  id?: number;
  result?: { content?: { text?: string }[]; tools?: unknown[] };
  error?: { message?: string };
}

interface Exit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

interface Session {
  child: ChildProcessWithoutNullStreams;
  request(method: string, params?: Record<string, unknown>): Promise<Response>;
  /** Writes a request without waiting for its answer; returns its id. */
  send(method: string, params?: Record<string, unknown>): number;
  notify(method: string, params?: Record<string, unknown>): void;
  stderr(): string;
  exited: Promise<Exit>;
}

const sessions: Session[] = [];

/** The CLI started with `args`, answering newline-delimited JSON-RPC. */
function startCli(args: string[] = [], env: Record<string, string> = {}): Session {
  const child = spawn(process.execPath, [cliPath, ...args], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
  });
  // The server may exit before it has read everything written to it.
  child.stdin.on('error', () => undefined);
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });
  const pending = new Map<number, (response: Response) => void>();
  let buffered = '';
  child.stdout.on('data', (chunk: Buffer) => {
    buffered += chunk.toString('utf8');
    let newline;
    while ((newline = buffered.indexOf('\n')) >= 0) {
      const response = JSON.parse(buffered.slice(0, newline)) as Response;
      buffered = buffered.slice(newline + 1);
      if (response.id !== undefined) pending.get(response.id)?.(response);
    }
  });
  // 'close' rather than 'exit', so all of stderr has arrived by then.
  const exited = new Promise<Exit>((resolve) =>
    child.on('close', (code, signal) => resolve({ code, signal })),
  );
  let nextId = 1;
  const send = (method: string, params: Record<string, unknown> = {}): number => {
    const id = nextId++;
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return id;
  };
  const session: Session = {
    child,
    request: (method, params = {}) =>
      new Promise((resolve, reject) => {
        pending.set(nextId, resolve);
        exited.then(
          (exit) => reject(new Error(`server exited (${JSON.stringify(exit)}): ${stderr}`)),
          reject,
        );
        send(method, params);
      }),
    send,
    notify: (method, params) =>
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`),
    stderr: () => stderr,
    exited,
  };
  sessions.push(session);
  return session;
}

async function initialize(session: Session): Promise<void> {
  const response = await session.request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'stdio-test', version: '0.0.0' },
  });
  expect(response.error).toBeUndefined();
  session.notify('notifications/initialized');
}

/** How the server exited, or a rejection when it is still running after `ms`. */
function exitWithin(session: Session, ms: number): Promise<Exit> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`still running after ${ms} ms`)), ms);
    void session.exited.then((exit) => {
      clearTimeout(timer);
      resolve(exit);
    });
  });
}

afterEach(() => {
  for (const session of sessions.splice(0)) session.child.kill('SIGKILL');
});

describe.skipIf(!existsSync(cliPath))('MCP stdio connection', () => {
  it('reports a line it cannot read and answers the next request', async () => {
    const session = startCli();
    await initialize(session);
    session.child.stdin.write('{not json\n');
    // JSON but not JSON-RPC, which the SDK reports in a message of several lines.
    session.child.stdin.write('{"hello":"world"}\n');

    const listed = await session.request('tools/list');
    expect(listed.result?.tools?.length).toBeGreaterThan(0);
    // stderr is a pipe of its own, so its lines can trail the answer.
    await vi.waitFor(() => {
      const lines = session.stderr().trimEnd().split('\n');
      expect(lines).toHaveLength(2);
      for (const line of lines) expect(line).toMatch(/^gitglasses-mcp: \S/);
    });

    // Those reports do not count against a clean disconnect.
    session.child.stdin.end();
    expect(await exitWithin(session, EXIT_WITHIN_MS)).toEqual({ code: 0, signal: null });
  }, 15000);

  it('exits with an error once a line outgrows the transport buffer', async () => {
    const session = startCli();
    await initialize(session);
    // Left open, so the server has to notice on its own that it has stopped
    // reading.
    session.child.stdin.write('x'.repeat(TRANSPORT_BUFFER_BYTES + 1));

    const exit = await exitWithin(session, 10000);
    expect(exit.signal).toBeNull();
    expect(exit.code).not.toBe(0);
    expect(session.stderr()).toMatch(/^gitglasses-mcp: .*maximum size/m);
    expect(session.stderr()).toContain('gitglasses-mcp: connection closed after an error; exiting');
  }, 20000);

  it('exits with 0 when the client closes stdin before any engine starts', async () => {
    const session = startCli();
    await initialize(session);
    session.child.stdin.end();
    expect(await exitWithin(session, EXIT_WITHIN_MS)).toEqual({ code: 0, signal: null });
    expect(session.stderr()).toBe('');
  }, 15000);
});

/** A repository with one commit on main, in a new temporary directory. */
async function createRepo(): Promise<string> {
  const repoDir = await mkdtemp(path.join(os.tmpdir(), 'gitglasses-mcp-stdio-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repoDir });
  git('init', '-b', 'main');
  git('config', 'user.name', 'Test Author');
  git('config', 'user.email', 'test@example.com');
  git('config', 'core.autocrlf', 'false');
  await writeFile(path.join(repoDir, 'hello.txt'), 'one\n');
  git('add', '.');
  git('commit', '-m', 'Initial commit');
  return repoDir;
}

// A tool call starts an engine process, which on its own would keep the
// server running after the client has gone.
describe.skipIf(!existsSync(cliPath) || !enginePath)('MCP stdio connection with an engine', () => {
  let repoDir: string;

  beforeAll(async () => {
    repoDir = await createRepo();
  }, 30000);

  afterAll(async () => {
    if (repoDir) await rm(repoDir, { recursive: true, force: true });
  });

  async function startedEngine(): Promise<Session> {
    const session = startCli(['--allow', repoDir]);
    await initialize(session);
    const status = await session.request('tools/call', {
      name: 'git_status',
      arguments: { repoPath: repoDir },
    });
    expect(status.result?.content?.[0]?.text).toContain('branch: main');
    return session;
  }

  it('exits with 0 when the client closes stdin', async () => {
    const session = await startedEngine();
    session.child.stdin.end();
    expect(await exitWithin(session, EXIT_WITHIN_MS)).toEqual({ code: 0, signal: null });
  }, 30000);

  it('answers a request still running when the client closes stdin', async () => {
    const session = startCli(['--allow', repoDir]);
    await initialize(session);
    // The first tool call starts the engine, so its answer comes after stdin
    // has ended.
    const status = session.request('tools/call', {
      name: 'git_status',
      arguments: { repoPath: repoDir },
    });
    session.child.stdin.end();

    expect((await status).result?.content?.[0]?.text).toContain('branch: main');
    expect(await exitWithin(session, EXIT_WITHIN_MS)).toEqual({ code: 0, signal: null });
    expect(session.stderr()).not.toContain('gitglasses-mcp:');
  }, 30000);

  it('exits with 0 when the client closes both pipes while a request is running', async () => {
    const session = startCli(['--allow', repoDir]);
    await initialize(session);
    session.send('tools/call', { name: 'git_status', arguments: { repoPath: repoDir } });
    // The answer then has nowhere to go.
    session.child.stdout.destroy();
    session.child.stdin.end();

    expect(await exitWithin(session, EXIT_WITHIN_MS)).toEqual({ code: 0, signal: null });
    expect(session.stderr()).not.toContain('gitglasses-mcp:');
  }, 30000);

  it.skipIf(process.platform === 'win32')(
    'exits with 0 on SIGTERM',
    async () => {
      const session = await startedEngine();
      session.child.kill('SIGTERM');
      expect(await exitWithin(session, EXIT_WITHIN_MS)).toEqual({ code: 0, signal: null });
    },
    30000,
  );
});

// An engine that reads requests and never answers, so a tool call stays
// unanswered. It is a script started through its #! line, which Windows does
// not do.
describe.skipIf(!existsSync(cliPath) || process.platform === 'win32')(
  'MCP stdio connection with an engine that never answers',
  () => {
    let repoDir: string;
    let stubDir: string;
    let stubEngine: string;

    beforeAll(async () => {
      repoDir = await createRepo();
      stubDir = await mkdtemp(path.join(os.tmpdir(), 'gitglasses-mcp-stub-'));
      stubEngine = path.join(stubDir, 'engine.mjs');
      await writeFile(stubEngine, '#!/usr/bin/env node\nprocess.stdin.resume();\n', {
        mode: 0o755,
      });
    }, 30000);

    afterAll(async () => {
      if (repoDir) await rm(repoDir, { recursive: true, force: true });
      if (stubDir) await rm(stubDir, { recursive: true, force: true });
    });

    /** A session whose tool call, the request returned by id, is never answered. */
    async function stalledToolCall(): Promise<{ session: Session; id: number }> {
      const session = startCli(['--allow', repoDir], { GITGLASSES_ENGINE: stubEngine });
      await initialize(session);
      const id = session.send('tools/call', {
        name: 'git_status',
        arguments: { repoPath: repoDir },
      });
      return { session, id };
    }

    it('exits with 0 once the time for answers has run out', async () => {
      const { session } = await stalledToolCall();
      session.child.stdin.end();

      expect(await exitWithin(session, ANSWER_GRACE_MS + EXIT_WITHIN_MS)).toEqual({
        code: 0,
        signal: null,
      });
      expect(session.stderr()).toContain(
        'gitglasses-mcp: stdin ended with 1 request(s) unanswered; exiting',
      );
    }, 30000);

    it('exits with 0 straight away when the client has cancelled the request', async () => {
      const { session, id } = await stalledToolCall();
      session.notify('notifications/cancelled', { requestId: id });
      session.child.stdin.end();

      expect(await exitWithin(session, EXIT_WITHIN_MS)).toEqual({ code: 0, signal: null });
      expect(session.stderr()).toBe('');
    }, 15000);
  },
);
