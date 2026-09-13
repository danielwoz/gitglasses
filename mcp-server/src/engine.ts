// Standalone client for the gitglasses-engine JSON-RPC protocol: engine
// binary resolution, Content-Length framing, initialize handshake, and
// request/notification correlation over a spawned `gitglasses-engine --stdio`.

import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  ErrorCodes,
  PROTOCOL_VERSION,
  type EngineNotificationMethod,
  type EngineNotificationParams,
  type RequestMethod,
  type RequestParams,
  type RequestResult,
  type RpcResponse,
} from '@gitglasses/protocol';

// --- Content-Length framing -------------------------------------------------

export class FrameParser {
  private buffer = Buffer.alloc(0);
  private expected = -1;

  /** Feed raw bytes; returns any complete message payloads. */
  push(chunk: Buffer): string[] {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const messages: string[] = [];
    for (;;) {
      if (this.expected < 0) {
        const headerEnd = this.buffer.indexOf('\r\n\r\n');
        if (headerEnd < 0) break;
        const header = this.buffer.subarray(0, headerEnd).toString('utf8');
        const match = /Content-Length:\s*(\d+)/i.exec(header);
        this.buffer = this.buffer.subarray(headerEnd + 4);
        if (!match) continue; // skip malformed header block
        this.expected = Number(match[1]);
      }
      if (this.buffer.length < this.expected) break;
      messages.push(this.buffer.subarray(0, this.expected).toString('utf8'));
      this.buffer = this.buffer.subarray(this.expected);
      this.expected = -1;
    }
    return messages;
  }
}

export function frame(payload: string): Buffer {
  const body = Buffer.from(payload, 'utf8');
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]);
}

// --- Engine binary resolution -----------------------------------------------

export interface EnginePathOptions {
  /** Environment map (GITGLASSES_ENGINE, PATH). Defaults to process.env. */
  env?: Record<string, string | undefined>;
  /** File-existence probe, injectable for tests. */
  exists?: (candidate: string) => boolean;
  /** Root of the gitglasses-mcp package. Defaults to this module's package. */
  packageRoot?: string;
  /** PATH separator, injectable for tests. Defaults to the platform's. */
  pathSeparator?: string;
  /** Binary filename, injectable for tests. Defaults to the platform's. */
  binaryName?: string;
}

/**
 * Executable name for this platform. Windows needs the .exe suffix or none of
 * the candidate paths match and the server reports no engine at all.
 */
export function engineBinaryName(platform: string = process.platform): string {
  return platform === 'win32' ? 'gitglasses-engine.exe' : 'gitglasses-engine';
}

/**
 * Locate the engine binary: the GITGLASSES_ENGINE env var wins, then the
 * monorepo release build next to this package, then a PATH search.
 */
