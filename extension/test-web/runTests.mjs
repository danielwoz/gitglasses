#!/usr/bin/env node
// Web smoke harness: bundles the suite for the worker extension host, builds
// a deterministic git fixture repo, and drives VS Code for the Web in
// headless chromium via @vscode/test-web. The fixture folder is served at
// vscode-test-web://mount (including .git), which the extension mirrors into
// the wasm engine's MEMFS.
//
// Usage: node test-web/runTests.mjs   (run `node esbuild.mjs` first, or use
// the package script: pnpm test:web)

import { runTests } from '@vscode/test-web';
import esbuild from 'esbuild';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const extensionDevelopmentPath = resolve(here, '..');

const webBundle = join(extensionDevelopmentPath, 'dist', 'web', 'extension.js');
if (!existsSync(webBundle)) {
  console.error('[test-web] dist/web/extension.js missing; run `node esbuild.mjs` first');
  process.exit(2);
}

// The @playwright/browser-chromium build script is disabled workspace-wide;
// browsers live in the shared playwright cache instead. playwright is a
// transitive dependency of @vscode/test-web, so resolve it from there.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = createRequire(require.resolve('@vscode/test-web/package.json'))('playwright');
try {
  if (!existsSync(chromium.executablePath())) throw new Error('not downloaded');
} catch {
  console.error(
    '[test-web] chromium not found; download it once with: npx playwright install chromium',
  );
  process.exit(2);
}

// ---------------------------------------------------------------- suite
const suiteOut = join(here, 'dist', 'suite.js');
await esbuild.build({
  entryPoints: [join(here, 'suite', 'index.ts')],
  bundle: true,
  outfile: suiteOut,
  external: ['vscode'],
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  sourcemap: 'inline',
});

// --------------------------------------------------------------- fixture
// Same shape as the wasm engine harness: two commits by two authors on
// app.txt so blame attribution is line-distinguishable.
const ALICE = { GIT_AUTHOR_NAME: 'Alice', GIT_AUTHOR_EMAIL: 'alice@example.com' };
const BOB = { GIT_AUTHOR_NAME: 'Bob', GIT_AUTHOR_EMAIL: 'bob@example.com' };

function git(cwd, args, extraEnv = {}, tick = 0) {
  const date = `@${1700000000 + 60 * tick} +0000`;
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_COMMITTER_NAME: 'Fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.com',
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_DATE: date,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
      ...extraEnv,
    },
  });
}

const scratch = mkdtempSync(join(tmpdir(), 'gg-web-test-'));
process.on('exit', () => rmSync(scratch, { recursive: true, force: true }));
const fixture = join(scratch, 'repo');
git(scratch, ['init', '-q', '-b', 'main', 'repo']);
writeFileSync(join(fixture, 'app.txt'), 'one\ntwo\n');
git(fixture, ['add', 'app.txt']);
git(fixture, ['commit', '-q', '-m', 'add app'], ALICE, 1);
writeFileSync(join(fixture, 'app.txt'), 'one\ntwo\nthree\n');
git(fixture, ['add', 'app.txt']);
git(fixture, ['commit', '-q', '-m', 'extend app'], BOB, 2);
console.log(`[test-web] fixture repo at ${fixture}`);

// ----------------------------------------------------------------- launch
try {
  await runTests({
    browserType: 'chromium',
    headless: true,
    quality: 'stable',
    extensionDevelopmentPath,
    extensionTestsPath: suiteOut,
    folderPath: fixture,
    // Sidestep dev servers commonly parked on the default port 3000.
    port: Number(process.env.GG_TEST_WEB_PORT ?? 3271),
  });
  console.log('[test-web] web smoke suite passed');
} catch (error) {
  console.error(`[test-web] failed: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
}
