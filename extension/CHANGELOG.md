# Changelog

All notable changes to GitGlasses are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Releases with an
even minor version (0.2.x) are stable; odd minor versions (0.3.x) ship on the
pre-release channel.

## [0.4.1] - 2026-10-26

### Upgrading from 0.1.2

- 0.2.0 and 0.3.0 were not published, so this release also brings everything
  listed under them below. If you connected a self-managed GitLab, GitHub or
  Bitbucket on a custom domain, or Azure DevOps Server in 0.1.1 or 0.1.2,
  read the first 0.2.0 security note: that token should be replaced.

### Agents over MCP

- The MCP server now ships inside GitGlasses. VS Code 1.101 and newer and
  Cursor hand it to their agents with no setup, running on the editor's own
  Node with the bundled engine. In a trusted workspace git may run in the
  workspace's folders; in Restricted Mode it runs nowhere. Turn it off with
  `gitglasses.mcp.enabled`.
- **Add MCP Server to Claude Code**, **Add MCP Server to Codex** (shows the
  change to `~/.codex/config.toml` before writing it, and keeps a symlinked
  config a link) and **Copy MCP Server Config** cover other agents. The Home
  view shows where the server is registered.
- New tools: `git_compare` (a branch against another, measured from their
  merge base), `git_worktrees`, `git_provenance` and `git_line_story`.
- `git_log_search` finds commits by code change (`git log -S`/`-G`), path and
  date; `git_file_history` can follow a range of lines; `create_patch` takes
  any revision after `commit:`; `list_my_prs` also covers GitLab, Bitbucket
  and Azure DevOps.
- The server takes `--read <dir>` for clients that share no folders. In a
  partial clone read without git, line counts the clone can't know are shown
  as unknown instead of +0 -0.
- Releases also pack per-platform engine packages (`@gitglasses/engine-*`),
  so `gitglasses-mcp` from npm needs no `GITGLASSES_ENGINE`.
- The server needs Node.js 20 or newer: the editor's own Node, or `node` on
  `PATH` in editors whose own Node is older or turned off.

### Line Story

- **Why this line?**, the first link in the blame hover and also in the
  editor's context menu, opens a Line Story beside the editor: the line's
  blame, its commit in full, the pull request that merged it (state, merge
  date, review and comment counts, the start of its description), the issues
  they name, and the line's earlier versions, each with its diff.
- Pull requests come from GitHub, GitHub Enterprise Server and GitLab once
  connected. Without a connection the panel links the pull request the
  commit message names; for forges that can't look pull requests up by commit
  it says so. In Restricted Mode it shows the blame and the commit.
- Show Line History for Selection shows each commit's real +/− counts for the
  selected lines and follows renames.

### Declared AI provenance

- Commits that declare an AI agent took part show an **AI** badge in the
  Commit Graph, a line in the blame hover, a Provenance row in Commit Details
  and a mark in the Commits and File History views. A graph filter dims all
  but agent-declared commits, or all but the rest.
- Only declarations are read: git-ai notes, `Co-authored-by` trailers naming
  a known agent, `Assisted-by` and `Generated-by` trailers that name an AI,
  session-link trailers, and known agent identities as author or committer.
  Nothing is inferred from the code. `gitglasses.provenance.enabled` hides it
  everywhere.
- **Fetch git-ai Notes with Every Fetch…** brings a remote's notes into
  `refs/notes/ai-remote/<remote>`, so your own `refs/notes/ai` is never
  overwritten.

### Worktrees

- Each worktree shows its uncommitted changes, commits ahead of and behind a
  base branch, whether it would merge cleanly (`git merge-tree`, git 2.38 or
  later, without touching any checkout) and the coding tool working in it.
  Statuses follow git activity, refresh every minute while the view is open
  and when you return to the window.
- New actions: **Compare with Base** opens everything a worktree changed,
  uncommitted and untracked work included, in one diff; **Remove Worktree and
  Branch…** lists what goes, including commits that would be lost, in one
  confirmation; **Choose Base for Worktrees…** picks the branch to compare
  with.
