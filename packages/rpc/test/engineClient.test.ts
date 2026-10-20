// EngineClient logic tests over an in-memory transport — the handshake,
// request/response, notification, respawn, and cancellation coverage that
// previously only the real-binary integration tests exercised.

import { describe, expect, it, vi } from 'vitest';
import { EngineCapabilities, ErrorCodes, PROTOCOL_VERSION } from '@gitglasses/protocol';
import {
  CRASH_WINDOW_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  EngineClient,
  EngineClientOptions,
  EngineError,
  EngineRestartedError,
  LONG_REQUEST_TIMEOUT_MS,
  MAX_CRASHES_IN_WINDOW,
} from '../src/engineClient.js';
import { EngineTransport } from '../src/transport.js';

const CAPS_FULL: EngineCapabilities = { gitCli: true, watch: true, threads: true };

type Responder = (msg: { id: number; method: string; params: unknown }) => void;

class FakeTransport implements EngineTransport {
  sent: {
    id?: number | string;
    method: string;
    params: unknown;
    result?: unknown;
    error?: { code: number; message: string };
  }[] = [];
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
    if (msg.id !== undefined && msg.method !== undefined) {
      this.responders.get(msg.method)?.(msg as { id: number; method: string; params: unknown });
    }
  }

  kill(): void {
    this.killed = true;
  }

  respond(id: number, result: unknown): void {
    this.deliver(JSON.stringify({ jsonrpc: '2.0', id, result }));
  }

  respondError(id: number, code: number, message: string, data?: unknown): void {
    this.deliver(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message, data } }));
  }

  /** A request from the engine to the client. */
  requestClient(id: string, method: string, params: unknown): void {
    this.deliver(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
  }

  /** The client's answer to the engine request `id`, once sent. */
  answerTo(id: string) {
    return this.sent.find((m) => m.id === id && m.method === undefined);
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

  it('surfaces -32004 through onRestricted, not onMethodNotSupported', async () => {
    const restricted: { method: string; message: string }[] = [];
    const unsupported: string[] = [];
    const { client, transports } = makeClient({
      onRestricted: (method, message) => restricted.push({ method, message }),
      onMethodNotSupported: (method) => unsupported.push(method),
    });
    await client.start();
    transports[0].responders.set('mutate/push', (msg) =>
      transports[0].respondError(msg.id, ErrorCodes.Restricted, 'not available in Restricted Mode'),
    );

    await expect(client.request('mutate/push', { repoId: 'r1' })).rejects.toSatisfy(
      (e: unknown) => e instanceof EngineError && e.code === ErrorCodes.Restricted,
    );
    expect(restricted).toEqual([
      { method: 'mutate/push', message: 'not available in Restricted Mode' },
    ]);
    expect(unsupported).toEqual([]);
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

  // A commit stuck on a signing passphrase runs until the engine's own git
  // timeout, whose error says what git was likely waiting for; the client must
  // still be listening when it arrives.
  it("waits past the engine's git timeout for a method whose git may wait for input", async () => {
    vi.useFakeTimers();
    try {
      const { client, transports } = makeClient();
      await client.start();
      const engineMessage =
        'git timed out after 120000ms; it may have been waiting for input GitGlasses cannot show';
      transports[0].responders.set('mutate/commit', (msg) => {
        setTimeout(
          () => transports[0].respondError(msg.id, ErrorCodes.GitError, engineMessage),
          120_000,
        );
      });

      const commit = client.request('mutate/commit', { repoId: 'r', message: 'm' });
      const outcome = commit.then(
        () => 'resolved',
        (error: Error) => error,
      );
      await vi.advanceTimersByTimeAsync(DEFAULT_REQUEST_TIMEOUT_MS + 1);
      await vi.advanceTimersByTimeAsync(120_000 - DEFAULT_REQUEST_TIMEOUT_MS);
      const error = await outcome;
      expect(error).toBeInstanceOf(EngineError);
      expect((error as EngineError).message).toBe(engineMessage);
      client.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives up on a long-running method only past its own deadline', async () => {
    vi.useFakeTimers();
    try {
      const { client } = makeClient();
      await client.start();
      const deadline = LONG_REQUEST_TIMEOUT_MS['mutate/fetch'] ?? 0;
      expect(deadline).toBeGreaterThan(300_000);

      let settled: unknown;
      const fetch = client.request('mutate/fetch', { repoId: 'r' }).catch((e: Error) => e);
      void fetch.then((value) => (settled = value));
      await vi.advanceTimersByTimeAsync(deadline - 1);
      expect(settled).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      expect(String(await fetch)).toMatch(
        new RegExp(`engine request 'mutate/fetch' timed out after ${deadline}ms`),
      );
      client.dispose();
    } finally {
      vi.useRealTimers();
    }
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

describe('EngineClient crash handling', () => {
  it('stops respawning an engine that keeps crashing, and says so once', async () => {
    const gaveUp: Error[] = [];
    const { client, transports } = makeClient({ onGiveUp: (error) => gaveUp.push(error) });
    await client.start();
    // Each engine finishes its handshake and then dies, as one that crashes
    // on the first real request does.
    for (let crash = 0; crash <= MAX_CRASHES_IN_WINDOW; crash++) {
      transports[transports.length - 1].crash(1);
      await sleep(crash < MAX_CRASHES_IN_WINDOW ? 250 * 2 ** crash + 100 : 50);
    }
    expect(transports).toHaveLength(MAX_CRASHES_IN_WINDOW + 1);
    expect(gaveUp).toHaveLength(1);
    expect(client.hasGivenUp()).toBe(true);
    await sleep(300);
    expect(transports).toHaveLength(MAX_CRASHES_IN_WINDOW + 1);

    // Restart Engine brings it back.
    await client.restart();
    expect(client.hasGivenUp()).toBe(false);
    expect(transports).toHaveLength(MAX_CRASHES_IN_WINDOW + 2);
    client.dispose();
  });

  it('forgets crashes older than the window', async () => {
    vi.useFakeTimers();
    try {
      const gaveUp: Error[] = [];
      const { client, transports } = makeClient({ onGiveUp: (error) => gaveUp.push(error) });
      await client.start();
      for (let crash = 0; crash < MAX_CRASHES_IN_WINDOW * 3; crash++) {
        transports[transports.length - 1].crash(1);
        await vi.advanceTimersByTimeAsync(CRASH_WINDOW_MS / MAX_CRASHES_IN_WINDOW + 1000);
      }
      expect(gaveUp).toHaveLength(0);
      expect(transports.length).toBeGreaterThan(MAX_CRASHES_IN_WINDOW * 3);
      client.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a restart while a respawn is pending leaves one engine, not two', async () => {
    const { client, transports } = makeClient();
    await client.start();
    transports[0].crash(1);
    await client.restart(); // before the 250 ms respawn fires
    await sleep(400);
    expect(transports).toHaveLength(2);
    client.dispose();
    expect(transports[1].killed).toBe(true);
  });

  it('a restart that overtakes another one still resolves', async () => {
    let hang = true;
    const { client, transports } = makeClient({}, () => {
      const transport = new FakeTransport();
      // The second engine never answers initialize, like one wedged at start.
      if (hang && transports.length === 1) transport.responders.delete('initialize');
      return transport;
    });
    await client.start();
    const first = client.restart();
    await sleep(10);
    hang = false;
    await client.restart();
    await expect(first).resolves.toBeUndefined();
    expect(transports[1].killed).toBe(true);
    transports[2].responders.set('repo/list', (msg) => transports[2].respond(msg.id, { repos: [] }));
    await expect(client.request('repo/list', {})).resolves.toEqual({ repos: [] });
    client.dispose();
  });

  it('a timed-out request is cancelled in the engine too', async () => {
    const { client, transports } = makeClient({ requestTimeoutMs: 30 });
    await client.start();
    await expect(client.request('repo/list', {})).rejects.toThrow(/timed out/);
    const request = transports[0].sent.find((m) => m.method === 'repo/list');
    const cancel = transports[0].sent.find((m) => m.method === '$/cancelRequest');
    expect(cancel?.params).toEqual({ id: request?.id });
    client.dispose();
  });

  it('restart and dispose cancel the requests in flight in the engine before closing it', async () => {
    const { client, transports } = makeClient();
    await client.start();
    const beforeRestart = client.request('repo/list', {});
    await client.restart();
    await expect(beforeRestart).rejects.toBeInstanceOf(EngineRestartedError);
    const first = transports[0].sent.find((m) => m.method === 'repo/list');
    expect(transports[0].sent.at(-1)).toMatchObject({
      method: '$/cancelRequest',
      params: { id: first?.id },
    });

    const beforeDispose = client.request('repo/list', {});
    client.dispose();
    await expect(beforeDispose).rejects.toBeInstanceOf(EngineRestartedError);
    const second = transports[1].sent.find((m) => m.method === 'repo/list');
    expect(transports[1].sent.at(-1)).toMatchObject({
      method: '$/cancelRequest',
      params: { id: second?.id },
    });
    expect(transports[1].killed).toBe(true);
  });

  it('carries the error data the engine sends', async () => {
    const { client, transports } = makeClient();
    await client.start();
    transports[0].responders.set('mutate/push', (msg) =>
      transports[0].respondError(msg.id, ErrorCodes.GitError, 'git push failed', {
        kind: 'rejected',
      }),
    );
    await expect(client.request('mutate/push', { repoId: 'r' })).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof EngineError && (e.data as { kind?: string } | undefined)?.kind === 'rejected',
    );
    client.dispose();
  });
});

describe('EngineClient answering the engine', () => {
  const prompt = (requestId?: number) => ({
    kind: 'password',
    prompt: "Password for 'https://example.com': ",
    secret: true,
    interactive: true,
    ...(requestId !== undefined ? { requestId } : {}),
  });

  it('declares what it can answer in initialize', async () => {
    const { client, transports } = makeClient({ clientCapabilities: { askpass: true } });
    await client.start();
    expect(transports[0].sent[0].params).toMatchObject({ clientCapabilities: { askpass: true } });
    client.dispose();
  });

  it('answers an engine request with the registered handler', async () => {
    const { client, transports } = makeClient();
    await client.start();
    const seen: unknown[] = [];
    client.onRequest('ui/askpass', async (params) => {
      seen.push(params);
      return { value: 's3cret' };
    });
    transports[0].requestClient('e1', 'ui/askpass', prompt());
    await sleep(0);
    await sleep(0);
    expect(seen).toEqual([prompt()]);
    expect(transports[0].answerTo('e1')).toMatchObject({ result: { value: 's3cret' } });
    client.dispose();
  });

  it('refuses a request it has no handler for', async () => {
    const { client, transports } = makeClient();
    await client.start();
    transports[0].requestClient('e2', 'ui/askpass', prompt());
    await sleep(0);
    expect(transports[0].answerTo('e2')?.error?.code).toBe(ErrorCodes.MethodNotFound);
    client.dispose();
  });

  it('withdraws the handler when the engine cancels the request', async () => {
    const { client, transports } = makeClient();
    await client.start();
    let withdrawn = false;
    client.onRequest(
      'ui/askpass',
      (_params, token) =>
        new Promise((resolve) => {
          token.onCancellationRequested(() => {
            withdrawn = true;
            resolve({ cancelled: true });
          });
        }),
    );
    transports[0].requestClient('e3', 'ui/askpass', prompt());
    await sleep(0);
    transports[0].notifyClient('ui/askpassCancelled', { id: 'e3' });
    await sleep(0);
    await sleep(0);
    expect(withdrawn).toBe(true);
    client.dispose();
  });

  // The user may take minutes to type a password; the push waiting on it must
  // not time out in the meantime.
  it('stops the deadline of the request a prompt belongs to while it is open', async () => {
    vi.useFakeTimers();
    try {
      const { client, transports } = makeClient({ requestTimeoutMs: 1000 });
      await client.start();
      let answer: (value: { value: string }) => void = () => undefined;
      client.onRequest(
        'ui/askpass',
        () => new Promise((resolve) => (answer = resolve as typeof answer)),
      );
      let settled: unknown;
      const push = client
        .request('repo/list', {})
        .then((value) => (settled = value))
        .catch((error: Error) => (settled = error));
      const id = transports[0].sent.find((m) => m.method === 'repo/list')!.id as number;
      // The prompt arrives at once, with the whole second still to run.
      transports[0].requestClient('e4', 'ui/askpass', prompt(id));
      await vi.advanceTimersByTimeAsync(10_000);
      expect(settled).toBeUndefined();
      answer({ value: 'pw' });
      await vi.advanceTimersByTimeAsync(900);
      expect(settled).toBeUndefined();
      await vi.advanceTimersByTimeAsync(200);
      expect(String(settled)).toMatch(/timed out/);
      await push;
      client.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});
