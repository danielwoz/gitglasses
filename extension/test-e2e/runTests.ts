// End-to-end test entry point: downloads a pinned VS Code release, builds a
// deterministic git fixture workspace, and launches the extension host with
// the compiled mocha suite (dist-e2e/suite/index).
//
// Environment:
//   GITGLASSES_E2E_ALIAS=0       open the fixture by its real path instead of
//                                through a symlink (Linux and macOS)
//   GITGLASSES_E2E_VSCODE=<ver>  run another VS Code: a release such as
//                                1.90.0 (the engines.vscode floor), 'stable'
//                                or 'insiders'
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { downloadAndUnzipVSCode, runTests } from '@vscode/test-electron';
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

interface Author {
  name: string;
  email: string;
}

const MAIN_AUTHOR: Author = { name: FIXTURE.authorName, email: FIXTURE.authorEmail };
const INNER_AUTHOR: Author = { name: FIXTURE.innerAuthorName, email: FIXTURE.innerAuthorEmail };

// Runs git with a pinned identity, pinned timestamps, and user/system config
// masked out, so every fixture repo is byte-for-byte reproducible.
function gitAs(author: Author, cwd: string, ...args: string[]): void {
  execFileSync('git', args, {
    cwd,
    stdio: 'pipe',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: author.name,
      GIT_AUTHOR_EMAIL: author.email,
      GIT_COMMITTER_NAME: author.name,
      GIT_COMMITTER_EMAIL: author.email,
      GIT_AUTHOR_DATE: '2024-01-02T03:04:05Z',
      GIT_COMMITTER_DATE: '2024-01-02T03:04:05Z',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: emptyGitConfig(),
      GIT_CONFIG_SYSTEM: emptyGitConfig(),
    },
  });
}

function git(cwd: string, ...args: string[]): void {
  gitAs(MAIN_AUTHOR, cwd, ...args);
}

function write(root: string, relative: string, contents: string): void {
  fs.writeFileSync(path.join(root, relative), contents);
}

// Hermetic against the host's git config. Git for Windows ships system-level
// core.autocrlf=true, which would rewrite the checked-out bytes and shift
// every line the blame assertions depend on. The C++ fixture pins the same
// settings for the same reason.
function initRepo(author: Author, root: string): void {
  gitAs(author, root, 'init');
  gitAs(author, root, 'config', 'core.autocrlf', 'false');
  gitAs(author, root, 'config', 'commit.gpgsign', 'false');
  gitAs(author, root, 'config', 'user.name', author.name);
  gitAs(author, root, 'config', 'user.email', author.email);
}

// A one-commit repository by the inner author holding `file`.
function createInnerRepo(root: string, file: string, contents: string): void {
  fs.mkdirSync(root, { recursive: true });
  initRepo(INNER_AUTHOR, root);
  write(root, file, contents);
  gitAs(INNER_AUTHOR, root, 'add', file);
  gitAs(INNER_AUTHOR, root, 'commit', '-m', `add ${file}`);
}

// Temp git repo with 4 commits, one rename, one dirty file, a submodule and a
// nested clone (see fixture.ts for the exact shape the suite asserts
// against). `scratch` receives the submodule's upstream.
function createFixtureWorkspace(enginePath: string, scratch: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gitglasses-e2e-'));

  initRepo(MAIN_AUTHOR, root);
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

  // A submodule: a file inside it belongs to the submodule's history, not the
  // parent's. Local-path submodules need file transport allowed explicitly.
  const upstream = path.join(scratch, 'submodule-upstream');
  createInnerRepo(upstream, FIXTURE.submoduleFile, FIXTURE.submoduleContents);
  git(
    root,
    '-c',
    'protocol.file.allow=always',
    'submodule',
    'add',
    '-q',
    upstream,
    FIXTURE.submoduleDir,
  );
  git(root, 'commit', '-m', 'add submodule');

  git(root, 'remote', 'add', FIXTURE.remoteName, FIXTURE.remoteUrl);

  // An unrelated clone inside the working tree, which the parent ignores.
  createInnerRepo(path.join(root, FIXTURE.nestedDir), FIXTURE.nestedFile, FIXTURE.nestedContents);
  fs.mkdirSync(path.join(root, '.git', 'info'), { recursive: true });
  fs.appendFileSync(path.join(root, '.git', 'info', 'exclude'), `/${FIXTURE.nestedDir}/\n`);

  write(root, FIXTURE.dirtyFile, FIXTURE.dirtyFileWorkingContents);

  fs.mkdirSync(path.join(root, '.vscode'));
  write(
    root,
    path.join('.vscode', 'settings.json'),
    JSON.stringify(
      {
        'gitglasses.engine.path': enginePath,
        'gitglasses.engine.logLevel': 'debug',
      },
      null,
      2,
    ),
  );
  return root;
}

