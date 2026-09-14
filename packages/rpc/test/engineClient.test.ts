// EngineClient logic tests over an in-memory transport — the handshake,
// request/response, notification, respawn, and cancellation coverage that
// previously only the real-binary integration tests exercised.

import { describe, expect, it } from 'vitest';
import { EngineCapabilities, ErrorCodes, PROTOCOL_VERSION } from '@gitglasses/protocol';
import {
  EngineClient,
  EngineClientOptions,
  EngineError,
  EngineRestartedError,
} from '../src/engineClient.js';
import { EngineTransport } from '../src/transport.js';

const CAPS_FULL: EngineCapabilities = { gitCli: true, watch: true, threads: true };

type Responder = (msg: { id: number; method: string; params: unknown }) => void;

class FakeTransport implements EngineTransport {
  sent: { id?: number; method: string; params: unknown }[] = [];
  killed = false;
  started = false;
  private messageHandler: ((payload: string) => void) | undefined;
  private exitHandler: ((info: { code: number | null }) => void) | undefined;
  /** Per-method scripted responses; initialize is answered by default. */
  responders = new Map<string, Responder>();

  constructor(
    private readonly capabilities: EngineCapabilities = CAPS_FULL,
    private readonly protocolVersion: string = PROTOCOL_VERSION,
  ) {
    this.responders.set('initialize', (msg) =>
      this.respond(msg.id, {
        engineVersion: 'fake',
        protocolVersion: this.protocolVersion,
        capabilities: this.capabilities,
      }),
    );
  }

  onMessage(handler: (payload: string) => void): void {
    this.messageHandler = handler;
  }

  onExit(handler: (info: { code: number | null }) => void): void {
    this.exitHandler = handler;
  }

  start(): Promise<void> {
    this.started = true;
    return Promise.resolve();
  }

  send(payload: string): void {
    const msg = JSON.parse(payload) as { id?: number; method: string; params: unknown };
    this.sent.push(msg);
    if (msg.id !== undefined) {
      this.responders.get(msg.method)?.(msg as { id: number; method: string; params: unknown });
    }
  }

  kill(): void {
    this.killed = true;
  }

  respond(id: number, result: unknown): void {
    this.deliver(JSON.stringify({ jsonrpc: '2.0', id, result }));
  }

  respondError(id: number, code: number, message: string): void {
    this.deliver(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }));
  }

  notifyClient(method: string, params: unknown): void {
    this.deliver(JSON.stringify({ jsonrpc: '2.0', method, params }));
  }

  crash(code: number | null): void {
    this.exitHandler?.({ code });
  }

  private deliver(payload: string): void {
    // Asynchronous like a real pipe, so responses never resolve inline.
    queueMicrotask(() => this.messageHandler?.(payload));
  }
}

