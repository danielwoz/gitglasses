// The packaging script refuses a wrong engine before it touches the tree, so
// a mismatched binary can never reach a VSIX.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { elfHeader, importLibrary, peHeader } from './fixtures.mjs';

const script = fileURLToPath(new URL('../package-vsix.mjs', import.meta.url));
let dir;

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'gitglasses-package-'));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function run(...args) {
  const result = spawnSync(process.execPath, [script, '--out-dir', path.join(dir, 'out'), ...args], {
    encoding: 'utf8',
  });
  return { status: result.status, stderr: result.stderr };
}

function engineFile(name, data) {
  const file = path.join(dir, name);
  writeFileSync(file, data);
  return file;
}

describe('package-vsix', () => {
  it('refuses an import library as the Windows engine', () => {
    const lib = engineFile('gitglasses-engine.lib', importLibrary());
    const { status, stderr } = run('--target', 'win32-x64', '--engine', lib);
    expect(status).toBe(1);
    expect(stderr).toContain('is not a win32-x64 executable: missing MZ header (found an ar archive or import library)');
    expect(existsSync(path.join(dir, 'out'))).toBe(false);
  });

  it('refuses an engine built for another CPU or OS', () => {
    const arm = engineFile('arm64.exe', peHeader({ machine: 0xaa64 }));
    expect(run('--target', 'win32-x64', '--engine', arm).stderr).toContain('PE machine 0xaa64 is not x64');
    const elf = engineFile('linux-engine', elfHeader());
    expect(run('--target', 'darwin-arm64', '--engine', elf).stderr).toContain('missing 64-bit Mach-O magic');
  });

  it('requires an engine for native targets and refuses one for web', () => {
    expect(run('--target', 'linux-x64')).toMatchObject({ status: 2 });
    expect(run('--target', 'linux-x64').stderr).toContain('--engine is required for linux-x64');
    const elf = engineFile('engine', elfHeader());
    expect(run('--target', 'web', '--engine', elf)).toMatchObject({ status: 2 });
    expect(run('--target', 'solaris-sparc', '--engine', elf).stderr).toContain('unknown target solaris-sparc');
  });
});
