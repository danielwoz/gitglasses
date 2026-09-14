import {
  ClientNotifications,
  EngineCapabilities,
  EngineNotificationMethod,
  EngineNotificationParams,
  ErrorCodes,
  PROTOCOL_VERSION,
  RequestMethod,
  RequestParams,
  RequestResult,
  RpcResponse,
} from '@gitglasses/protocol';
import { EngineTransport } from './transport.js';

export class EngineError extends Error {
  constructor(
    public readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

export class EngineRestartedError extends Error {
  constructor() {
    super('engine restarted; request abandoned');
  }
}

export interface CancellationLike {
  readonly isCancellationRequested: boolean;
  onCancellationRequested(listener: () => void): { dispose(): void };
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  generation: number;
  method: string;
  /** Deadline for this request; cleared wherever it settles. */
  timer: ReturnType<typeof setTimeout>;
  /** Cancellation listener for this request; disposed wherever it settles. */
  cancelSub?: { dispose(): void };
}

export interface EngineClientOptions {
  onLog?: (line: string) => void;
  onCrash?: (error: Error) => void;
  /** Called after a respawned engine finished its initialize handshake. */
  onRestarted?: () => void;
  /** Called when the engine answers a request with MethodNotSupported
   *  (-32003); receives the engine's message verbatim so the UI can surface
   *  it even where call sites would otherwise swallow the rejection. */
  onMethodNotSupported?: (method: string, message: string) => void;
  /** Per-request ceiling; defaults to DEFAULT_REQUEST_TIMEOUT_MS. */
  requestTimeoutMs?: number;
  /** Spawns the engine on the first request, so callers need not call start()
   *  themselves. Off by default: requests before start() reject instead. */
  autoStart?: boolean;
}

const BACKOFF_START_MS = 250;
const BACKOFF_MAX_MS = 8000;
const MAX_RESPAWNS = 5;

/** Default ceiling on a single engine request. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

// Typed JSON-RPC client over a pluggable engine transport. Crash-safe:
// pending requests reject with EngineRestartedError on respawn (a generation
// counter guarantees no stale result ever resolves), and callers re-query.
// Each respawn gets a fresh transport from the injected factory. Every request
// carries a deadline so a wedged engine cannot hold a caller forever.
export class EngineClient {
  private transport: EngineTransport | undefined;
  private transportAlive = false;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private generation = 0;
  private respawns = 0;
  private backoffMs = BACKOFF_START_MS;
  private disposed = false;
  private notificationHandlers = new Map<string, Set<(params: unknown) => void>>();
  private capabilityHandlers = new Set<() => void>();
  private caps: EngineCapabilities | undefined;
  private ready: Promise<void> | undefined;
  private readonly requestTimeoutMs: number;

  constructor(
    private readonly createTransport: () => EngineTransport,
    private readonly options: EngineClientOptions = {},
  ) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  /** Bring the engine up and complete the initialize handshake. Idempotent. */
  start(): Promise<void> {
    this.ready ??= this.spawnEngine();
    return this.ready;
  }

  /** Capability flags from the last successful initialize handshake, or
   *  undefined before the first one. Callers treat undefined as "unknown,
   *  allow" — the engine's -32003 answer is the backstop. */
  capabilities(): EngineCapabilities | undefined {
    return this.caps;
  }

  /** Fires after every successful initialize handshake (startup, restart,
   *  and crash respawn) — capabilities may differ across engine builds. */
  onDidChangeCapabilities(handler: () => void): { dispose(): void } {
    this.capabilityHandlers.add(handler);
    return { dispose: () => this.capabilityHandlers.delete(handler) };
  }

  private async spawnEngine(): Promise<void> {
    if (this.disposed) throw new Error('engine client disposed');
    this.generation += 1;
    const generation = this.generation;
    const transport = this.createTransport();
    this.transport = transport;

    transport.onMessage((payload) => {
      if (this.disposed || generation !== this.generation) return;
      this.handleMessage(payload);
    });
    transport.onExit(({ code }) => {
      if (this.disposed || generation !== this.generation) return;
      this.transportAlive = false;
      this.failAllPending(new EngineRestartedError());
      this.options.onCrash?.(new Error(`engine exited with code ${code}`));
      this.scheduleRespawn();
    });

    await transport.start();
    this.transportAlive = true;

    let init: Awaited<ReturnType<typeof this.send<'initialize'>>>;
    try {
      // send(), not request(): request() may await start(), which is this
      // very promise.
      init = await this.send('initialize', { protocolVersion: PROTOCOL_VERSION });
      if (init.protocolVersion !== PROTOCOL_VERSION) {
        throw new EngineError(
          ErrorCodes.InvalidRequest,
          `engine protocol ${init.protocolVersion} != client ${PROTOCOL_VERSION}`,
        );
      }
    } catch (error) {
      // A failed handshake must not leave the process running with nothing
      // driving it, nor cache the rejected promise so every later call fails.
      this.transportAlive = false;
      try {
        this.transport?.kill();
      } catch {
        // Teardown failures must not mask the handshake error.
      }
      this.ready = undefined;
      throw error;
    }
    this.caps = init.capabilities;
    this.respawns = 0;
    this.backoffMs = BACKOFF_START_MS;
    for (const handler of [...this.capabilityHandlers]) handler();
  }

  private scheduleRespawn(): void {
    if (this.respawns >= MAX_RESPAWNS) {
      this.options.onLog?.('engine crashed too many times; giving up');
      return;
    }
    this.respawns += 1;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, BACKOFF_MAX_MS);
    setTimeout(() => {
      if (this.disposed) return;
      this.ready = this.spawnEngine();
      void this.ready.then(() => this.options.onRestarted?.()).catch(() => undefined);
    }, delay);
  }

