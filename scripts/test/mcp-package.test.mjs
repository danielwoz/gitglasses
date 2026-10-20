// gitglasses-mcp must install and run from npm on its own: no unpublished
// workspace dependencies, a self-contained CLI bundle, the metadata npm and
// provenance need, and a README that is right for the npm page.

import { execFileSync, spawnSync } from 'node:child_process';
import { builtinModules } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ENGINE_PACKAGES,
  NPM_README_TEMPLATE,
  PACKAGE_FILES,
  engineManifest,
  enginePackageFiles,
  npmReadmeProblems,
  publishedManifest,
  renderNpmReadme,
  tarballName,
} from '../lib/mcp-package.mjs';
import { smokeTestMcpServer } from '../lib/mcp-smoke.mjs';
import { readTarGz } from '../lib/tar.mjs';
import { elfHeader, peHeader } from './fixtures.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const packageDir = path.join(root, 'mcp-server');
const manifest = JSON.parse(readFileSync(path.join(packageDir, 'package.json'), 'utf8'));
const cli = path.join(packageDir, manifest.bin['gitglasses-mcp']);
const repositoryReadme = readFileSync(path.join(packageDir, 'README.md'), 'utf8');
const npmReadme = renderNpmReadme(
  readFileSync(path.join(root, NPM_README_TEMPLATE), 'utf8'),
  manifest.version,
);