export function resolveEnginePath(options: EnginePathOptions = {}): string | undefined {
  const env = options.env ?? process.env;
  const exists = options.exists ?? existsSync;
  const packageRoot = options.packageRoot ?? path.resolve(import.meta.dirname, '..');
  const separator = options.pathSeparator ?? path.delimiter;
  const binary = options.binaryName ?? engineBinaryName();

  if (env.GITGLASSES_ENGINE) {
    return env.GITGLASSES_ENGINE;
  }
  const local = path.resolve(packageRoot, '..', 'build', 'release', 'engine', binary);
  if (exists(local)) {
    return local;
  }
  for (const dir of (env.PATH ?? '').split(separator)) {
    if (dir === '') continue;
    const candidate = path.join(dir, binary);
    if (exists(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

// --- JSON-RPC client ---------------------------------------------------------

export class EngineError extends Error {
  constructor(
    public readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  /** Cleared wherever the request settles, so a reply cancels the timeout. */
  timer: NodeJS.Timeout;
}

/** Default ceiling on a single engine request. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

export interface EngineClientOptions {
  /** Resolved engine binary path; undefined defers the failure to first use. */
  enginePath: string | undefined;
  onLog?: (line: string) => void;
  /** Per-request ceiling; defaults to DEFAULT_REQUEST_TIMEOUT_MS. */
  requestTimeoutMs?: number;
}

/**
 * Typed JSON-RPC client over a spawned engine process. Spawns lazily on first
 * request and performs the initialize handshake before resolving any request.
 */
export class EngineClient {
  private process: ChildProcess | undefined;
  private parser = new FrameParser();
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private notificationEmitter = new EventEmitter();
  private ready: Promise<void> | undefined;
  private disposed = false;

  private readonly requestTimeoutMs: number;

  constructor(private readonly options: EngineClientOptions) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  /** Spawn the engine and complete the initialize handshake. Idempotent. */
  start(): Promise<void> {
    this.ready ??= this.spawnEngine();
    return this.ready;
  }

  private async spawnEngine(): Promise<void> {
    if (this.disposed) throw new Error('engine client disposed');
    const enginePath = this.options.enginePath;
    if (!enginePath) {
      throw new Error(
        'gitglasses-engine binary not found; set GITGLASSES_ENGINE or add it to PATH',
      );
    }
    const child = spawn(enginePath, ['--stdio'], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.process = child;
    this.parser = new FrameParser();

    child.stdout.on('data', (chunk: Buffer) => {
      for (const payload of this.parser.push(chunk)) this.handleMessage(payload);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      this.options.onLog?.(chunk.toString('utf8').trimEnd());
    });
    child.on('exit', (code) => {
      if (this.disposed) return;
      this.failAllPending(new Error(`engine exited with code ${code}`));
    });
    child.on('error', (error) => {
      this.failAllPending(error);
    });

    const init = await this.send('initialize', { protocolVersion: PROTOCOL_VERSION });
    if (init.protocolVersion !== PROTOCOL_VERSION) {
      throw new EngineError(
        ErrorCodes.InvalidRequest,
        `engine protocol ${init.protocolVersion} != client ${PROTOCOL_VERSION}`,
      );
    }
  }

  private failAllPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
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
      this.notificationEmitter.emit(message.method, message.params);
      return;
    }
    if (typeof message.id !== 'number') return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) {
      pending.reject(new EngineError(message.error.code, message.error.message));
    } else {
      pending.resolve(message.result);
    }
  }

  /** Ensure the engine is running, then issue a request. */
  async request<M extends RequestMethod>(
    method: M,
    params: RequestParams<M>,
  ): Promise<RequestResult<M>> {
    await this.start();
    return this.send(method, params);
  }

  private send<M extends RequestMethod>(
    method: M,
    params: RequestParams<M>,
  ): Promise<RequestResult<M>> {
    const stdin = this.process?.stdin;
    if (!stdin?.writable) {
      return Promise.reject(new Error('engine is not running'));
    }
    const id = this.nextId++;
    return new Promise<RequestResult<M>>((resolve, reject) => {
      // An engine that wedges without exiting would otherwise leave the tool
      // call pending forever and grow this.pending without bound: the only
      // other rejection paths are process exit/error and dispose().
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          reject(new Error(`engine request '${method}' timed out after ${this.requestTimeoutMs}ms`));
        }
      }, this.requestTimeoutMs);
      timer.unref?.();

      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });
      stdin.write(frame(JSON.stringify({ jsonrpc: '2.0', id, method, params })));
    });
  }

  onNotification<M extends EngineNotificationMethod>(
    method: M,
    handler: (params: EngineNotificationParams<M>) => void,
  ): { dispose(): void } {
    this.notificationEmitter.on(method, handler);
    return { dispose: () => this.notificationEmitter.off(method, handler) };
  }

  /** Close the engine's stdin (it exits on EOF); hard-kill as a fallback. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.failAllPending(new Error('engine client disposed'));
    this.process?.stdin?.end();
    const child = this.process;
    setTimeout(() => child?.kill('SIGKILL'), 2000).unref?.();
  }
}
