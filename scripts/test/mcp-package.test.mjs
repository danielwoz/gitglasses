// gitglasses-mcp must install and run from npm on its own: no unpublished
// workspace dependencies, a self-contained CLI bundle, and the metadata npm
// and provenance need.

import { builtinModules } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { smokeTestMcpServer } from '../lib/mcp-smoke.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const packageDir = path.join(root, 'mcp-server');
const manifest = JSON.parse(readFileSync(path.join(packageDir, 'package.json'), 'utf8'));
const cli = path.join(packageDir, manifest.bin['gitglasses-mcp']);

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
    expect(manifest.repository).toMatchObject({ url: 'git+https://github.com/danielwoz/gitglasses.git', directory: 'mcp-server' });
    expect(manifest.engines.node).toMatch(/^>=/);
    expect(manifest.publishConfig).toMatchObject({ access: 'public', provenance: true });
    expect(readFileSync(path.join(packageDir, 'LICENSE'), 'utf8')).toBe(readFileSync(path.join(root, 'LICENSE'), 'utf8'));
  });

  // Until a release has published the package, npx would fetch whatever is
  // registered under the name; no example command may rely on it.
  it('gives no npx command in its examples', () => {
    for (const readme of [path.join(packageDir, 'README.md'), path.join(root, 'README.md')]) {
      const examples = [...readFileSync(readme, 'utf8').matchAll(/```[^\n]*\n([\s\S]*?)```/g)].map((m) => m[1]);
      expect(examples.length, readme).toBeGreaterThan(0);
      for (const example of examples) {
        expect(example, readme).not.toMatch(/\bnpx\b/);
      }
    }
  });

  describe.skipIf(!existsSync(cli))('built CLI', () => {
    it('imports nothing but Node built-ins and declared dependencies', () => {
      const source = readFileSync(cli, 'utf8');
      const specifiers = [...source.matchAll(/(?:^|\n)\s*(?:import|export)\b[^'"]*?from\s*["']([^"']+)["']/g)].map(
        (match) => match[1],
      );
      expect(specifiers.length).toBeGreaterThan(0);
      const builtins = new Set(builtinModules);
      for (const specifier of specifiers) {
        if (specifier.startsWith('node:') || builtins.has(specifier)) continue;
        const name = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0];
        expect(Object.keys(manifest.dependencies), specifier).toContain(name);
      }
    });

    it('answers an MCP handshake with the package version and lists its tools', async () => {
      const { serverInfo, tools } = await smokeTestMcpServer(cli, { version: manifest.version });
      expect(serverInfo).toEqual({ name: 'gitglasses', version: manifest.version });
      expect(tools).toEqual(expect.arrayContaining(['git_blame', 'git_status', 'apply_patch']));
    });
  });
});
