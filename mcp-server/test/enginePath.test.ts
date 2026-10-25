import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { enginePackageNames, resolveEnginePath, engineBinaryName } from '../src/engine.js';

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

  it('finds the engine package npm installed for this platform', () => {
    const installed = path.join('/app/node_modules/@gitglasses/engine-linux-x64');
    const resolved = resolveEnginePath({
      env: { PATH: '/usr/bin' },
      exists: () => true,
      packageRoot,
      binaryName: 'gitglasses-engine',
      enginePackages: ['@gitglasses/engine-linux-x64', '@gitglasses/engine-linux-x64-musl'],
      resolvePackage: (name) => (name === '@gitglasses/engine-linux-x64' ? installed : undefined),
    });
    expect(resolved).toBe(path.join(installed, 'bin', 'gitglasses-engine'));
  });

  it('falls back to the static musl engine package on a glibc Linux', () => {
    const musl = path.join('/app/node_modules/@gitglasses/engine-linux-x64-musl');
    const resolved = resolveEnginePath({
      env: { PATH: '/usr/bin' },
      exists: (candidate) => candidate.startsWith(musl),
      packageRoot,
      binaryName: 'gitglasses-engine',
      enginePackages: ['@gitglasses/engine-linux-x64', '@gitglasses/engine-linux-x64-musl'],
      resolvePackage: (name) => path.join('/app/node_modules', name),
    });
    expect(resolved).toBe(path.join(musl, 'bin', 'gitglasses-engine'));
  });

  it('lets GITGLASSES_ENGINE override an installed engine package', () => {
    const resolved = resolveEnginePath({
      env: { GITGLASSES_ENGINE: '/opt/engine/gitglasses-engine' },
      exists: () => true,
      packageRoot,
      enginePackages: ['@gitglasses/engine-linux-x64'],
      resolvePackage: () => '/app/node_modules/@gitglasses/engine-linux-x64',
    });
    expect(resolved).toBe('/opt/engine/gitglasses-engine');
  });

  it('falls back to the monorepo release build next to the package', () => {
    const resolved = resolveEnginePath({
      env: { PATH: '/usr/bin' },
      exists: (candidate) => candidate === localBuild,
      packageRoot,
      binaryName: 'gitglasses-engine',
      resolvePackage: () => undefined,
    });
    expect(resolved).toBe(localBuild);
  });

  it('searches PATH when neither env var nor local build exists', () => {
    const hit = path.join('/home/u/bin', 'gitglasses-engine');
    const resolved = resolveEnginePath({
      resolvePackage: () => undefined,
      env: { PATH: ['/usr/bin', '/home/u/bin'].join(':') },
      exists: (candidate) => candidate === hit,
      packageRoot,
      pathSeparator: ':',
      binaryName: 'gitglasses-engine',
    });
    expect(resolved).toBe(hit);
  });

  it('returns undefined when the binary is nowhere to be found', () => {
    const resolved = resolveEnginePath({
      resolvePackage: () => undefined,
      env: { PATH: '/usr/bin:/usr/local/bin' },
      exists: () => false,
      packageRoot,
      pathSeparator: ':',
      binaryName: 'gitglasses-engine',
    });
    expect(resolved).toBeUndefined();
  });
});

describe('enginePackageNames', () => {
  it('names one package per platform and CPU, esbuild style', () => {
    expect(enginePackageNames('darwin', 'arm64', false)).toEqual([
      '@gitglasses/engine-darwin-arm64',
    ]);
    expect(enginePackageNames('win32', 'x64', false)).toEqual(['@gitglasses/engine-win32-x64']);
  });

  it('prefers the glibc build on Linux and takes only the static one on musl', () => {
    expect(enginePackageNames('linux', 'x64', false)).toEqual([
      '@gitglasses/engine-linux-x64',
      '@gitglasses/engine-linux-x64-musl',
    ]);
    expect(enginePackageNames('linux', 'arm64', true)).toEqual([
      '@gitglasses/engine-linux-arm64-musl',
    ]);
  });
});

describe('engineBinaryName', () => {
  it('suffixes .exe on Windows only', () => {
    expect(engineBinaryName('win32')).toBe('gitglasses-engine.exe');
    expect(engineBinaryName('linux')).toBe('gitglasses-engine');
    expect(engineBinaryName('darwin')).toBe('gitglasses-engine');
  });
});
