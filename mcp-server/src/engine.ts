// Engine binary resolution for the MCP server, plus the wiring that turns a
// resolved path into a shared EngineClient. The JSON-RPC client, framing and
// process transport live in @gitglasses/rpc.

import { existsSync } from 'node:fs';
import path from 'node:path';
import { EngineClient } from '@gitglasses/rpc';
import { ProcessTransport } from '@gitglasses/rpc/node';

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

export const ENGINE_NOT_FOUND_MESSAGE =
  'gitglasses-engine binary not found; set GITGLASSES_ENGINE or add it to PATH';

export interface CreateEngineClientOptions {
  /** Resolved engine binary path; undefined defers the failure to first use. */
  enginePath: string | undefined;
  onLog?: (line: string) => void;
  /** Per-request ceiling; defaults to the client's own default. */
  requestTimeoutMs?: number;
}

/**
 * EngineClient over a spawned `gitglasses-engine --stdio`. Spawns lazily on
 * the first request and respawns with backoff if the engine dies, so a crash
 * does not take the server down with it.
 */
export function createEngineClient(options: CreateEngineClientOptions): EngineClient {
  return new EngineClient(
    () => {
      if (!options.enginePath) throw new Error(ENGINE_NOT_FOUND_MESSAGE);
      return new ProcessTransport({ enginePath: options.enginePath, onLog: options.onLog });
    },
    {
      autoStart: true,
      onLog: options.onLog,
      onCrash: (error) => options.onLog?.(error.message),
      requestTimeoutMs: options.requestTimeoutMs,
    },
  );
}
