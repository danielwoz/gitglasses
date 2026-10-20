import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { releaseVersionProblems, vscodeTypesProblem } from '../lib/versions.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const dirs = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tree({
  version = '0.2.0',
  root: rootVersion = version,
  mcp = version,
  cmake,
  changelog,
  types = '~1.90.0',
} = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'gitglasses-versions-'));
  dirs.push(dir);
  const write = (file, contents) => {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(
      path.join(dir, file),
      typeof contents === 'string' ? contents : JSON.stringify(contents),
    );
  };
  write('extension/package.json', {
    version,
    engines: { vscode: '^1.90.0' },
    devDependencies: { '@types/vscode': types },
  });
  write('package.json', { version: rootVersion });
  write('mcp-server/package.json', { version: mcp });
  write(
    'CMakeLists.txt',
    cmake ??
      'file(READ "${CMAKE_CURRENT_SOURCE_DIR}/extension/package.json" M)\nproject(gitglasses VERSION ${GG_VERSION} LANGUAGES C CXX)\n',
  );
  write('extension/CHANGELOG.md', changelog ?? `# Changelog\n\n## [${version}]\n\n- Fixes.\n`);
  return dir;
}

describe('releaseVersionProblems', () => {
  it('accepts a consistent tree and its tag', () => {
    expect(releaseVersionProblems(tree(), { tag: 'v0.2.0' })).toEqual({
      version: '0.2.0',
      prerelease: false,
      problems: [],
    });
  });

  it('puts odd minor versions on the pre-release channel', () => {
    expect(releaseVersionProblems(tree({ version: '0.3.1' }))).toMatchObject({
      prerelease: true,
      problems: [],
    });
  });

  it('reports every manifest, the CMake version, the changelog and the tag that disagree', () => {
    const dir = tree({
      mcp: '0.1.0',
      root: '0.1.0',
      cmake: 'project(gitglasses VERSION 0.1.0 LANGUAGES C CXX)\n',
      changelog: '# Changelog\n\n## [0.1.2]\n',
    });
    expect(releaseVersionProblems(dir, { tag: 'v0.1.2' }).problems).toEqual([
      'package.json is 0.1.0, extension/package.json is 0.2.0',
      'mcp-server/package.json is 0.1.0, extension/package.json is 0.2.0',
      'CMakeLists.txt project version is 0.1.0, extension/package.json is 0.2.0',
      'extension/CHANGELOG.md has no entry for 0.2.0',
      'tag v0.1.2 does not match extension/package.json version 0.2.0',
    ]);
  });

  it('requires a changelog section with release notes in it', () => {
    expect(
      releaseVersionProblems(
        tree({ changelog: '# Changelog\n\n## [0.2.0]\n\n## [0.1.2]\n\n- Older.\n' }),
      ).problems,
    ).toEqual(['extension/CHANGELOG.md has no entry for 0.2.0']);
    for (const heading of ['## 0.2.0', '## v0.2.0', '## [v0.2.0]', '## [0.2.0] - 2026-10-20']) {
      expect(
        releaseVersionProblems(tree({ changelog: `${heading}\n\n- Fixes.\n` })).problems,
        heading,
      ).toEqual([]);
    }
  });

  it('rejects versions the Marketplace cannot publish', () => {
    expect(releaseVersionProblems(tree({ version: '0.2.0-beta.1' })).problems[0]).toMatch(
      /not MAJOR.MINOR.PATCH/,
    );
  });

  it('holds for this repository', () => {
    expect(releaseVersionProblems(root).problems).toEqual([]);
  });
});

describe('vscodeTypesProblem', () => {
  const manifest = (types) => ({
    engines: { vscode: '^1.90.0' },
    devDependencies: { '@types/vscode': types },
  });

  it('accepts typings pinned to the engines.vscode floor', () => {
    for (const types of ['~1.90.0', '1.90.0', '1.90.x', '~1.90.3']) {
      expect(vscodeTypesProblem(manifest(types)), types).toBeUndefined();
    }
  });

  it('rejects typings that float above the floor', () => {
    expect(vscodeTypesProblem(manifest('^1.90.0'))).toBe(
      '@types/vscode ^1.90.0 must stay on 1.90 to match engines.vscode ^1.90.0',
    );
    expect(vscodeTypesProblem(manifest('~1.95.0'))).toMatch(/must stay on 1.90/);
    expect(vscodeTypesProblem({ engines: { vscode: '^1.90.0' } })).toMatch(/\(missing\)/);
  });
});