// A repository that names a command everywhere git looks for one: a
// core.fsmonitor command, a clean/smudge filter and a textconv driver applied
// to every path, and hooks around commits and checkouts. Each command drops a
// file into `markers` when it runs. The commits are made before any of it is
// planted, so building the fixture runs none of them.
function createPlantedWorkspace(): { root: string; markers: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gitglasses-e2e-untrusted-'));
  const markers = fs.mkdtempSync(path.join(os.tmpdir(), 'gitglasses-e2e-markers-'));

  git(root, 'init');
  git(root, 'config', 'core.autocrlf', 'false');
  git(root, 'config', 'commit.gpgsign', 'false');
  write(root, FIXTURE.blameFile, FIXTURE.blameFileHeadContents);
  write(root, FIXTURE.dirtyFile, FIXTURE.dirtyFileCommittedContents);
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'add alpha and tracked');
  write(root, FIXTURE.dirtyFile, FIXTURE.dirtyFileWorkingContents);

  // Forward slashes read the same to git's config parser and to sh on every
  // platform.
  const marker = (name: string): string => `${markers.split(path.sep).join('/')}/${name}`;
  fs.appendFileSync(
    path.join(root, '.git', 'config'),
    [
      '[core]',
      `\tfsmonitor = "touch ${marker('fsmonitor')}; false #"`,
      '[filter "planted"]',
      `\tclean = "touch ${marker('clean')}; cat"`,
      `\tsmudge = "touch ${marker('smudge')}; cat"`,
      '[diff "planted"]',
      `\ttextconv = "touch ${marker('textconv')}; cat"`,
      '',
    ].join('\n'),
  );
  write(root, '.gitattributes', '* filter=planted diff=planted\n');
  for (const hook of ['pre-commit', 'post-commit', 'post-checkout', 'post-merge', 'pre-push']) {
    const file = path.join(root, '.git', 'hooks', hook);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `#!/bin/sh\ntouch ${marker(`hook-${hook}`)}\n`, { mode: 0o755 });
  }
  return { root, markers };
}

// Opens the planted workspace with workspace trust on and the startup prompt
// off, so the folder opens in Restricted Mode, as a downloaded folder would.
// runTests() always passes --disable-workspace-trust, so this launches the
// same VS Code build directly. The engine path is pinned in user settings:
// Restricted Mode ignores the workspace's own value for it.
function runUntrusted(vscodeExecutablePath: string, enginePath: string): void {
  const planted = createPlantedWorkspace();
  console.log(`[e2e] Restricted Mode workspace: ${planted.root}`);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'gitglasses-e2e-profile-'));
  const userData = path.join(profile, 'user-data');
  fs.mkdirSync(path.join(userData, 'User'), { recursive: true });
  fs.writeFileSync(
    path.join(userData, 'User', 'settings.json'),
    JSON.stringify({
      'security.workspace.trust.enabled': true,
      'security.workspace.trust.startupPrompt': 'never',
      'gitglasses.engine.path': enginePath,
      'gitglasses.engine.logLevel': 'info',
    }),
  );
  try {
    const result = spawnSync(
      vscodeExecutablePath,
      [
        '--no-sandbox',
        '--disable-gpu-sandbox',
        '--disable-updates',
        '--skip-welcome',
        '--skip-release-notes',
        '--disable-extensions',
        `--user-data-dir=${userData}`,
        `--extensions-dir=${path.join(profile, 'extensions')}`,
        `--extensionDevelopmentPath=${extensionDevelopmentPath}`,
        `--extensionTestsPath=${path.resolve(__dirname, 'suite-untrusted', 'index')}`,
        planted.root,
      ],
      { stdio: 'inherit', env: { ...process.env, GG_E2E_MARKERS: planted.markers } },
    );
    if (result.status !== 0) {
      throw new Error(`Restricted Mode run failed: exit ${result.status ?? result.signal}`);
    }
  } finally {
    for (const dir of [planted.root, planted.markers, profile]) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
}

