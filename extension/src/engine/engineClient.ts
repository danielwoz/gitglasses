import { ChildProcess, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import {
  ClientNotifications,
  EngineNotificationMethod,
  EngineNotificationParams,
  ErrorCodes,
  PROTOCOL_VERSION,
  RequestMethod,
  RequestParams,
  RequestResult,
  RpcResponse,
} from '@gitglasses/protocol';
import { frame, FrameParser } from './transport';

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
}

export interface EngineClientOptions {
  enginePath: string;
  logLevel?: string;
  onLog?: (line: string) => void;
  onCrash?: (error: Error) => void;
  /** Called after a respawned engine finished its initialize handshake. */
  onRestarted?: () => void;
}

const BACKOFF_START_MS = 250;
const BACKOFF_MAX_MS = 8000;
const MAX_RESPAWNS = 5;

// Typed JSON-RPC client over a spawned engine process. Crash-safe: pending
// requests reject with EngineRestartedError on respawn (a generation counter
// guarantees no stale result ever resolves), and callers re-query.
export class EngineClient {
  private process: ChildProcess | undefined;
  private parser = new FrameParser();
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private generation = 0;
  private respawns = 0;
  private backoffMs = BACKOFF_START_MS;
  private disposed = false;
  private notificationEmitter = new EventEmitter();
  private ready: Promise<void> | undefined;

  constructor(private readonly options: EngineClientOptions) {}

  start(): Promise<void> {
    this.ready ??= this.spawnEngine();
    return this.ready;
  }

  private async spawnEngine(): Promise<void> {
    this.generation += 1;
    const generation = this.generation;
    const child = spawn(
      this.options.enginePath,
      ['--stdio', '--log-level', this.options.logLevel ?? 'warn'],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    this.process = child;
    this.parser = new FrameParser();

    child.stdout.on('data', (chunk: Buffer) => {
      for (const payload of this.parser.push(chunk)) this.handleMessage(payload);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      this.options.onLog?.(chunk.toString('utf8').trimEnd());
    });
    child.on('exit', (code) => {
      if (this.disposed || generation !== this.generation) return;
      this.failAllPending(new EngineRestartedError());
      this.options.onCrash?.(new Error(`engine exited with code ${code}`));
      this.scheduleRespawn();
    });
    child.on('error', (error) => {
      if (this.disposed || generation !== this.generation) return;
      this.failAllPending(error);
      this.options.onCrash?.(error);
      this.scheduleRespawn();
    });

    const init = await this.request('initialize', { protocolVersion: PROTOCOL_VERSION });
    if (init.protocolVersion !== PROTOCOL_VERSION) {
      throw new EngineError(
        ErrorCodes.InvalidRequest,
        `engine protocol ${init.protocolVersion} != client ${PROTOCOL_VERSION}`,
      );
    }
    this.respawns = 0;
    this.backoffMs = BACKOFF_START_MS;
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
    for (const pending of this.pending.values()) pending.reject(error);
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
      this.notificationEmitter.emit(message.method, message.params);
      return;
    }
    if (typeof message.id !== 'number') return;
    const pending = this.pending.get(message.id);
    if (!pending) return; // cancelled or from a previous generation
    this.pending.delete(message.id);
    if (message.error) {
      pending.reject(new EngineError(message.error.code, message.error.message));
    } else {
      pending.resolve(message.result);
    }
  }

  request<M extends RequestMethod>(
    method: M,
    params: RequestParams<M>,
    token?: CancellationLike,
  ): Promise<RequestResult<M>> {
    const stdin = this.process?.stdin;
    if (!stdin?.writable) {
      return Promise.reject(new EngineRestartedError());
    }
    const id = this.nextId++;
    const generation = this.generation;

    return new Promise<RequestResult<M>>((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        generation,
      });
      const sub = token?.onCancellationRequested(() => {
        // Reject locally right away; tell the engine so it stops working.
        if (this.pending.delete(id)) {
          this.notify('$/cancelRequest', { id });
          reject(new EngineError(ErrorCodes.Cancelled, 'cancelled'));
        }
      });
      if (token?.isCancellationRequested) {
        this.pending.delete(id);
        sub?.dispose();
        reject(new EngineError(ErrorCodes.Cancelled, 'cancelled'));
        return;
      }
      stdin.write(frame(JSON.stringify({ jsonrpc: '2.0', id, method, params })));
    });
  }

  notify<M extends keyof ClientNotifications>(
    method: M,
    params: ClientNotifications[M]['params'],
  ): void {
    if (!this.process?.stdin?.writable) return;
    this.process.stdin.write(frame(JSON.stringify({ jsonrpc: '2.0', method, params })));
  }

  onNotification<M extends EngineNotificationMethod>(
    method: M,
    handler: (params: EngineNotificationParams<M>) => void,
  ): { dispose(): void } {
    this.notificationEmitter.on(method, handler);
    return { dispose: () => this.notificationEmitter.off(method, handler) };
  }

  async restart(): Promise<void> {
    const child = this.process;
    this.generation += 1; // orphan the old process's exit handler
    this.failAllPending(new EngineRestartedError());
    child?.kill('SIGKILL');
    this.respawns = 0;
    this.ready = this.spawnEngine();
    await this.ready;
  }

  dispose(): void {
    this.disposed = true;
    this.failAllPending(new EngineRestartedError());
    this.process?.stdin?.end(); // engine exits when stdin closes
    const child = this.process;
    setTimeout(() => child?.kill('SIGKILL'), 2000).unref?.();
  }
}
