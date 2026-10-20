// gitglasses-mcp must install and run from npm on its own: no unpublished
// workspace dependencies, a self-contained CLI bundle, the metadata npm and
// provenance need, and a README that is right for the npm page.

import { execFileSync } from 'node:child_process';
import { builtinModules } from 'node:module';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  NPM_README_TEMPLATE,
  PACKAGE_FILES,
  npmReadmeProblems,
  publishedManifest,
  renderNpmReadme,
} from '../lib/mcp-package.mjs';
import { smokeTestMcpServer } from '../lib/mcp-smoke.mjs';
import { readTarGz } from '../lib/tar.mjs';

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
        expect(files.get('package/dist/cli.js').mode & 0o111).toBe(0o111);
      } finally {
        rmSync(out, { recursive: true, force: true });
      }
    });
  });
});
