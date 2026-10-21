// Shared description of the deterministic git fixture: the runner
// (runTests.ts) creates a workspace matching these values and the suite
// asserts against them.
//
// Repository shape (4 commits, one rename, one dirty file):
//   commit 1: adds alpha.txt, tracked.txt, beta.txt
//   commit 2: rewrites alpha.txt to its final contents
//   commit 3: renames beta.txt -> gamma.txt
//   commit 4: adds the submodule sub/ (its own repository, one commit)
//   working tree: tracked.txt has an uncommitted trailing edit, and nested/ is
//   an independent clone the parent ignores
//
// On Linux and macOS the workspace is opened through a symlink to the
// fixture, the way Windows CI reaches its temp dir through the 8.3 short name
// RUNNER~1: the engine reports repository roots with such aliases resolved,
// and every file feature depends on mapping them back.
export const FIXTURE = {
  authorName: 'Ada Lovelace',
  authorEmail: 'ada@example.invalid',

  blameFile: 'alpha.txt',
  blameFileInitialContents: 'alpha one\nalpha two\nalpha three\n',
  blameFileHeadContents: 'alpha one\nalpha two revised\nalpha three\nalpha four\n',

  dirtyFile: 'tracked.txt',
  dirtyFileCommittedContents: 'tracked base\n',
  dirtyFileWorkingContents: 'tracked base\nlocal uncommitted edit\n',

  // A remote so the open-on-remote path resolves a real forge URL.
  remoteName: 'origin',
  remoteUrl: 'https://github.com/example/gitglasses-fixture.git',
  remoteOwner: 'example',
  remoteRepo: 'gitglasses-fixture',

  renameSource: 'beta.txt',
  renameTarget: 'gamma.txt',
  renameContents: 'beta body kept stable across the rename\n',

  // Repositories inside the workspace folder, authored by someone else so a
  // blame naming them proves the file resolved to the inner repository.
  innerAuthorName: 'Grace Hopper',
  innerAuthorEmail: 'grace@example.invalid',
  nestedDir: 'nested',
  nestedFile: 'inner.txt',
  nestedContents: 'nested clone line\n',
  submoduleDir: 'sub',
  submoduleFile: 'lib.txt',
  submoduleContents: 'submodule line\n',
} as const;
