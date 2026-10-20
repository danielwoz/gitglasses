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
  RpcError,
} from '@gitglasses/protocol';
import { EngineTransport } from './transport.js';

export class EngineError extends Error {
  constructor(
    public readonly code: number,
    message: string,
    /** The error's `data` member; for GitError, a GitErrorData. */
    public readonly data?: unknown,
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
  timer: ReturnType<typeof setTimeout> | undefined;
  /** When the deadline passes (Date.now() time). */
  deadline: number;
  /** Cancellation listener for this request; disposed wherever it settles. */
  cancelSub?: { dispose(): void };
}

export interface EngineClientOptions {
  onLog?: (line: string) => void;
  onCrash?: (error: Error) => void;
  /** Called when the engine crashed too often in too short a time and is
   *  not respawned any more; restart() starts it again. */
  onGiveUp?: (error: Error) => void;
  /** Called after a respawned engine finished its initialize handshake. */
  onRestarted?: () => void;
  /** Called when the engine answers a request with MethodNotSupported
   *  (-32003); receives the engine's message verbatim, so the UI can surface
   *  it even where the call site swallows the rejection. */
  onMethodNotSupported?: (method: string, message: string) => void;
  /** Called when a Restricted Mode engine refuses a request with Restricted
   *  (-32004), with the engine's message verbatim. */
  onRestricted?: (method: string, message: string) => void;
  /** Per-request ceiling; defaults to DEFAULT_REQUEST_TIMEOUT_MS. Methods in
   *  LONG_REQUEST_TIMEOUT_MS wait at least as long as listed there. */
  requestTimeoutMs?: number;
  /** Spawns the engine on the first request, so callers need not call start()
   *  themselves. Off by default: requests before start() reject instead. */
  autoStart?: boolean;
}

const BACKOFF_START_MS = 250;
const BACKOFF_MAX_MS = 8000;

/** Crashes tolerated within CRASH_WINDOW_MS; one more and the engine is not
 *  respawned until restart(). Counted whether or not the crashed engine had
 *  finished its handshake, so an engine that dies on some request right after
 *  starting is caught as well as one that cannot start. */
export const MAX_CRASHES_IN_WINDOW = 3;
export const CRASH_WINDOW_MS = 60_000;

/** Default ceiling on a single engine request. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

// The engine's own ceilings on the git it runs (kDefaultGitTimeout and
// kNetworkGitTimeout in engine/src/exec/git_process.h), and how long past them
// the client still waits for the engine's answer.
const ENGINE_GIT_TIMEOUT_MS = 120_000;
const ENGINE_NETWORK_GIT_TIMEOUT_MS = 300_000;
const ENGINE_TIMEOUT_MARGIN_MS = 15_000;

/**
 * Deadlines for methods whose git may legitimately outlast
 * DEFAULT_REQUEST_TIMEOUT_MS: a fetch over a slow link, or a commit waiting on
 * a signing passphrase. The engine bounds these itself and its error says what
 * git was likely waiting for, so the client waits until just past the
 * engine's bound rather than giving up first with a bare timeout.
 */
export const LONG_REQUEST_TIMEOUT_MS: Partial<Record<RequestMethod, number>> = {
  'mutate/fetch': ENGINE_NETWORK_GIT_TIMEOUT_MS + ENGINE_TIMEOUT_MARGIN_MS,
  'mutate/pull': ENGINE_NETWORK_GIT_TIMEOUT_MS + ENGINE_TIMEOUT_MARGIN_MS,
  'mutate/push': ENGINE_NETWORK_GIT_TIMEOUT_MS + ENGINE_TIMEOUT_MARGIN_MS,
  'mutate/commit': ENGINE_GIT_TIMEOUT_MS + ENGINE_TIMEOUT_MARGIN_MS,
  'mutate/merge': ENGINE_GIT_TIMEOUT_MS + ENGINE_TIMEOUT_MARGIN_MS,
  'mutate/cherryPick': ENGINE_GIT_TIMEOUT_MS + ENGINE_TIMEOUT_MARGIN_MS,
  'mutate/revert': ENGINE_GIT_TIMEOUT_MS + ENGINE_TIMEOUT_MARGIN_MS,
  'mutate/sequencer': ENGINE_GIT_TIMEOUT_MS + ENGINE_TIMEOUT_MARGIN_MS,
  'rebase/start': ENGINE_GIT_TIMEOUT_MS + ENGINE_TIMEOUT_MARGIN_MS,
  'rebase/continue': ENGINE_GIT_TIMEOUT_MS + ENGINE_TIMEOUT_MARGIN_MS,
};

interface InboundMessage {
  id?: number | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: RpcError;
}

// Typed JSON-RPC client over a pluggable engine transport. Crash-safe:
// pending requests reject with EngineRestartedError on respawn (a generation
// counter guarantees no stale result ever resolves), and callers re-query.
// Each respawn gets a fresh transport from the injected factory; an engine
// that keeps crashing is given up on (onGiveUp) until restart(). Every request
// carries a deadline so a wedged engine cannot hold a caller forever.
export class EngineClient {
  private transport: EngineTransport | undefined;
  private transportAlive = false;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private generation = 0;
  private backoffMs = BACKOFF_START_MS;
  private crashTimes: number[] = [];
  private respawnTimer: ReturnType<typeof setTimeout> | undefined;
  private gaveUp = false;
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

