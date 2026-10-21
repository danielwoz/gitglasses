// Which repositories the server reads, and which engine reads them. By
// default only repositories inside the client's MCP roots are served, by an
// engine that runs no git; the operator's allow list (--allow,
// GITGLASSES_ALLOWED_ROOTS) replaces the roots and lets git run there.

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ListRootsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { ErrorCodes } from '@gitglasses/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  canonicalPath,
  createServer,
  createToolHandlers,
  workingDirectoryRoot,
} from '../src/server.js';

/**
 * An engine stand-in that answers repo/discover with the requested path as the
 * repository root (or `rootFor`'s answer) and records every request it gets.
 */
function fakeEngine(name: string, rootFor: (requested: string) => string = (p) => p) {
  const requests: { method: string; params: Record<string, unknown> }[] = [];
  const client = {
    name,
    requests,
    async request(method: string, params: Record<string, unknown>) {
      requests.push({ method, params });
      if (method === 'repo/discover') {
        const requested = params.path as string;
        return { repoId: `${name}:${requested}`, rootPath: rootFor(requested), gitDir: '' };
      }
      if (method === 'status/summary') {
        return {
          branch: 'main',
          ahead: 0,
          behind: 0,
          staged: [],
          unstaged: [],
          untracked: [],
          conflicted: [],
        };
      }
      if (method === 'repo/state') {
        return { head: { branch: 'main', oid: 'a'.repeat(40), detached: false, unborn: false } };
      }
      if (method === 'history/file' && name === 'restricted') {
        throw Object.assign(new Error('not available in Restricted Mode'), {
          code: ErrorCodes.Restricted,
        });
      }
      throw new Error(`unexpected ${method}`);
    },
    onNotification() {
      return { dispose() {} };
    },
  };
  return client;
}

/** The engine each repoPath's first request reached. */
function servedBy(...engines: ReturnType<typeof fakeEngine>[]): string[] {
  return engines.flatMap((engine) =>
    engine.requests.filter((r) => r.method === 'repo/discover').map(() => engine.name),
  );
}

let base: string;
let workspace: string;
let sibling: string;