function makeClient(
  options: EngineClientOptions = {},
  makeTransport: (spawnIndex: number) => FakeTransport = () => new FakeTransport(),
): { client: EngineClient; transports: FakeTransport[] } {
  const transports: FakeTransport[] = [];
  const client = new EngineClient(() => {
    const transport = makeTransport(transports.length);
    transports.push(transport);
    return transport;
  }, options);
  return { client, transports };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('EngineClient over a fake transport', () => {
  it('performs the initialize handshake and exposes capabilities', async () => {
    const { client, transports } = makeClient();
    let changes = 0;
    client.onDidChangeCapabilities(() => (changes += 1));

    expect(client.capabilities()).toBeUndefined(); // unknown before initialize
    await client.start();

    expect(transports).toHaveLength(1);
    expect(transports[0].sent[0]).toMatchObject({
      method: 'initialize',
      params: { protocolVersion: PROTOCOL_VERSION },
    });
    expect(client.capabilities()).toEqual(CAPS_FULL);
    expect(changes).toBe(1);
    client.dispose();
  });

  it('rejects start on a protocol version mismatch', async () => {
    const { client } = makeClient({}, () => new FakeTransport(CAPS_FULL, 'v0-bogus'));
    await expect(client.start()).rejects.toSatisfy(
      (e: unknown) => e instanceof EngineError && e.code === ErrorCodes.InvalidRequest,
    );
    client.dispose();
  });

  it('round-trips a request through the transport', async () => {
    const { client, transports } = makeClient();
    await client.start();
    transports[0].responders.set('repo/list', (msg) =>
      transports[0].respond(msg.id, { repos: [{ repoId: 'r1' }] }),
    );

    const result = await client.request('repo/list', {});
    expect(result).toEqual({ repos: [{ repoId: 'r1' }] });
    client.dispose();
  });

  it('rejects with a typed EngineError on an error response', async () => {
    const { client, transports } = makeClient();
    await client.start();
    transports[0].responders.set('repo/state', (msg) =>
      transports[0].respondError(msg.id, ErrorCodes.RepoNotFound, 'no such repo'),
    );

    await expect(client.request('repo/state', { repoId: 'r9' })).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof EngineError && e.code === ErrorCodes.RepoNotFound && e.message === 'no such repo',
    );
    client.dispose();
  });

  it('surfaces -32003 through onMethodNotSupported with the message verbatim', async () => {
    const seen: { method: string; message: string }[] = [];
    const { client, transports } = makeClient({
      onMethodNotSupported: (method, message) => seen.push({ method, message }),
    });
    await client.start();
    transports[0].responders.set('mutate/commit', (msg) =>
      transports[0].respondError(
        msg.id,
        ErrorCodes.MethodNotSupported,
        'mutate/commit requires the git CLI',
      ),
    );

    await expect(
      client.request('mutate/commit', { repoId: 'r1', message: 'x' }),
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof EngineError && e.code === ErrorCodes.MethodNotSupported,
    );
    expect(seen).toEqual([
      { method: 'mutate/commit', message: 'mutate/commit requires the git CLI' },
    ]);
    client.dispose();
  });

  it('dispatches engine notifications and supports unsubscription', async () => {
    const { client, transports } = makeClient();
    await client.start();

    const received: unknown[] = [];
    const sub = client.onNotification('repo/didChange', (params) => received.push(params));
    transports[0].notifyClient('repo/didChange', { repoId: 'r1', changed: ['HEAD'] });
    await sleep(0);
    expect(received).toEqual([{ repoId: 'r1', changed: ['HEAD'] }]);

    sub.dispose();
    transports[0].notifyClient('repo/didChange', { repoId: 'r1', changed: ['refs'] });
    await sleep(0);
    expect(received).toHaveLength(1);
    client.dispose();
  });

  it('rejects requests made before start with EngineRestartedError', async () => {
    const { client } = makeClient();
    await expect(client.request('repo/list', {})).rejects.toBeInstanceOf(EngineRestartedError);
  });

  it('on exit: rejects pending requests, respawns on a fresh transport, bumps generation', async () => {
    let restarted = 0;
    const { client, transports } = makeClient({ onRestarted: () => (restarted += 1) });
    await client.start();

    const hanging = client.request('repo/list', {}); // no responder: stays pending
    transports[0].crash(1);
    await expect(hanging).rejects.toBeInstanceOf(EngineRestartedError);

    await sleep(400); // respawn backoff starts at 250ms
    expect(transports).toHaveLength(2);
    expect(transports[1]).not.toBe(transports[0]);
    expect(restarted).toBe(1);

    // The fresh transport serves requests again.
    transports[1].responders.set('repo/list', (msg) =>
      transports[1].respond(msg.id, { repos: [] }),
    );
    await expect(client.request('repo/list', {})).resolves.toEqual({ repos: [] });
    client.dispose();
  });

  it('picks up changed capabilities from a respawned engine', async () => {
    let changes = 0;
    const { client, transports } = makeClient(
      { onLog: () => undefined },
      (spawnIndex) =>
        new FakeTransport(spawnIndex === 0 ? CAPS_FULL : { gitCli: false, watch: false, threads: false }),
    );
    client.onDidChangeCapabilities(() => (changes += 1));
    await client.start();
    expect(client.capabilities()?.gitCli).toBe(true);

    transports[0].crash(1);
    await sleep(400);
    expect(client.capabilities()).toEqual({ gitCli: false, watch: false, threads: false });
    expect(changes).toBe(2);
    client.dispose();
  });

  it('explicit restart kills the old transport and spawns a new one', async () => {
    const { client, transports } = makeClient();
    await client.start();
    const hanging = client.request('repo/list', {});

    await client.restart();
    await expect(hanging).rejects.toBeInstanceOf(EngineRestartedError);
    expect(transports[0].killed).toBe(true);
    expect(transports).toHaveLength(2);
    client.dispose();
  });

  it('ignores late responses from an orphaned generation', async () => {
    const { client, transports } = makeClient();
    await client.start();
    const hanging = client.request('repo/list', {});
    const staleId = transports[0].sent.find((m) => m.method === 'repo/list')!.id!;

    await client.restart();
    await expect(hanging).rejects.toBeInstanceOf(EngineRestartedError);

    // A stale answer arriving on the dead transport must not resolve anything.
    transports[0].respond(staleId, { repos: [{ repoId: 'stale' }] });
    await sleep(0);

    transports[1].responders.set('repo/list', (msg) =>
      transports[1].respond(msg.id, { repos: [] }),
    );
    await expect(client.request('repo/list', {})).resolves.toEqual({ repos: [] });
    client.dispose();
  });

  it('cancellation rejects locally and tells the engine', async () => {
    const { client, transports } = makeClient();
    await client.start();

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
    const request = client.request('repo/list', {}, token);
    cancelled = true;
    for (const listener of listeners) listener();

    await expect(request).rejects.toSatisfy(
      (e: unknown) => e instanceof EngineError && e.code === ErrorCodes.Cancelled,
    );
    const cancel = transports[0].sent.find((m) => m.method === '$/cancelRequest');
    expect(cancel?.params).toMatchObject({ id: expect.any(Number) });
    client.dispose();
  });

  it('a token already cancelled at request time rejects without sending', async () => {
    const { client, transports } = makeClient();
    await client.start();
    const token = {
      isCancellationRequested: true,
      onCancellationRequested: () => ({ dispose() {} }),
    };
    await expect(client.request('repo/list', {}, token)).rejects.toSatisfy(
      (e: unknown) => e instanceof EngineError && e.code === ErrorCodes.Cancelled,
    );
    expect(transports[0].sent.filter((m) => m.method === 'repo/list')).toHaveLength(0);
    client.dispose();
  });

  it('rejects a request the engine never answers once the deadline passes', async () => {
    const { client } = makeClient({ requestTimeoutMs: 30 });
    await client.start();

    // No responder for repo/list: the engine is wedged but still alive.
    await expect(client.request('repo/list', {})).rejects.toThrow(
      /engine request 'repo\/list' timed out after 30ms/,
    );
    client.dispose();
  });

  it('a reply before the deadline clears the timer and drops the pending entry', async () => {
    const { client, transports } = makeClient({ requestTimeoutMs: 30 });
    await client.start();
    transports[0].responders.set('repo/list', (msg) =>
      transports[0].respond(msg.id, { repos: [] }),
    );

    await expect(client.request('repo/list', {})).resolves.toEqual({ repos: [] });
    await sleep(50); // past the deadline: nothing fires, nothing leaks
    client.dispose();
  });

  it('autoStart spawns the engine on the first request', async () => {
    const { client, transports } = makeClient({ autoStart: true }, () => {
      const transport = new FakeTransport();
      transport.responders.set('repo/list', (msg) => transport.respond(msg.id, { repos: [] }));
      return transport;
    });
    expect(transports).toHaveLength(0); // nothing spawned without start()

    await expect(client.request('repo/list', {})).resolves.toEqual({ repos: [] });
    expect(transports).toHaveLength(1);
    expect(transports[0].sent[0].method).toBe('initialize');
    client.dispose();
  });

  it('autoStart serves requests again after a crash instead of wedging', async () => {
    const { client, transports } = makeClient({ autoStart: true }, () => {
      const transport = new FakeTransport();
      transport.responders.set('repo/list', (msg) =>
        transport.respond(msg.id, { repos: [{ repoId: 'r1' }] }),
      );
      return transport;
    });
    await client.start();

    transports[0].crash(1);
    await sleep(400); // respawn backoff starts at 250ms

    await expect(client.request('repo/list', {})).resolves.toEqual({
      repos: [{ repoId: 'r1' }],
    });
    expect(transports).toHaveLength(2);
    client.dispose();
  });
});
