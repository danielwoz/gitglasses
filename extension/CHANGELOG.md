# Changelog

All notable changes to GitGlasses are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Releases with an
even minor version (0.2.x) are stable; odd minor versions (0.3.x) ship on the
pre-release channel.

## [0.2.0]

### Security

- Integration tokens for a self-managed GitLab, for GitHub or Bitbucket on a
  custom domain, or for Azure DevOps Server were sent to gitlab.com,
  api.github.com, api.bitbucket.org or dev.azure.com in 0.1.1 and 0.1.2.
  Tokens now go only to the host they were set up for, and a request that
  would carry a token anywhere else is refused before it is sent. If you
  connected one of these integrations, revoke and replace that token (see
  docs/security-advisories.md).
- Stage All and hunk staging now store exactly what `git add` and
  `git apply --cached` would. Before, raw working-tree bytes bypassed Git LFS,
  git-crypt, clean filters and working-tree-encoding, so secrets meant to be
  encrypted could be committed and pushed in plain text.
- Restricted Mode: in an untrusted workspace GitGlasses runs no git at all,
  so nothing a repository configures (hooks, filters, fsmonitor, diff
  drivers, ssh commands) can run. Blame, history and the commit graph still
  work; commands that change the repository or contact a remote are disabled
  until you trust the folder, which restarts the engine with git enabled.
- gitglasses-mcp serves only the client's workspace roots by default and
  reads them without running git. Use `--allow <dir>` (or
  `GITGLASSES_ALLOWED_ROOTS`) to serve other directories with git enabled.
- git child processes no longer inherit the engine's pipes or a controlling
  terminal, so a hook or prompt can't stall or hang an operation.
- The engine builds against libgit2 1.9.7, which fixes unbounded memory
  allocation when reading crafted pack data.
- Repository content is escaped before it reaches hovers, settings that
  choose an executable or endpoint are read only from user settings in
  untrusted workspaces, and option-like branch, remote and path values are
  rejected.

### Fixed

- Windows: the 0.1.2 win32-x64 and win32-arm64 packages contained the
  engine's import library instead of the engine, so nothing engine-backed
  worked. Each package now carries one engine, checked to be an executable
  for its platform and started before a release ships.
- Blame, hovers, CodeLens, staging and open-on-remote work in workspaces
  opened through a symlink, a Windows 8.3 short path, a junction, a subst
  drive or different letter case. Before, they silently did nothing.
- Files in submodules and nested clones resolve to their own repository, and
  views find repositories below a workspace folder (following
  `git.repositoryScanMaxDepth`, `git.repositoryScanIgnoredFolders` and
  `git.detectSubmodules`).
- Windows opened on a linked worktree refresh after commits, fetches and ref
  or stash changes.
- Status and the graph no longer report out-of-cone sparse-checkout files as
  deleted, touched LFS, git-crypt or UTF-16 files as modified, or submodules
  with only local edits as changes.
- Staging paths are matched literally (`app/[id]/page.tsx` no longer matches
  `app/i/page.tsx`); hunk staging on a submodule no longer crashes the
  engine; a cancelled stage no longer leaves `.git/index.lock` behind.
- PR chips and Suggest Change no longer pick up another fork's pull request
  for a branch with the same name, and Suggest Change refuses when the file
  differs from the pull request head. Its fallback shares a patch of only the
  suggested lines, never your working tree.
- Bitbucket Data Center, Azure DevOps and Jira Cloud integrations work, and
  GitLab.com and Bitbucket Cloud need no hostname.
- Fetches, pulls and pushes that take longer than a minute are no longer
  reported as failed while they go on to succeed.
- A git command that hangs no longer blocks blame, status and staging for the
  same repository.
- Discovery and blame failures are written to the GitGlasses output channel.

### Added

- Open VSX: GitGlasses is published to Open VSX as well as the Visual Studio
  Marketplace, for VSCodium, Cursor, Windsurf, Theia, code-server, Gitpod and
  other Open VSX hosts.
- Browser: a `web` package for vscode.dev and github.dev (read-only,
  WebAssembly engine).
- Alpine Linux: `alpine-x64` and `alpine-arm64` packages with a fully static
  engine.
- Connect Integration offers the hosts found in your remotes; Start Work from
  GitHub Issues.
- Stage and unstage individual hunks from the editor.
- Open files and commits on GitHub, GitHub Enterprise, GitLab, Bitbucket and
  Azure DevOps, and copy their links.
- A changes annotation, a Get Started walkthrough, conflict indicators, and
  a repository picker for multi-root workspaces.
- MCP server: `git_diff` and `git_refs` tools, diffs in `git_commit_show`,
  paging cursors, and read-only and destructive hints on every tool.

### Changed

- Packages are smaller: native engines ship without debug information.
- The package includes its license, third-party notices and this changelog,
  and the listing has an icon.
- Opening the sidebar issues fewer engine requests, and later pages of the
  commit graph load from a cache.

## [0.1.2] - 2026-07-25

### Fixed

- Race conditions, memory leaks and slow paths in the engine and extension.

## [0.1.1] - 2026-07-23

### Added

- Packages for macOS (Intel and Apple silicon), Windows (x64 and arm64) and
  Linux arm64, with a Linux engine that runs on glibc 2.28 and newer.

## [0.1.0] - 2026-07-23

- First release, for Linux x64.
