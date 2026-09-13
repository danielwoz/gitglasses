// End-to-end test entry point: downloads VS Code stable, builds a
// deterministic git fixture workspace, and launches the extension host with
// the compiled mocha suite (dist-e2e/suite/index).
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import { runTests } from '@vscode/test-electron';
import { FIXTURE } from './fixture';

// Compiled location is extension/dist-e2e/runTests.js, so the extension root
// is one directory up.
const extensionDevelopmentPath = path.resolve(__dirname, '..');

// Repo-local engine build outputs. The extension's own dev fallback
// (findEngineBinary in src/extension.ts) resolves ../build/{release,debug}
// relative to the extension root and therefore finds the same binary when the
// extensionDevelopmentPath is this checkout's extension/ directory; the suite
// still pins the path explicitly through workspace settings so a stray
// bundled binary can never be picked up instead.
function findEngineBinary(): string {
  const suffix = process.platform === 'win32' ? '.exe' : '';
  for (const preset of ['release', 'debug']) {
    const candidate = path.resolve(
      extensionDevelopmentPath,
      '..',
      'build',
      preset,
      'engine',
      `gitglasses-engine${suffix}`,
    );
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(
    'gitglasses-engine not found under build/{release,debug}/engine. ' +
      'Build it first: cmake --preset release && cmake --build --preset release',
  );
}

// An empty file standing in for the user's global git config. os.devNull is
// \\.\nul on Windows, which git's path layer rewrites to //./nul and rejects.
let emptyConfigPath: string | undefined;
function emptyGitConfig(): string {
  if (!emptyConfigPath) {
    emptyConfigPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gg-gitconfig-')), 'empty');
    fs.writeFileSync(emptyConfigPath, '');
  }
  return emptyConfigPath;
}

// Runs git with a pinned identity, pinned timestamps, and user/system config
// masked out, so every fixture repo is byte-for-byte reproducible.
function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, {
    cwd,
    stdio: 'pipe',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: FIXTURE.authorName,
      GIT_AUTHOR_EMAIL: FIXTURE.authorEmail,
      GIT_COMMITTER_NAME: FIXTURE.authorName,
      GIT_COMMITTER_EMAIL: FIXTURE.authorEmail,
      GIT_AUTHOR_DATE: '2024-01-02T03:04:05Z',
      GIT_COMMITTER_DATE: '2024-01-02T03:04:05Z',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: emptyGitConfig(),
      GIT_CONFIG_SYSTEM: emptyGitConfig(),
    },
  });
}

function write(root: string, relative: string, contents: string): void {
  fs.writeFileSync(path.join(root, relative), contents);
}

// Temp git repo with 3 commits, one rename, and one dirty file (see
// fixture.ts for the exact shape the suite asserts against).
function createFixtureWorkspace(enginePath: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gitglasses-e2e-'));

  git(root, 'init');
  // Hermetic against the host's git config. Git for Windows ships
  // system-level core.autocrlf=true, which would rewrite the checked-out bytes
  // and shift every line the blame assertions depend on. The C++ fixture pins
  // the same settings for the same reason.
  git(root, 'config', 'core.autocrlf', 'false');
  git(root, 'config', 'commit.gpgsign', 'false');
  git(root, 'config', 'user.name', FIXTURE.authorName);
  git(root, 'config', 'user.email', FIXTURE.authorEmail);
  write(root, FIXTURE.blameFile, FIXTURE.blameFileInitialContents);
  write(root, FIXTURE.dirtyFile, FIXTURE.dirtyFileCommittedContents);
  write(root, FIXTURE.renameSource, FIXTURE.renameContents);
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'add alpha, tracked, beta');

  write(root, FIXTURE.blameFile, FIXTURE.blameFileHeadContents);
  git(root, 'add', FIXTURE.blameFile);
  git(root, 'commit', '-m', 'revise alpha');

  git(root, 'mv', FIXTURE.renameSource, FIXTURE.renameTarget);
  git(root, 'commit', '-m', 'rename beta to gamma');

  git(root, 'remote', 'add', FIXTURE.remoteName, FIXTURE.remoteUrl);

  write(root, FIXTURE.dirtyFile, FIXTURE.dirtyFileWorkingContents);

  fs.mkdirSync(path.join(root, '.vscode'));
  write(
    root,
    path.join('.vscode', 'settings.json'),
    JSON.stringify(
      {
        'gitglasses.engine.path': enginePath,
        'gitglasses.engine.logLevel': 'info',
      },
      null,
      2,
    ),
  );
  return root;
}

async function main(): Promise<void> {
  const enginePath = findEngineBinary();
  console.log(`[e2e] engine binary: ${enginePath}`);

  const workspacePath = createFixtureWorkspace(enginePath);
  console.log(`[e2e] fixture workspace: ${workspacePath}`);

  try {
    await runTests({
      version: 'stable',
      extensionDevelopmentPath,
      extensionTestsPath: path.resolve(__dirname, 'suite', 'index'),
      // --disable-extensions turns off every installed extension while still
      // loading the development extension under test.
      launchArgs: ['--disable-workspace-trust', '--disable-extensions', workspacePath],
    });
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error('[e2e] failed:', error);
  process.exit(1);
});
