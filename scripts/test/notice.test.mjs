// NOTICE must carry the license of everything the packages redistribute: the
// libraries statically linked into the native and wasm engines, the runtimes
// linked with them, and the npm code bundled into the extension.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../..', import.meta.url));
const notice = readFileSync(path.join(root, 'NOTICE'), 'utf8').replace(/\r\n/g, '\n');
const readJson = (file) => JSON.parse(readFileSync(path.join(root, file), 'utf8'));

// vcpkg ports and npm packages that ship in a package, by NOTICE section.
const SECTIONS = {
  libgit2: 'libgit2',
  pcre2: 'PCRE2',
  zlib: 'zlib',
  'http-parser': 'http-parser',
  fmt: '{fmt}',
  spdlog: 'spdlog',
  'nlohmann-json': 'nlohmann/json',
  '@sinclair/typebox': 'TypeBox',
};
// Build and test tooling that never ships.
const NOT_SHIPPED = new Set(['gtest', 'vcpkg-cmake', 'vcpkg-cmake-config', 'vcpkg-cmake-get-vars']);

const sections = new Set([...notice.matchAll(/^={79}\n(.+)\n/gm)].map((match) => match[1]));
const squash = (text) => text.replace(/\s+/g, ' ').trim();

describe('NOTICE', () => {
  it('has a section for every shipped component and runtime', () => {
    for (const name of [...Object.values(SECTIONS), 'SLJIT', 'musl libc', 'Emscripten']) {
      expect(sections, name).toContain(name);
    }
  });

  it('covers every dependency in the vcpkg manifest', () => {
    for (const dependency of readJson('vcpkg.json').dependencies) {
      const name = typeof dependency === 'string' ? dependency : dependency.name;
      if (NOT_SHIPPED.has(name)) continue;
      expect(SECTIONS[name], `${name} needs a NOTICE section`).toBeDefined();
    }
  });

  it('covers the npm runtime dependencies bundled into the extension', () => {
    const workspace = Object.keys(readJson('extension/package.json').dependencies ?? {});
    expect(workspace.length).toBeGreaterThan(0);
    for (const name of workspace) {
      const manifest = readJson(
        path.join('packages', name.replace('@gitglasses/', ''), 'package.json'),
      );
      for (const dependency of Object.keys(manifest.dependencies ?? {})) {
        if (dependency.startsWith('@gitglasses/')) continue;
        expect(
          SECTIONS[dependency],
          `${dependency} (via ${name}) needs a NOTICE section`,
        ).toBeDefined();
      }
    }
  });

  // Every port vcpkg installed (transitive ones included) must be covered,
  // and its copyright text must appear in full. Needs a local vcpkg install.
  const installed =
    process.env.GG_VCPKG_INSTALLED ??
    path.join(homedir(), '.cache', 'gitglasses', 'vcpkg_installed');
  const share = path.join(installed, 'x64-linux', 'share');
  const info = path.join(installed, 'vcpkg', 'info');
  it.skipIf(!existsSync(share) || !existsSync(info))(
    "reproduces each installed port's copyright text",
    () => {
      const ports = readdirSync(info)
        .map((file) => /^(.+?)_[^_]+_x64-linux\.list$/.exec(file)?.[1])
        .filter((port) => port && !NOT_SHIPPED.has(port));
      expect(ports.length).toBeGreaterThan(0);
      for (const port of ports) {
        expect(SECTIONS[port], `${port} needs a NOTICE section`).toBeDefined();
        const copyright = readFileSync(path.join(share, port, 'copyright'), 'utf8');
        // vcpkg's pcre2 copyright only points at the LICENCE file NOTICE quotes.
        if (port === 'pcre2') continue;
        expect(squash(notice).includes(squash(copyright)), `${port} copyright text`).toBe(true);
      }
    },
  );
});
