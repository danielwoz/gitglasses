import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveEnginePath } from '../src/engine.js';

const packageRoot = '/repo/mcp-server';
const localBuild = path.resolve('/repo/build/release/engine/gitglasses-engine');

describe('resolveEnginePath', () => {
  it('prefers the GITGLASSES_ENGINE environment variable', () => {
    const resolved = resolveEnginePath({
      env: { GITGLASSES_ENGINE: '/opt/engine/gitglasses-engine', PATH: '/usr/bin' },
      exists: () => true,
      packageRoot,
    });
    expect(resolved).toBe('/opt/engine/gitglasses-engine');
  });

  it('falls back to the monorepo release build next to the package', () => {
    const resolved = resolveEnginePath({
      env: { PATH: '/usr/bin' },
      exists: (candidate) => candidate === localBuild,
      packageRoot,
    });
    expect(resolved).toBe(localBuild);
  });

  it('searches PATH when neither env var nor local build exists', () => {
    const hit = path.join('/home/u/bin', 'gitglasses-engine');
    const resolved = resolveEnginePath({
      env: { PATH: ['/usr/bin', '/home/u/bin'].join(':') },
      exists: (candidate) => candidate === hit,
      packageRoot,
      pathSeparator: ':',
    });
    expect(resolved).toBe(hit);
  });

  it('returns undefined when the binary is nowhere to be found', () => {
    const resolved = resolveEnginePath({
      env: { PATH: '/usr/bin:/usr/local/bin' },
      exists: () => false,
      packageRoot,
      pathSeparator: ':',
    });
    expect(resolved).toBeUndefined();
  });
});
