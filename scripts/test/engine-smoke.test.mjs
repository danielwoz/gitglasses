// Runs the engine the way the release smoke test does, against the binary
// built in this checkout. Skipped when no engine has been built.

import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { smokeTestEngine } from '../lib/engine-smoke.mjs';
import { engineBinaryName } from '../lib/targets.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const binary = engineBinaryName(process.platform === 'win32' ? 'win32-x64' : 'linux-x64');
const engine = ['release', 'debug']
  .map((preset) => path.join(root, 'build', preset, 'engine', binary))
  .find((candidate) => existsSync(candidate));
const readJson = (file) => JSON.parse(readFileSync(path.join(root, file), 'utf8'));
const { version } = readJson('extension/package.json');
const { protocolVersion } = readJson('packages/protocol/protocol.schema.json');

describe.skipIf(!engine)('smokeTestEngine', () => {
  it('passes the engine built from this tree', async () => {
    const result = await smokeTestEngine(engine, { version, protocolVersion });
    expect(result).toMatchObject({ engineVersion: version, protocolVersion });
  });

  it('fails when the engine reports another version', async () => {
    await expect(smokeTestEngine(engine, { version: '9.9.9', protocolVersion })).rejects.toThrow(
      `--version printed "${version}", expected 9.9.9`,
    );
  });

  it('fails when the handshake is refused', async () => {
    await expect(smokeTestEngine(engine, { version, protocolVersion: '99.0.0' })).rejects.toThrow(
      /initialize failed/,
    );
  });
});
