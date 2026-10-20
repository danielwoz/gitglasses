// Engine argv for the child-process transport: Restricted Mode is chosen per
// spawn, so a restart after the workspace is trusted starts a full engine.
// Also the transport's behaviour when the engine process dies under it.

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { engineArgs, ProcessTransport } from '../src/node.js';

describe('engineArgs', () => {
  it('starts a full engine by default', () => {
    expect(engineArgs({ enginePath: 'engine' })).toEqual(['--stdio']);
    expect(engineArgs({ enginePath: 'engine', restricted: false })).toEqual(['--stdio']);
  });

  it('passes --restricted when asked to', () => {
    expect(engineArgs({ enginePath: 'engine', restricted: true, logLevel: 'info' })).toEqual([
      '--stdio',
      '--restricted',
      '--log-level',
      'info',
    ]);
  });

  it('reads a restricted getter at each spawn', () => {
    let trusted = false;
    const options = { enginePath: 'engine', restricted: () => !trusted };
    expect(engineArgs(options)).toContain('--restricted');
    trusted = true;
    expect(engineArgs(options)).not.toContain('--restricted');
  });
});

// A stand-in engine that exits at once without reading its stdin.
describe.skipIf(process.platform === 'win32')('ProcessTransport', () => {
  it('survives writing to an engine that exited mid-write', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'gg-rpc-epipe-'));
    try {
      const enginePath = path.join(dir, 'engine.sh');
      writeFileSync(enginePath, '#!/bin/sh\nexit 3\n');
      chmodSync(enginePath, 0o755);
      const logs: string[] = [];
      const transport = new ProcessTransport({ enginePath, onLog: (line) => logs.push(line) });
      const exited = new Promise<number | null>((resolve) =>
        transport.onExit(({ code }) => resolve(code)),
      );
      await transport.start();
      // Far larger than a pipe buffer, so the write is still pending when the
      // engine goes away.
      transport.send(JSON.stringify({ blob: 'x'.repeat(8 * 1024 * 1024) }));
      expect(await exited).toBe(3);
      // Give the stream's asynchronous error a turn to arrive.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(logs.some((line) => /engine stdin: .*EPIPE/.test(line))).toBe(true);
      // Later sends are dropped rather than written to the dead pipe.
      expect(() => transport.send('{}')).not.toThrow();
      transport.kill();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
