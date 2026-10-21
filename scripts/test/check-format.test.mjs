// Tests for scripts/check-format.mjs against throwaway git repositories.

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'vitest';

import { changedFiles, checkClangFormat, checkPrettier, resolveBase } from '../check-format.mjs';

const FORMATTED_TS = "export const value = 'formatted';\n";
const UNFORMATTED_TS = 'export const value   =  "unformatted"\n';
const FORMATTED_CPP = 'int add(int a, int b) { return a + b; }\n';
const UNFORMATTED_CPP = 'int  add( int a,int b ){return a+b;}\n';

const hasClangFormat =
  spawnSync(process.env.CLANG_FORMAT || 'clang-format', ['--version']).status === 0 &&
  spawnSync('git', ['clang-format', '-h']).status === 0;

let repo;

function git(...args) {
  return execFileSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
      GIT_COMMITTER_NAME: 'Fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
      GIT_CONFIG_NOSYSTEM: '1',
    },
  });
}

function write(file, contents) {
  mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
  writeFileSync(path.join(repo, file), contents);
}

function read(file) {
  return readFileSync(path.join(repo, file), 'utf8');
}

async function prettierOffenders(fix = false) {
  const base = resolveBase(repo, 'base');
  return checkPrettier({ cwd: repo, base, files: changedFiles(repo, base), fix });
}