beforeAll(() => {
  base = canonicalPath(mkdtempSync(path.join(os.tmpdir(), 'gitglasses-roots-')));
  workspace = path.join(base, 'workspace');
  sibling = path.join(base, 'sibling');
  mkdirSync(path.join(workspace, 'sub'), { recursive: true });
  mkdirSync(sibling, { recursive: true });
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('default containment: the client roots, read without git', () => {
  it('serves a repository inside the roots through the restricted engine', async () => {
    const trusted = fakeEngine('trusted');
    const restricted = fakeEngine('restricted');
    const handlers = createToolHandlers({
      client: trusted as never,
      restrictedClient: restricted as never,
      clientRoots: async () => [workspace],
      env: {},
    });
    await handlers.git_status({ repoPath: workspace });
    expect(servedBy(trusted, restricted)).toEqual(['restricted']);
  });

  it('rejects a repository outside the roots before reaching any engine', async () => {
    const trusted = fakeEngine('trusted');
    const restricted = fakeEngine('restricted');
    const handlers = createToolHandlers({
      client: trusted as never,
      restrictedClient: restricted as never,
      clientRoots: async () => [workspace],
      env: {},
    });
    await expect(handlers.git_status({ repoPath: sibling })).rejects.toThrow(
      /outside the client's workspace roots/,
    );
    expect(trusted.requests).toEqual([]);
    expect(restricted.requests).toEqual([]);
  });

  // A workspace folder inside a larger repository would otherwise grant the
  // whole enclosing repository, since discovery walks upwards.
  it('rejects a path inside the roots whose repository extends outside them', async () => {
    const restricted = fakeEngine('restricted', () => base);
    const handlers = createToolHandlers({
      client: fakeEngine('trusted') as never,
      restrictedClient: restricted as never,
      clientRoots: async () => [path.join(workspace, 'sub')],
      env: {},
    });
    const call = () => handlers.git_status({ repoPath: path.join(workspace, 'sub') });
    await expect(call()).rejects.toThrow(/belongs to the repository at .* which extends outside/);
    // Not cached: the next call asks again rather than reusing the rejected repository.
    await expect(call()).rejects.toThrow(/extends outside/);
    expect(restricted.requests.filter((r) => r.method === 'repo/discover')).toHaveLength(2);
  });

  it('falls back to the working directory when the client offers no roots', async () => {
    const restricted = fakeEngine('restricted');
    const handlers = createToolHandlers({
      client: fakeEngine('trusted') as never,
      restrictedClient: restricted as never,
      clientRoots: async () => undefined,
      env: {},
    });
    await handlers.git_status({ repoPath: path.join(process.cwd(), 'test') });
    await expect(handlers.git_status({ repoPath: sibling })).rejects.toThrow(/outside/);
    expect(servedBy(restricted)).toEqual(['restricted']);
  });

  it('never takes a filesystem root or the home directory as the working directory root', () => {
    const home = path.join(base, 'home');
    expect(workingDirectoryRoot(workspace, home)).toEqual([workspace]);
    expect(workingDirectoryRoot(home, home)).toEqual([]);
    expect(workingDirectoryRoot(path.parse(base).root, home)).toEqual([]);
  });

  it('never takes a directory that holds the home directory as the working directory root', () => {
    const home = path.join(base, 'users', 'me');
    mkdirSync(home, { recursive: true });
    expect(workingDirectoryRoot(path.join(base, 'users'), home)).toEqual([]);
    expect(workingDirectoryRoot(base, home)).toEqual([]);
    expect(workingDirectoryRoot(path.join(home, 'project'), home)).toEqual([
      canonicalPath(path.join(home, 'project')),
    ]);
  });

  it('explains how to enable a tool the restricted engine refuses', async () => {
    const handlers = createToolHandlers({
      client: fakeEngine('trusted') as never,
      restrictedClient: fakeEngine('restricted') as never,
      clientRoots: async () => [workspace],
      env: {},
    });
    await expect(
      handlers.git_file_history({ repoPath: workspace, file: 'a.txt', limit: 20 }),
    ).rejects.toThrow(/git_file_history needs git .*\(--allow or GITGLASSES_ALLOWED_ROOTS\)/);
  });

  it('serves nothing without a restricted engine to read the roots with', async () => {
    const trusted = fakeEngine('trusted');
    const handlers = createToolHandlers({
      client: trusted as never,
      clientRoots: async () => [workspace],
      env: {},
    });
    await expect(handlers.git_status({ repoPath: workspace })).rejects.toThrow(/outside/);
    expect(trusted.requests).toEqual([]);
  });
});

describe('allow list: the operator names the directories, and git runs there', () => {
  it('serves an allowed repository through the full engine and ignores the client roots', async () => {
    const trusted = fakeEngine('trusted');
    const restricted = fakeEngine('restricted');
    const handlers = createToolHandlers({
      client: trusted as never,
      restrictedClient: restricted as never,
      allow: [sibling],
      clientRoots: async () => [workspace],
      env: {},
    });
    await handlers.git_status({ repoPath: sibling });
    await expect(handlers.git_status({ repoPath: workspace })).rejects.toThrow(
      /outside the directories this server was started with/,
    );
    expect(servedBy(trusted, restricted)).toEqual(['trusted']);
  });

  it('takes GITGLASSES_ALLOWED_ROOTS the same way', async () => {
    const trusted = fakeEngine('trusted');
    const handlers = createToolHandlers({
      client: trusted as never,
      restrictedClient: fakeEngine('restricted') as never,
      env: { GITGLASSES_ALLOWED_ROOTS: workspace },
    });
    await handlers.git_status({ repoPath: path.join(workspace, 'sub') });
    expect(servedBy(trusted)).toEqual(['trusted']);
  });

  it('admits every path with "*"', async () => {
    const trusted = fakeEngine('trusted');
    const handlers = createToolHandlers({
      client: trusted as never,
      restrictedClient: fakeEngine('restricted') as never,
      allow: ['*'],
      env: {},
    });
    await handlers.git_status({ repoPath: sibling });
    expect(servedBy(trusted)).toEqual(['trusted']);
  });
});

// The roots come from the MCP session itself: roots/list after initialize,
// and again after every notifications/roots/list_changed.
describe('client roots over MCP', () => {
  async function connect(roots: { current: string[] }) {
    const restricted = fakeEngine('restricted');
    const server = createServer({
      client: fakeEngine('trusted') as never,
      restrictedClient: restricted as never,
      env: {},
    });
    const client = new Client(
      { name: 'roots-test', version: '0.0.0' },
      { capabilities: { roots: { listChanged: true } } },
    );
    client.setRequestHandler(ListRootsRequestSchema, async () => ({
      roots: roots.current.map((dir) => ({ uri: pathToFileURL(dir).href })),
    }));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const status = async (repoPath: string) =>
      client.callTool({ name: 'git_status', arguments: { repoPath } });
    return { client, status, restricted };
  }

  const text = (result: Awaited<ReturnType<Client['callTool']>>) =>
    (result.content as { text: string }[])[0].text;

  it('serves the roots the client lists and nothing else', async () => {
    const { status } = await connect({ current: [workspace] });
    expect((await status(workspace)).isError).toBeFalsy();
    const outside = await status(sibling);
    expect(outside.isError).toBe(true);
    expect(text(outside)).toMatch(/outside the client's workspace roots/);
  });

  it('follows the client when its roots change', async () => {
    const roots = { current: [workspace] };
    const { client, status } = await connect(roots);
    expect((await status(sibling)).isError).toBe(true);

    roots.current = [sibling];
    await client.sendRootsListChanged();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect((await status(sibling)).isError).toBeFalsy();
    expect((await status(workspace)).isError).toBe(true);
  });

  it('serves nothing when the client lists no local directory', async () => {
    const { status } = await connect({ current: [] });
    expect((await status(workspace)).isError).toBe(true);
  });
});
