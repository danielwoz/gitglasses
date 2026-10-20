// Finds a Node that can run the bundled MCP server: the editor's own binary
// with ELECTRON_RUN_AS_NODE, which every desktop install has, or else `node`
// on PATH for builds where policy turns that switch off.

import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import {
  findOnPath,
  isNodeVersionOutput,
  isSupportedNodeVersion,
  type NodeRuntime,
} from './mcpLogic';

const PROBE_TIMEOUT_MS = 10_000;

/** What `command args` printed on stdout, or '' when it failed to run. */
function output(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { env, timeout: PROBE_TIMEOUT_MS, windowsHide: true, encoding: 'utf8' },
      (error, stdout) => resolve(error ? '' : stdout),
    );
  });
}

function isFile(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

export interface RuntimeOptions {
  execPath: string;
  /** True when execPath is an Electron binary rather than plain Node. */
  electron: boolean;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  /** Runs a command and returns its stdout; injectable for tests. */
  run?: (command: string, args: string[], env: NodeJS.ProcessEnv) => Promise<string>;
  isFile?: (candidate: string) => boolean;
}

/**
 * `resolve` with its answer kept for the session once it finds a runtime.
 * Callers that arrive while a probe runs share it. A probe that finds none
 * (or timed out on a busy machine) is not kept, so the next caller probes
 * again.
 */
export function memoizeRuntime(
  resolve: () => Promise<NodeRuntime | undefined>,
): () => Promise<NodeRuntime | undefined> {
  let pending: Promise<NodeRuntime | undefined> | undefined;
  return () => {
    if (!pending) {
      const probe = resolve().then(
        (runtime) => {
          if (!runtime && pending === probe) pending = undefined;
          return runtime;
        },
        (error: unknown) => {
          if (pending === probe) pending = undefined;
          throw error;
        },
      );
      pending = probe;
    }
    return pending;
  };
}

/**
 * The runtime for the server, or undefined when there is none. `--version`
 * is the probe because it is harmless either way: with ELECTRON_RUN_AS_NODE
 * honoured it prints Node's version, and an editor that ignores the variable
 * prints its own version and exits without opening a window. A remote
 * extension host already runs on plain Node and needs no probe.
 */
export async function resolveNodeRuntime(
  options: RuntimeOptions,
): Promise<NodeRuntime | undefined> {
  if (!options.electron) return { command: options.execPath, electron: false };
  const run = options.run ?? output;
  const asNode = { ...options.env, ELECTRON_RUN_AS_NODE: '1' };
  if (isNodeVersionOutput(await run(options.execPath, ['--version'], asNode))) {
    return { command: options.execPath, electron: true };
  }
  const node = findOnPath('node', {
    env: options.env,
    platform: options.platform,
    isFile: options.isFile ?? isFile,
  });
  if (node && isSupportedNodeVersion(await run(node, ['--version'], options.env))) {
    return { command: node, electron: false };
  }
  return undefined;
}