beforeEach(() => {
  repo = mkdtempSync(path.join(tmpdir(), 'gg-check-format-'));
  git('init', '-q', '-b', 'main');
  git('config', 'core.autocrlf', 'false');
  git('config', 'commit.gpgsign', 'false');
  write('.prettierrc.json', '{ "singleQuote": true, "printWidth": 100 }\n');
  write('.clang-format', 'BasedOnStyle: Google\nColumnLimit: 100\n');
  write('src/clean.ts', FORMATTED_TS);
  write('src/legacy.ts', UNFORMATTED_TS);
  git('add', '.');
  git('commit', '-q', '-m', 'base');
  git('branch', 'base');
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe('changedFiles', () => {
  it('lists modified, added, renamed and untracked files with their base paths', () => {
    write('src/clean.ts', FORMATTED_TS + 'export const more = 1;\n');
    git('mv', 'src/legacy.ts', 'src/moved.ts');
    write('src/added.ts', FORMATTED_TS);
    git('add', 'src/added.ts');
    write('src/untracked.ts', FORMATTED_TS);

    assert.deepEqual(changedFiles(repo, resolveBase(repo, 'base')), [
      { path: 'src/added.ts', basePath: undefined },
      { path: 'src/clean.ts', basePath: 'src/clean.ts' },
      { path: 'src/moved.ts', basePath: 'src/legacy.ts' },
      { path: 'src/untracked.ts', basePath: undefined },
    ]);
  });

  it('lists only what HEAD commits when committed', () => {
    write('src/committed.ts', FORMATTED_TS);
    git('add', 'src/committed.ts');
    git('commit', '-q', '-m', 'add file');
    write('src/clean.ts', UNFORMATTED_TS);
    write('src/untracked.ts', FORMATTED_TS);

    assert.deepEqual(changedFiles(repo, resolveBase(repo, 'base'), { committed: true }), [
      { path: 'src/committed.ts', basePath: undefined },
    ]);
  });
});

describe('checkPrettier', () => {
  it('accepts an edit that keeps a file unformatted when it already was', async () => {
    write('src/legacy.ts', UNFORMATTED_TS + 'export const   other = 2\n');
    assert.deepEqual(await prettierOffenders(), []);
  });

  it('rejects an edit that unformats a formatted file', async () => {
    write('src/clean.ts', UNFORMATTED_TS);
    assert.deepEqual(await prettierOffenders(), ['src/clean.ts']);
  });

  it('rejects a new unformatted file, committed or not', async () => {
    write('src/committed.ts', UNFORMATTED_TS);
    git('add', 'src/committed.ts');
    git('commit', '-q', '-m', 'add file');
    write('src/untracked.ts', UNFORMATTED_TS);
    assert.deepEqual(await prettierOffenders(), ['src/committed.ts', 'src/untracked.ts']);
  });

  it('ignores files outside its extensions and files in .prettierignore', async () => {
    write('.prettierignore', 'generated/\n');
    write('generated/out.ts', UNFORMATTED_TS);
    write('notes.md', '#  heading\n');
    assert.deepEqual(await prettierOffenders(), []);
  });

  it('judges the committed content, not the working tree, when committed', async () => {
    write('src/clean.ts', UNFORMATTED_TS);
    git('commit', '-q', '-am', 'unformat');
    write('src/clean.ts', FORMATTED_TS);
    write('src/untracked.ts', UNFORMATTED_TS);
    const base = resolveBase(repo, 'base');
    const files = changedFiles(repo, base, { committed: true });
    assert.deepEqual(await checkPrettier({ cwd: repo, base, files, committed: true }), [
      'src/clean.ts',
    ]);
  });

  it('rewrites exactly the reported files with fix', async () => {
    write('src/clean.ts', UNFORMATTED_TS);
    write('src/legacy.ts', UNFORMATTED_TS + 'export const   other = 2\n');
    assert.deepEqual(await prettierOffenders(true), ['src/clean.ts']);
    assert.equal(read('src/clean.ts'), "export const value = 'unformatted';\n");
    assert.equal(read('src/legacy.ts'), UNFORMATTED_TS + 'export const   other = 2\n');
    assert.deepEqual(await prettierOffenders(), []);
  });
});

describe.skipIf(!hasClangFormat)('checkClangFormat', () => {
  function clangOffenders(fix = false, committed = false) {
    const base = resolveBase(repo, 'base');
    const files = changedFiles(repo, base, { committed });
    return checkClangFormat({ cwd: repo, base, files, fix, committed });
  }

  beforeEach(() => {
    write('engine/legacy.cpp', UNFORMATTED_CPP);
    git('add', '.');
    git('commit', '-q', '-m', 'legacy c++');
    git('branch', '-f', 'base');
  });

  it('checks only the changed lines of an existing file', () => {
    write('engine/legacy.cpp', UNFORMATTED_CPP + FORMATTED_CPP.replace('add', 'sum'));
    assert.deepEqual(clangOffenders(), []);

    write('engine/legacy.cpp', UNFORMATTED_CPP + UNFORMATTED_CPP.replace('add', 'sum'));
    assert.deepEqual(clangOffenders(), ['engine/legacy.cpp']);
  });

  it('checks the whole of a new file', () => {
    write('engine/added.cpp', UNFORMATTED_CPP);
    assert.deepEqual(clangOffenders(), ['engine/added.cpp']);
    git('add', 'engine/added.cpp');
    assert.deepEqual(clangOffenders(), ['engine/added.cpp']);
  });

  it('checks only the lines HEAD changes when committed', () => {
    write('engine/legacy.cpp', UNFORMATTED_CPP + UNFORMATTED_CPP.replace('add', 'sum'));
    git('commit', '-q', '-am', 'unformatted addition');
    write('engine/legacy.cpp', UNFORMATTED_CPP + FORMATTED_CPP.replace('add', 'sum'));
    write('engine/untracked.cpp', UNFORMATTED_CPP);
    assert.deepEqual(clangOffenders(false, true), ['engine/legacy.cpp']);

    git('commit', '-q', '-am', 'formatted addition');
    assert.deepEqual(clangOffenders(false, true), []);
  });

  it('formats the changed lines with fix and leaves the rest alone', () => {
    write('engine/legacy.cpp', UNFORMATTED_CPP + UNFORMATTED_CPP.replace('add', 'sum'));
    assert.deepEqual(clangOffenders(true), ['engine/legacy.cpp']);
    assert.equal(read('engine/legacy.cpp'), UNFORMATTED_CPP + FORMATTED_CPP.replace('add', 'sum'));
    assert.deepEqual(clangOffenders(), []);
  });
});