  /** Bring the engine up and complete the initialize handshake. Idempotent.
   *  After the client gave up on a crashing engine, a start() once the
   *  crashes have aged out of the window tries again. */
  start(): Promise<void> {
    if (this.gaveUp && !this.recentCrashes()) {
      this.gaveUp = false;
      this.backoffMs = BACKOFF_START_MS;
      this.ready = this.spawnEngine();
    }
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

  private recentCrashes(): number {
    const now = Date.now();
    this.crashTimes = this.crashTimes.filter((time) => now - time < CRASH_WINDOW_MS);
    return this.crashTimes.length;
  }

  private async spawnEngine(): Promise<void> {
    if (this.disposed) throw new Error('engine client disposed');
    this.generation += 1;
    const generation = this.generation;
    // Whatever transport a previous generation left behind is done for.
    const previous = this.transport;
    const transport = this.createTransport();
    this.transport = transport;
    if (previous && previous !== transport) previous.kill();

    transport.onMessage((payload) => {
      if (this.disposed || generation !== this.generation) return;
      this.handleMessage(payload);
    });
    transport.onExit(({ code }) => {
      if (this.disposed || generation !== this.generation) return;
      this.transportAlive = false;
      this.failAllPending(new EngineRestartedError());
      const error = new Error(`engine exited with code ${code}`);
      this.options.onCrash?.(error);
      this.scheduleRespawn(error);
    });

    await transport.start();
    if (generation === this.generation) this.transportAlive = true;

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
      // A failed handshake tears this process down. When this generation is
      // still the current one the cached promise is cleared too, so a later
      // start() spawns a fresh engine; a newer generation keeps its own.
      if (generation === this.generation) {
        this.transportAlive = false;
        this.ready = undefined;
      }
      try {
        transport.kill();
      } catch {
        // Teardown failures must not mask the handshake error.
      }
      throw error;
    }
    if (generation !== this.generation) throw new EngineRestartedError();
    this.caps = init.capabilities;
    this.backoffMs = BACKOFF_START_MS;
    for (const handler of [...this.capabilityHandlers]) handler();
  }

  private scheduleRespawn(error: Error): void {
    this.crashTimes.push(Date.now());
    const crashes = this.recentCrashes();
    if (crashes > MAX_CRASHES_IN_WINDOW) {
      this.gaveUp = true;
      this.options.onLog?.(
        `engine crashed ${crashes} times within ${CRASH_WINDOW_MS / 1000}s; not restarting it`,
      );
      this.options.onGiveUp?.(error);
      return;
    }
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, BACKOFF_MAX_MS);
    this.respawnTimer = setTimeout(() => {
      this.respawnTimer = undefined;
      if (this.disposed) return;
      this.ready = this.spawnEngine();
      void this.ready.then(() => this.options.onRestarted?.()).catch(() => undefined);
    }, delay);
  }

  private clearRespawn(): void {
    if (this.respawnTimer !== undefined) clearTimeout(this.respawnTimer);
    this.respawnTimer = undefined;
  }