  private failAllPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.cancelSub?.dispose();
      pending.reject(error);
    }
    this.pending.clear();
  }

  private handleMessage(payload: string): void {
    let message: RpcResponse & { method?: string; params?: unknown };
    try {
      message = JSON.parse(payload);
    } catch {
      this.options.onLog?.(`unparseable engine frame: ${payload.slice(0, 200)}`);
      return;
    }
    if (message.method !== undefined) {
      const handlers = this.notificationHandlers.get(message.method);
      if (handlers) for (const handler of [...handlers]) handler(message.params);
      return;
    }
    if (typeof message.id !== 'number') return;
    const pending = this.pending.get(message.id);
    if (!pending) return; // cancelled, timed out, or from a previous generation
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    // The token outlives the request (an editor's token can back many calls),
    // so the listener must go or it accumulates for the token's lifetime.
    pending.cancelSub?.dispose();
    if (message.error) {
      if (message.error.code === ErrorCodes.MethodNotSupported) {
        this.options.onMethodNotSupported?.(pending.method, message.error.message);
      }
      pending.reject(new EngineError(message.error.code, message.error.message));
    } else {
      pending.resolve(message.result);
    }
  }

  async request<M extends RequestMethod>(
    method: M,
    params: RequestParams<M>,
    token?: CancellationLike,
  ): Promise<RequestResult<M>> {
    if (this.options.autoStart) await this.start();
    return this.send(method, params, token);
  }

  private send<M extends RequestMethod>(
    method: M,
    params: RequestParams<M>,
    token?: CancellationLike,
  ): Promise<RequestResult<M>> {
    const transport = this.transport;
    if (!transport || !this.transportAlive) {
      return Promise.reject(new EngineRestartedError());
    }
    const id = this.nextId++;
    const generation = this.generation;

    return new Promise<RequestResult<M>>((resolve, reject) => {
      // An engine that wedges without exiting would otherwise leave the call
      // pending forever and grow this.pending without bound: the other
      // rejection paths are transport exit, cancellation and dispose().
      const timer = setTimeout(() => {
        const entry = this.pending.get(id);
        if (!entry) return;
        this.pending.delete(id);
        entry.cancelSub?.dispose();
        reject(
          new Error(`engine request '${method}' timed out after ${this.requestTimeoutMs}ms`),
        );
      }, this.requestTimeoutMs);
      (timer as { unref?: () => void }).unref?.();

      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        generation,
        method,
        timer,
      });
      const sub = token?.onCancellationRequested(() => {
        // Reject locally right away; tell the engine so it stops working.
        if (this.pending.delete(id)) {
          clearTimeout(timer);
          sub?.dispose();
          this.notify('$/cancelRequest', { id });
          reject(new EngineError(ErrorCodes.Cancelled, 'cancelled'));
        }
      });
      const entry = this.pending.get(id);
      if (entry) entry.cancelSub = sub;
      if (token?.isCancellationRequested) {
        this.pending.delete(id);
        clearTimeout(timer);
        sub?.dispose();
        reject(new EngineError(ErrorCodes.Cancelled, 'cancelled'));
        return;
      }
      transport.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    });
  }

  notify<M extends keyof ClientNotifications>(
    method: M,
    params: ClientNotifications[M]['params'],
  ): void {
    if (!this.transport || !this.transportAlive) return;
    this.transport.send(JSON.stringify({ jsonrpc: '2.0', method, params }));
  }

  onNotification<M extends EngineNotificationMethod>(
    method: M,
    handler: (params: EngineNotificationParams<M>) => void,
  ): { dispose(): void } {
    let handlers = this.notificationHandlers.get(method);
    if (!handlers) {
      handlers = new Set();
      this.notificationHandlers.set(method, handlers);
    }
    const untyped = handler as (params: unknown) => void;
    handlers.add(untyped);
    return { dispose: () => this.notificationHandlers.get(method)?.delete(untyped) };
  }

  async restart(): Promise<void> {
    const transport = this.transport;
    this.generation += 1; // orphan the old transport's exit handler
    this.transportAlive = false;
    this.failAllPending(new EngineRestartedError());
    transport?.kill();
    this.respawns = 0;
    this.ready = this.spawnEngine();
    await this.ready;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.failAllPending(new EngineRestartedError());
    this.transport?.kill();
  }
}
