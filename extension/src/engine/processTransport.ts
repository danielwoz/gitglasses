// Child-process engine transport: spawns gitglasses-engine and speaks
// Content-Length framing over its stdio.
//
// NODE-ONLY MODULE: this is the only file under src/engine that may import
// node:child_process / node:fs. The future web entry point must never import
// this module — it gets a worker/wasm transport implementing EngineTransport.

import { ChildProcess, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import { frame, FrameParser } from './transport';
import { EngineTransport } from './engineTransport';

export interface ProcessTransportOptions {
  enginePath: string;
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
    const child = spawn(
      this.options.enginePath,
      ['--stdio', '--log-level', this.options.logLevel ?? 'warn'],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
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
    stdin.write(frame(payload));
  }

  kill(): void {
    const child = this.process;
    child?.stdin?.end(); // engine exits when stdin closes
    setTimeout(() => child?.kill('SIGKILL'), 2000).unref?.();
  }
}