  private failAllPending(error: Error): void {
    for (const pending of this.pending.values()) {
      if (pending.timer !== undefined) clearTimeout(pending.timer);
      pending.cancelSub?.dispose();
      pending.reject(error);
    }
    this.pending.clear();
  }

  private handleMessage(payload: string): void {
    let message: InboundMessage;
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
    if (pending.timer !== undefined) clearTimeout(pending.timer);
    // The token outlives the request (an editor's token can back many calls),
    // so its listener is disposed with the request it belonged to.
    pending.cancelSub?.dispose();
    if (message.error) {
      if (message.error.code === ErrorCodes.MethodNotSupported) {
        this.options.onMethodNotSupported?.(pending.method, message.error.message);
      } else if (message.error.code === ErrorCodes.Restricted) {
        this.options.onRestricted?.(pending.method, message.error.message);
      }
      pending.reject(
        new EngineError(message.error.code, message.error.message, message.error.data),
      );
    } else {
      pending.resolve(message.result);
    }
  }

  /** Starts (or restarts) request `id`'s deadline, `ms` from now. */
  private armDeadline(id: number, pending: Pending, ms: number): void {
    pending.deadline = Date.now() + ms;
    const timeoutMs =
      LONG_REQUEST_TIMEOUT_MS[pending.method as RequestMethod] ?? this.requestTimeoutMs;
    const total = Math.max(this.requestTimeoutMs, timeoutMs);
    // The rejection path for an engine that wedges without ever exiting;
    // the others are transport exit, cancellation and dispose().
    pending.timer = setTimeout(() => {
      if (this.pending.get(id) !== pending) return;
      this.pending.delete(id);
      pending.cancelSub?.dispose();
      // The engine may still be working on it; nobody wants the answer now.
      this.notify('$/cancelRequest', { id });
      pending.reject(new Error(`engine request '${pending.method}' timed out after ${total}ms`));
    }, ms);
    // Unref'd so a pending deadline never holds the host process alive; the
    // optional call covers runtimes whose setTimeout returns a plain number.
    (pending.timer as { unref?: () => void }).unref?.();
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

    const timeoutMs = Math.max(this.requestTimeoutMs, LONG_REQUEST_TIMEOUT_MS[method] ?? 0);

    return new Promise<RequestResult<M>>((resolve, reject) => {
      const pending: Pending = {
        resolve: resolve as (value: unknown) => void,
        reject,
        generation,
        method,
        timer: undefined,
        deadline: 0,
      };
      this.pending.set(id, pending);
      this.armDeadline(id, pending, timeoutMs);
      const sub = token?.onCancellationRequested(() => {
        // Reject locally right away; tell the engine so it stops working.
        if (this.pending.get(id) === pending) {
          this.pending.delete(id);
          if (pending.timer !== undefined) clearTimeout(pending.timer);
          sub?.dispose();
          this.notify('$/cancelRequest', { id });
          reject(new EngineError(ErrorCodes.Cancelled, 'cancelled'));
        }
      });
      pending.cancelSub = sub;
      if (token?.isCancellationRequested) {
        this.pending.delete(id);
        if (pending.timer !== undefined) clearTimeout(pending.timer);
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

  /** True after the engine crashed too often and respawning stopped. */
  hasGivenUp(): boolean {
    return this.gaveUp;
  }

  /** Kills the engine and starts a fresh one; requests in flight reject
   *  with EngineRestartedError. Also starts an engine the client gave up on.
   *  Resolves once an engine is up, even when another restart overtook this
   *  one. */
  async restart(): Promise<void> {
    this.clearRespawn();
    const transport = this.transport;
    this.generation += 1; // orphan the old transport's exit handler
    this.transportAlive = false;
    this.failAllPending(new EngineRestartedError());
    transport?.kill();
    this.crashTimes = [];
    this.gaveUp = false;
    this.backoffMs = BACKOFF_START_MS;
    this.ready = this.spawnEngine();
    for (;;) {
      const ready: Promise<void> | undefined = this.ready;
      try {
        await ready;
        return;
      } catch (error) {
        // A later restart replaced this spawn: wait for that one instead.
        if (this.ready === ready || this.ready === undefined || this.disposed) throw error;
      }
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearRespawn();
    this.failAllPending(new EngineRestartedError());
    this.transport?.kill();
  }
}
