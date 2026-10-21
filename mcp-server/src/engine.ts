// Engine binary resolution for the MCP server, plus the wiring that turns a
// resolved path into a shared EngineClient. The JSON-RPC client, framing and
// process transport live in @gitglasses/rpc.

import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
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
  /** Engine packages to look for, in order. Defaults to this platform's. */
  enginePackages?: readonly string[];
  /**
   * Directory of an installed npm package, or undefined when it is not
   * installed. Defaults to Node's resolution from the package root.
   */
  resolvePackage?: (name: string) => string | undefined;
}

/** True on a Linux whose C library is musl (Alpine) rather than glibc. */
export function isMuslLibc(): boolean {
  if (process.platform !== 'linux') return false;
  const report = process.report?.getReport() as
    { header?: { glibcVersionRuntime?: string } } | undefined;
  return report?.header?.glibcVersionRuntime === undefined;
}

/**
 * The npm packages that carry the engine for a platform, best first:
 * `@gitglasses/engine-<platform>-<arch>`, with a `-musl` suffix for the
 * statically linked Alpine build. That build runs on any Linux, so a glibc
 * system falls back to it; the glibc build does not run on musl.
 */
export function enginePackageNames(
  platform: string = process.platform,
  arch: string = process.arch,
  musl: boolean = isMuslLibc(),
): string[] {
  const name = `@gitglasses/engine-${platform}-${arch}`;
  if (platform !== 'linux') return [name];
  return musl ? [`${name}-musl`] : [name, `${name}-musl`];
}

/** Where Node would load package `name` from, as seen from `packageRoot`. */
function installedPackageDir(packageRoot: string, name: string): string | undefined {
  try {
    const require = createRequire(path.join(packageRoot, 'package.json'));
    return path.dirname(require.resolve(`${name}/package.json`));
  } catch {
    return undefined;
  }
}

/**
 * Executable name for this platform: the candidate paths below are probed
 * with it, and on Windows it carries the .exe suffix.
 */
export function engineBinaryName(platform: string = process.platform): string {
  return platform === 'win32' ? 'gitglasses-engine.exe' : 'gitglasses-engine';
}

/**
 * Locate the engine binary: the GITGLASSES_ENGINE env var wins, then the
 * engine package npm installed for this platform (an optional dependency of
 * gitglasses-mcp), then the monorepo release build next to this package, then
 * a PATH search.
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
  const resolvePackage =
    options.resolvePackage ?? ((name: string) => installedPackageDir(packageRoot, name));
  for (const name of options.enginePackages ?? enginePackageNames()) {
    const dir = resolvePackage(name);
    if (dir === undefined) continue;
    const candidate = path.join(dir, 'bin', binary);
    if (exists(candidate)) return candidate;
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
  'gitglasses-engine binary not found: no @gitglasses/engine-* package is installed for this ' +
  'platform; set GITGLASSES_ENGINE or add the engine to PATH';

export interface CreateEngineClientOptions {
  /** Resolved engine binary path; undefined defers the failure to first use. */
  enginePath: string | undefined;
  /** Starts the engine with --restricted: it runs no git and changes nothing. */
  restricted?: boolean;
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
      return new ProcessTransport({
        enginePath: options.enginePath,
        restricted: options.restricted,
        onLog: options.onLog,
      });
    },
    {
      autoStart: true,
      onLog: options.onLog,
      onCrash: (error) => options.onLog?.(error.message),
      requestTimeoutMs: options.requestTimeoutMs,
    },
  );
}
