# Changelog

All notable changes to GitGlasses are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Releases with an
even minor version (0.2.x) are stable; odd minor versions (0.3.x) ship on the
pre-release channel.

## [0.2.0]

### Fixed

- Windows: the 0.1.2 packages for win32-x64 and win32-arm64 contained the
  engine's import library in place of the engine, so blame, history, the
  commit graph and every other engine-backed feature failed to start. Each
  package now carries exactly one engine, checked to be an executable for its
  platform, and every packaged engine is started before a release ships.
- The engine reports the same version as the extension it ships in.
- Security: repository content is escaped before it reaches hovers;
  settings that choose an executable, a network endpoint or a link target are
  read from user settings only in untrusted workspaces; branch, remote and
  path values that look like git options are rejected; malformed or oversized
  engine input no longer crashes the engine.
- Credentials for self-hosted forges and trackers are only sent to validated
  hosts over https, and provider requests honour rate limits.
- A git command that hangs (for example an unreachable remote) no longer
  blocks blame, status and staging for the same repository.
- Unstaging the hunk under the cursor no longer picks a different hunk when
  the file also has unstaged edits.

### Added

- Open VSX: GitGlasses is published to Open VSX as well as the Visual Studio
  Marketplace, so VSCodium, Cursor, Windsurf, Theia, code-server, Gitpod and
  other Open VSX hosts can install it.
- Browser: a `web` package lets vscode.dev and github.dev install the
  read-only, WebAssembly-powered GitGlasses.
- Alpine Linux: `alpine-x64` and `alpine-arm64` packages with a fully static
  engine, for Alpine-based dev containers and remotes.
- Stage and unstage individual hunks from the editor.
- Open files and commits on GitHub, GitHub Enterprise, GitLab, Bitbucket and
  Azure DevOps, and copy their links.
- A changes annotation marks the lines that are not yet committed.
- Add Integration and Remove Integration commands configure self-hosted
  forges and issue trackers without editing settings by hand.
- A Get Started walkthrough, keybindings for the most-used commands, and
  welcome content in the views.
- Conflicts show in the status bar and on the home card, and multi-root
  workspaces let you pick the active repository.
- MCP server: `git_diff` and `git_refs` tools, diffs in `git_commit_show`,
  paging cursors, and read-only and destructive hints on every tool.

### Changed

- Packages are smaller: native engines ship without debug information.
- The extension package includes its license, third-party notices and this
  changelog, and the listing has an icon.
- Opening the sidebar issues fewer, concurrent engine requests, and later
  pages of the commit graph load from a cache.

## [0.1.2] - 2026-07-25

### Fixed

- Race conditions, memory leaks and slow paths in the engine and extension.

## [0.1.1] - 2026-07-23

### Added

- Packages for macOS (Intel and Apple silicon), Windows (x64 and arm64) and
  Linux arm64, with a Linux engine that runs on glibc 2.28 and newer.

## [0.1.0] - 2026-07-23

- First release, for Linux x64.
