#!/usr/bin/env node
// Checks the formatting of what a change touches, so the codebase converges on
// one style without a repository-wide rewrite:
//   - TypeScript and JavaScript (Prettier): a changed file must be formatted
//     when it is new or was already formatted before the change. Files that
//     predate the formatter stay exempt until someone formats them.
//   - C++ (clang-format): the changed lines must be formatted, which is what
//     `git clang-format` checks, so older files converge as they are edited.
//
// Usage: node scripts/check-format.mjs [--base <commit>] [--fix]
//   --base <commit>          compare against the merge base of this commit and
//                            HEAD (default: origin/main, then main)
//   --fix                    rewrite what the check reports instead of failing
//   --clang-format-version   print the clang-format version CI pins and exit

import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// clang-format output differs between releases; CI installs exactly this one
// (pip install clang-format==<version>), and local runs warn on a mismatch.
export const CLANG_FORMAT_VERSION = '23.1.3';

const PRETTIER_EXTENSIONS = new Set(['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs']);
const CLANG_FORMAT_EXTENSIONS = ['c', 'cc', 'cpp', 'h', 'hpp'];

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function tryGit(cwd, args) {
  try {
    return git(cwd, args);
  } catch {
    return undefined;
  }
}

// The commit a change is measured against: the merge base of `requested` (or
// of origin/main, then main) and HEAD. Undefined when none of them resolves.
export function resolveBase(cwd, requested) {
  for (const ref of requested ? [requested] : ['origin/main', 'main']) {
    const base = tryGit(cwd, ['merge-base', ref, 'HEAD'])?.trim();
    if (base) return base;
  }
  return undefined;
}

