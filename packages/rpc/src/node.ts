// Child-process engine transport: spawns gitglasses-engine and speaks
// Content-Length framing over its stdio.
//
// NODE-ONLY ENTRY POINT: the only module in this package that imports
// node:child_process / node:fs. Browser and wasm hosts import the root entry
// point and supply their own EngineTransport.

import { ChildProcess, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import { frame, FrameParser } from './framing.js';
import { EngineTransport } from './transport.js';

export interface ProcessTransportOptions {
  enginePath: string;
  /** Passed through as `--log-level`; omitted from argv when undefined. */
  logLevel?: string;
  onLog?: (line: string) => void;
}

/** Resolves the engine binary path: an explicitly configured path is trusted
 *  as-is; otherwise the first existing candidate wins. */
export function findEngineBinary(options: {
  configuredPath?: string;
  candidates: string[];
}): string | undefined {
  if (options.configuredPath) return options.configuredPath;
  return options.candidates.find((candidate) => fs.existsSync(candidate));
}

/** Factory for EngineClient: each call yields a fresh transport, so respawns
 *  never reuse a dead process's streams. */
export function createProcessTransportFactory(
  options: ProcessTransportOptions,
): () => EngineTransport {
  return () => new ProcessTransport(options);
}

export class ProcessTransport implements EngineTransport {
  private process: ChildProcess | undefined;
  private parser = new FrameParser();
  private messageHandler: ((payload: string) => void) | undefined;
  private exitHandler: ((info: { code: number | null }) => void) | undefined;
  private exited = false;

  constructor(private readonly options: ProcessTransportOptions) {}

  onMessage(handler: (payload: string) => void): void {
    this.messageHandler = handler;
  }

  onExit(handler: (info: { code: number | null }) => void): void {
    this.exitHandler = handler;
  }

  start(): Promise<void> {
    const args = ['--stdio'];
    if (this.options.logLevel !== undefined) args.push('--log-level', this.options.logLevel);
    const child = spawn(this.options.enginePath, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    this.process = child;
    child.stdout.on('data', (chunk: Buffer) => {
      for (const payload of this.parser.push(chunk)) this.messageHandler?.(payload);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      this.options.onLog?.(chunk.toString('utf8').trimEnd());
    });
    child.on('exit', (code) => this.emitExit(code));
    child.on('error', (error) => {
      // Spawn failures (missing binary, EACCES) surface as an exit without a
      // code; the client's respawn/backoff path handles both uniformly.
      this.options.onLog?.(`engine process error: ${error.message}`);
      this.emitExit(null);
    });
    return Promise.resolve();
  }

  private emitExit(code: number | null): void {
    if (this.exited) return;
    this.exited = true;
    this.exitHandler?.({ code });
  }

  send(payload: string): void {
    const stdin = this.process?.stdin;
    if (!stdin?.writable) return;
    try {
      stdin.write(frame(payload));
    } catch {
      // Process may have exited between the writable check and the write.
    }
  }

  kill(): void {
    const child = this.process;
    child?.stdin?.end(); // engine exits when stdin closes
    // Backstop for an engine that does not; unref'd so the wait never holds
    // the host process open.
    setTimeout(() => child?.kill('SIGKILL'), 2000).unref?.();
  }
}