// The path VS Code opens. On Linux and macOS it is a symlink to the fixture,
// so the editor and the engine (which resolves symlinks) spell the repository
// root differently. Windows CI gets the same mismatch from the 8.3 short name
// in os.tmpdir() (C:\Users\RUNNER~1\...), so the fixture path is used as is.
function workspaceSpelling(fixturePath: string, scratch: string): string {
  if (process.platform === 'win32' || process.env.GITGLASSES_E2E_ALIAS === '0') {
    return fixturePath;
  }
  const link = path.join(scratch, 'workspace');
  fs.symlinkSync(fixturePath, link, 'dir');
  return link;
}

/** The VS Code release the suite runs against unless GITGLASSES_E2E_VSCODE
 *  names another, so a run is not at the mercy of whatever stable is that
 *  day. Raise it deliberately. */
const PINNED_VSCODE = '1.142.0';

// VS Code's own logs, the GitGlasses output channel (engine stderr included)
// among them; CI uploads this directory when the suite fails.
const logsPath = path.join(extensionDevelopmentPath, '.vscode-test', 'logs');

async function main(): Promise<void> {
  const enginePath = findEngineBinary();
  console.log(`[e2e] engine binary: ${enginePath}`);

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'gitglasses-e2e-scratch-'));
  const fixturePath = createFixtureWorkspace(enginePath, scratch);
  const workspacePath = workspaceSpelling(fixturePath, scratch);
  const resolved = fs.realpathSync.native(workspacePath);
  const aliased = resolved !== workspacePath;
  console.log(
    `[e2e] fixture workspace: ${workspacePath}` + (aliased ? ` (resolves to ${resolved})` : ''),
  );
  fs.rmSync(logsPath, { recursive: true, force: true });
  console.log(`[e2e] VS Code logs: ${logsPath}`);
  const version = process.env.GITGLASSES_E2E_VSCODE || PINNED_VSCODE;
  console.log(`[e2e] VS Code: ${version}`);
  const vscodeExecutablePath = await downloadAndUnzipVSCode(version);

  try {
    await runTests({
      vscodeExecutablePath,
      extensionDevelopmentPath,
      extensionTestsPath: path.resolve(__dirname, 'suite', 'index'),
      // --disable-extensions turns off every installed extension while still
      // loading the development extension under test.
      launchArgs: [
        '--disable-workspace-trust',
        '--disable-extensions',
        '--logsPath',
        logsPath,
        workspacePath,
      ],
      extensionTestsEnv: {
        // Copies the GitGlasses log, engine stderr included, into this output.
        GITGLASSES_LOG_TO_CONSOLE: '1',
        GITGLASSES_E2E_ALIASED: aliased ? '1' : '0',
      },
    });
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
    fs.rmSync(fixturePath, { recursive: true, force: true });
  }

  runUntrusted(vscodeExecutablePath, enginePath);
}

main().catch((error) => {
  console.error('[e2e] failed:', error);
  process.exit(1);
});