describe('gitglasses-mcp package', () => {
  it('depends only on published packages at runtime', () => {
    for (const [name, range] of Object.entries(manifest.dependencies)) {
      expect(range, name).not.toMatch(/^workspace:/);
      expect(name, name).not.toMatch(/^@gitglasses\//);
    }
  });

  it('ships the bundled CLI and the metadata npm needs', () => {
    expect(manifest.files).toEqual(['dist/cli.js']);
    expect(manifest.bin).toEqual({ 'gitglasses-mcp': 'dist/cli.js' });
    expect(manifest.license).toBe('MIT');
    expect(manifest.repository).toMatchObject({
      url: 'git+https://github.com/danielwoz/gitglasses.git',
      directory: 'mcp-server',
    });
    expect(manifest.engines.node).toMatch(/^>=/);
    expect(manifest.publishConfig).toMatchObject({ access: 'public', provenance: true });
    expect(readFileSync(path.join(packageDir, 'LICENSE'), 'utf8')).toBe(
      readFileSync(path.join(root, 'LICENSE'), 'utf8'),
    );
  });

  // Until a release has published the package, npx would fetch whatever is
  // registered under the name; no example command may rely on it.
  it('gives no npx command in its examples', () => {
    for (const readme of [path.join(packageDir, 'README.md'), path.join(root, 'README.md')]) {
      const examples = [...readFileSync(readme, 'utf8').matchAll(/```[^\n]*\n([\s\S]*?)```/g)].map(
        (m) => m[1],
      );
      expect(examples.length, readme).toBeGreaterThan(0);
      for (const example of examples) {
        expect(example, readme).not.toMatch(/\bnpx\b/);
      }
    }
  });

  // The repository README describes running from a clone; npm users get the
  // npm README, which names the version they install.
  it('publishes an npm README for its version, without clone instructions', () => {
    expect(npmReadmeProblems(npmReadme, manifest.version)).toEqual([]);
    expect(npmReadme).toContain(`npx -y gitglasses-mcp@${manifest.version}`);
    expect(npmReadmeProblems(repositoryReadme, manifest.version)).toEqual(
      expect.arrayContaining([
        'README says the package is not on npm',
        'README gives paths inside a clone',
      ]),
    );
  });

  it('leaves the build-only fields out of the published manifest', () => {
    const published = publishedManifest(manifest);
    expect(published).not.toHaveProperty('devDependencies');
    expect(published).not.toHaveProperty('scripts');
    expect(published).toMatchObject({
      name: 'gitglasses-mcp',
      version: manifest.version,
      bin: manifest.bin,
    });
    expect(published.dependencies).toEqual(manifest.dependencies);
    // Every engine package of the same version, for npm to pick from.
    expect(published.optionalDependencies).toEqual(
      Object.fromEntries(ENGINE_PACKAGES.map((engine) => [engine.name, manifest.version])),
    );
  });

  describe('engine packages', () => {
    it('names one package per platform and CPU, with -musl for the static Alpine builds', () => {
      expect(ENGINE_PACKAGES.map((engine) => [engine.target, engine.name])).toEqual([
        ['linux-x64', '@gitglasses/engine-linux-x64'],
        ['linux-arm64', '@gitglasses/engine-linux-arm64'],
        ['alpine-x64', '@gitglasses/engine-linux-x64-musl'],
        ['alpine-arm64', '@gitglasses/engine-linux-arm64-musl'],
        ['darwin-x64', '@gitglasses/engine-darwin-x64'],
        ['darwin-arm64', '@gitglasses/engine-darwin-arm64'],
        ['win32-x64', '@gitglasses/engine-win32-x64'],
        ['win32-arm64', '@gitglasses/engine-win32-arm64'],
      ]);
      // The names the server looks for (mcp-server/src/engine.ts) follow
      // process.platform and process.arch.
      for (const engine of ENGINE_PACKAGES) {
        expect(engine.name).toBe(
          `@gitglasses/engine-${engine.os}-${engine.cpu}${engine.libc === 'musl' ? '-musl' : ''}`,
        );
      }
    });

    it('restricts each package to its platform and ships the engine with its notices', () => {
      const alpine = ENGINE_PACKAGES.find((engine) => engine.target === 'alpine-arm64');
      expect(engineManifest(alpine, manifest)).toMatchObject({
        name: '@gitglasses/engine-linux-arm64-musl',
        version: manifest.version,
        license: 'MIT',
        os: ['linux'],
        cpu: ['arm64'],
        libc: ['musl'],
        files: ['bin/gitglasses-engine', 'NOTICE'],
        publishConfig: { access: 'public', provenance: true },
      });
      expect(engineManifest(alpine, manifest).repository.url).toBe(manifest.repository.url);
      const windows = ENGINE_PACKAGES.find((engine) => engine.target === 'win32-x64');
      expect(engineManifest(windows, manifest)).not.toHaveProperty('libc');
      expect(enginePackageFiles(windows)).toEqual([
        'LICENSE',
        'NOTICE',
        'README.md',
        'bin/gitglasses-engine.exe',
        'package.json',
      ]);
      expect(tarballName('@gitglasses/engine-win32-x64', '1.2.3')).toBe(
        'gitglasses-engine-win32-x64-1.2.3.tgz',
      );
    });
  });

  describe.skipIf(!existsSync(cli))('built CLI', () => {
    it('imports nothing but Node built-ins and declared dependencies', () => {
      const source = readFileSync(cli, 'utf8');
      const specifiers = [
        ...source.matchAll(/(?:^|\n)\s*(?:import|export)\b[^'"]*?from\s*["']([^"']+)["']/g),
      ].map((match) => match[1]);
      expect(specifiers.length).toBeGreaterThan(0);
      const builtins = new Set(builtinModules);
      for (const specifier of specifiers) {
        if (specifier.startsWith('node:') || builtins.has(specifier)) continue;
        const name = specifier.startsWith('@')
          ? specifier.split('/').slice(0, 2).join('/')
          : specifier.split('/')[0];
        expect(Object.keys(manifest.dependencies), specifier).toContain(name);
      }
    });

    it('answers an MCP handshake with the package version and documents every tool it lists', async () => {
      const { serverInfo, tools } = await smokeTestMcpServer(cli, { version: manifest.version });
      expect(serverInfo).toEqual({ name: 'gitglasses', version: manifest.version });
      expect(tools).toEqual(expect.arrayContaining(['git_blame', 'git_status', 'apply_patch']));
      for (const readme of [repositoryReadme, npmReadme]) {
        const documented = [...readme.matchAll(/^\| `([a-z_]+)` \|/gm)].map((match) => match[1]);
        expect(documented.sort()).toEqual([...tools].sort());
      }
    });

    it('packs an engine package for each engine build, and refuses a wrong or missing one', () => {
      const work = mkdtempSync(path.join(tmpdir(), 'gitglasses-engine-pack-'));
      const engines = path.join(work, 'engines');
      const write = (target, file, data) => {
        mkdirSync(path.join(engines, `engine-${target}`), { recursive: true });
        writeFileSync(path.join(engines, `engine-${target}`, file), data);
      };
      const packScript = path.join(root, 'scripts', 'pack-mcp.mjs');
      const run = (...args) =>
        spawnSync(process.execPath, [packScript, '--out', path.join(work, 'out'), ...args], {
          encoding: 'utf8',
        });
      try {
        write('linux-x64', 'gitglasses-engine', elfHeader());
        write('win32-x64', 'gitglasses-engine.exe', peHeader());
        const packed = run('--engines', engines);
        expect(packed.status, packed.stderr).toBe(0);
        const tarballs = packed.stdout
          .trim()
          .split('\n')
          .map((line) => path.basename(line));
        expect(tarballs.sort()).toEqual(
          [
            tarballName('@gitglasses/engine-linux-x64', manifest.version),
            tarballName('@gitglasses/engine-win32-x64', manifest.version),
            `gitglasses-mcp-${manifest.version}.tgz`,
          ].sort(),
        );

        const linux = ENGINE_PACKAGES.find((engine) => engine.target === 'linux-x64');
        const files = readTarGz(
          readFileSync(path.join(work, 'out', tarballName(linux.name, manifest.version))),
        );
        expect([...files.keys()].sort()).toEqual(
          enginePackageFiles(linux).map((file) => `package/${file}`),
        );
        expect(JSON.parse(files.get('package/package.json').data.toString('utf8'))).toEqual(
          engineManifest(linux, manifest),
        );
        expect(files.get('package/bin/gitglasses-engine').data.equals(elfHeader())).toBe(true);
        // Windows has no executable bit to pack; releases pack on Linux.
        if (process.platform !== 'win32') {
          expect(files.get('package/bin/gitglasses-engine').mode & 0o111).toBe(0o111);
        }
        expect(files.get('package/NOTICE').data.toString('utf8')).toBe(
          readFileSync(path.join(root, 'NOTICE'), 'utf8'),
        );

        // A release needs every engine its optional dependencies name.
        const incomplete = run('--engines', engines, '--all-engines');
        expect(incomplete.status).toBe(1);
        expect(incomplete.stderr).toContain('no linux-arm64 engine');

        // An import library or a binary for another platform never ships.
        write('darwin-arm64', 'gitglasses-engine', elfHeader());
        const wrong = run('--engines', engines);
        expect(wrong.status).toBe(1);
        expect(wrong.stderr).toContain('is not a darwin-arm64 executable');
      } finally {
        rmSync(work, { recursive: true, force: true });
      }
    });

    it('packs the npm README, the executable CLI, the licence and the published manifest', () => {
      const out = mkdtempSync(path.join(tmpdir(), 'gitglasses-mcp-pack-'));
      try {
        const tarball = execFileSync(
          process.execPath,
          [path.join(root, 'scripts', 'pack-mcp.mjs'), '--out', out],
          {
            encoding: 'utf8',
          },
        ).trim();
        expect(path.basename(tarball)).toBe(`gitglasses-mcp-${manifest.version}.tgz`);
        const files = readTarGz(readFileSync(tarball));
        expect([...files.keys()].sort()).toEqual(PACKAGE_FILES.map((file) => `package/${file}`));
        expect(files.get('package/README.md').data.toString('utf8')).toBe(npmReadme);
        expect(JSON.parse(files.get('package/package.json').data.toString('utf8'))).toEqual(
          publishedManifest(manifest),
        );
        expect(files.get('package/dist/cli.js').data.equals(readFileSync(cli))).toBe(true);
        // Windows has no executable bit to carry into the tarball; the npm
        // package is packed and published on Linux.
        if (process.platform !== 'win32') {
          expect(files.get('package/dist/cli.js').mode & 0o111).toBe(0o111);
        }
      } finally {
        rmSync(out, { recursive: true, force: true });
      }
    });
  });
});