- The Worktrees view works in Restricted Mode, reading worktrees through
  libgit2 the way git does, with the merge check skipped.

### Fixed

- Compare with Working Tree in the Branches view shows untracked and newly
  added files as added instead of failing to load them.
- Launchpad: your own pull requests with changes requested appear under
  Changes Requested on connections stored with only a token, such as GitHub
  Enterprise and Bitbucket Data Center.
- Commit Graph details and Commit Details show each trailer once, in the
  trailers list; the blame hover puts each trailer on its own line.
- Visual File History shortens long author names with an ellipsis and shows
  the full name on hover.

### Other

- **Select Repository** takes a repository's root path as its argument, so a
  keybinding can switch straight to one.

## [0.3.0]

### Commit Graph

- Consecutive commits are joined by lines, and history is laid out like
  `git log --graph --topo-order`. On git/git the first 200 rows need 16
  columns instead of 105, and lanes past `gitglasses.graph.maxLanes` fold
  into one column so messages stay readable.
- Clicking a commit opens a details pane: full message, trailers, author and
  committer, parents, refs and changed files. Click a file to diff it, open
  all changes at once, or Ctrl/Cmd-click two commits to compare them.
- Branch and tag chips have menus (checkout, merge, rebase, rename, delete,
  push), a find box searches every branch shown, and a branch filter narrows
  the graph.
- Refreshes keep scroll position and selection. The graph follows Select
  Repository, survives engine restarts and window reloads, and has full
  keyboard and screen-reader support.

### Blame

- Blame stays right while you edit, after save or revert, in large files and
  for files with identical contents.
- `.git-blame-ignore-revs`, `.mailmap`, ignore-whitespace and moved-line
  detection are honoured, and a missing ignore-revs file never breaks blame.
- The hover shows the full message, both dates, the pull request when the
  message names one, and links to Details, Changes, Blame Previous Revision,
  Copy SHA and Open on Remote.
- Inline and status bar text, date style and delay are configurable, and the
  status bar item steps aside when VS Code's own blame item is showing.

### Works with VS Code's Git

- No more empty "GitGlasses" Source Control entry, so the built-in Source
  Control Graph and status bar items work as usual.
- No default shortcuts take over Ctrl+Shift+G; opt in with
  `gitglasses.keyboardShortcuts.enabled`.
- Fewer views open by default, the command palette offers only commands that
  can act, and Theia shows your repository instead of an empty state.
- "Coming from Git Graph?" copies matching Git Graph settings, and a Source
  Control title button opens the graph.

### Push, pull and signing

- git's prompts appear in the editor: HTTPS credentials, ssh passphrases and
  new host keys, and passphrases for signing keys.
- Network operations show progress with Cancel, publishing picks the right
  remote, diverged pulls offer merge or rebase, and stopped merges and
  rebases offer Continue, Skip and Abort.
- Cancelled commands no longer leave `index.lock` behind, slow fetches no
  longer stall hovers and the graph, and a crashing engine is no longer
  restarted forever.

### Branches, tags, stashes and rebase

- The Branches, Tags, Stashes and Remotes views are actionable, and clicking
  a commit opens its details.
- Interactive rebase applies messages to the right commits, never drops
  commits made while it was open, works with `rebase.updateRefs` and
  autosquash, offers to stash first, and pauses on conflicts with Continue,
  Skip and Abort.

### AI and search

- AI works on every editor: the first AI command offers what the editor can
  use (editor models, Ollama, or your own key), with current models and APIs.
- Explain Commit sends the real diff, AI output never loads images or HTML,
  and Generate Commit Message writes into the Source Control box.
- Search Commits finds commits by author, code change, file and date, with
  progress and Cancel.

### Performance and correctness

- History pages instantly in very large repositories, renames are detected
  the way git does, and partial clones download what they need instead of
  showing 0/0.
- Polling watchers no longer cost CPU in repositories with thousands of
  branches, and patches apply regardless of diff settings.

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
