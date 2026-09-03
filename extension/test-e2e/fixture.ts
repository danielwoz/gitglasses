// Shared description of the deterministic git fixture: the runner
// (runTests.ts) creates a workspace matching these values and the suite
// asserts against them.
//
// Repository shape (3 commits, one rename, one dirty file):
//   commit 1: adds alpha.txt, tracked.txt, beta.txt
//   commit 2: rewrites alpha.txt to its final contents
//   commit 3: renames beta.txt -> gamma.txt
//   working tree: tracked.txt has an uncommitted trailing edit
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
} as const;