// Files added, copied, modified or renamed since `base`, in the working tree
// (committed or not) plus untracked files. Each entry records the path the
// file had at `base`, if any.
export function changedFiles(cwd, base) {
  const fields = git(cwd, ['diff', '--name-status', '-z', '-M', '--diff-filter=ACMR', base])
    .split('\0')
    .filter(Boolean);
  const files = new Map();
  for (let i = 0; i < fields.length;) {
    const status = fields[i++];
    if (status.startsWith('R') || status.startsWith('C')) {
      const from = fields[i++];
      const to = fields[i++];
      files.set(to, { path: to, basePath: status.startsWith('R') ? from : undefined });
    } else {
      const file = fields[i++];
      files.set(file, { path: file, basePath: status === 'A' ? undefined : file });
    }
  }
  for (const file of git(cwd, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0')) {
    if (file && !files.has(file)) files.set(file, { path: file, basePath: undefined });
  }
  return [...files.values()].sort((a, b) => a.path.localeCompare(b.path));
}

// Changed TypeScript/JavaScript files that must be Prettier-formatted but are
// not. With `fix`, those files are rewritten in place.
export async function checkPrettier({ cwd, base, files, fix = false }) {
  const prettier = await import('prettier');
  const offenders = [];
  for (const file of files) {
    if (!PRETTIER_EXTENSIONS.has(path.extname(file.path))) continue;
    const absolute = path.join(cwd, file.path);
    const info = await prettier.getFileInfo(absolute, {
      ignorePath: path.join(cwd, '.prettierignore'),
    });
    if (info.ignored) continue;
    const options = { ...(await prettier.resolveConfig(absolute)), filepath: absolute };
    const source = readFileSync(absolute, 'utf8');
    if (await prettier.check(source, options)) continue;
    if (file.basePath !== undefined) {
      const before = tryGit(cwd, ['show', `${base}:${file.basePath}`]);
      if (before !== undefined && !(await prettier.check(before, options))) continue;
    }
    if (fix) writeFileSync(absolute, await prettier.format(source, options));
    offenders.push(file.path);
  }
  return offenders;
}

function clangFormatBinary() {
  const binary = process.env.CLANG_FORMAT || 'clang-format';
  const probe = spawnSync(binary, ['--version'], { encoding: 'utf8' });
  if (probe.status !== 0) return undefined;
  return { binary, version: probe.stdout.trim() };
}

// Checks (or with `fix`, formats) the C++ lines changed since `base`, and the
// whole of any untracked C++ file. Returns the offending files, or undefined
// when clang-format is not installed.
export function checkClangFormat({ cwd, base, files, fix = false }) {
  const clangFormat = clangFormatBinary();
  if (!clangFormat) return undefined;
  if (!clangFormat.version.includes(`version ${CLANG_FORMAT_VERSION}`)) {
    console.warn(
      `warning: ${clangFormat.version}; CI uses clang-format ${CLANG_FORMAT_VERSION} ` +
        `(pip install clang-format==${CLANG_FORMAT_VERSION}), so results may differ`,
    );
  }
  const isCpp = (file) => CLANG_FORMAT_EXTENSIONS.includes(path.extname(file).slice(1));
  const offenders = new Set();

  const args = [
    'clang-format',
    `--binary=${clangFormat.binary}`,
    `--extensions=${CLANG_FORMAT_EXTENSIONS.join(',')}`,
  ];
  args.push(...(fix ? ['--force'] : ['--diff']), base, '--');
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  // Exit status 1 means "found something to format": a diff with --diff,
  // otherwise the list of files it rewrote.
  const reported = result.stdout?.startsWith(fix ? 'changed files:' : 'diff --git');
  if (result.error || (result.status !== 0 && !reported)) {
    throw new Error(
      `git clang-format failed (is git-clang-format on PATH?): ${result.stderr || result.error}`,
    );
  }
  for (const match of result.stdout.matchAll(/^diff --git a\/(\S+) /gm)) offenders.add(match[1]);
  if (fix) {
    // The rewritten files follow "changed files:", one per indented line.
    for (const line of result.stdout.split('\n')) {
      const file = line.trim();
      if (line.startsWith('    ') && isCpp(file)) offenders.add(file);
    }
  }

  const tracked = new Set(git(cwd, ['ls-files', '-z']).split('\0'));
  for (const file of files) {
    if (!isCpp(file.path) || tracked.has(file.path)) continue;
    const check = spawnSync(
      clangFormat.binary,
      fix ? ['-i', file.path] : ['--dry-run', '--Werror', file.path],
      { cwd, encoding: 'utf8' },
    );
    if (fix || check.status !== 0) offenders.add(file.path);
  }
  return [...offenders].sort();
}

async function main(argv) {
  if (argv.includes('--clang-format-version')) {
    console.log(CLANG_FORMAT_VERSION);
    return 0;
  }
  const fix = argv.includes('--fix');
  const baseIndex = argv.indexOf('--base');
  const requested = baseIndex >= 0 ? argv[baseIndex + 1] : undefined;
  if (baseIndex >= 0 && !requested) {
    console.error('--base needs a commit');
    return 2;
  }

  let base = resolveBase(repoRoot, requested);
  if (!base && requested) {
    // A push that rewrote history can name a commit the clone does not have;
    // the newest commit is still worth checking.
    base = tryGit(repoRoot, ['rev-parse', '--verify', 'HEAD^'])?.trim();
    if (base) console.warn(`warning: ${requested} is not available; checking HEAD^..HEAD`);
  }
  if (!base) {
    console.error('no base commit to compare against; pass --base <commit>');
    return 2;
  }

  const files = changedFiles(repoRoot, base);
  const prettierOffenders = await checkPrettier({ cwd: repoRoot, base, files, fix });
  const clangOffenders = checkClangFormat({ cwd: repoRoot, base, files, fix });
  if (clangOffenders === undefined) {
    const message =
      `clang-format not found; C++ formatting was not checked ` +
      `(pip install clang-format==${CLANG_FORMAT_VERSION})`;
    if (process.env.CI) {
      console.error(`error: ${message}`);
      return 1;
    }
    console.warn(`warning: ${message}`);
  }

  const offenders = [...prettierOffenders, ...(clangOffenders ?? [])];
  if (fix) {
    for (const file of offenders) console.log(`formatted ${file}`);
    return 0;
  }
  if (offenders.length === 0) {
    console.log(`formatting OK (${files.length} changed files since ${base.slice(0, 12)})`);
    return 0;
  }
  for (const file of prettierOffenders) console.error(`not Prettier-formatted: ${file}`);
  for (const file of clangOffenders ?? [])
    console.error(`changed lines not clang-formatted: ${file}`);
  console.error('run `pnpm format` to fix');
  return 1;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
