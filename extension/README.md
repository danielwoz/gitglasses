# GitGlasses

Open-source git supercharger for VS Code, powered by a native analysis
engine. MIT licensed, no account, no cloud — your tokens and your code never
leave your machine.

## Features

- **Inline blame**, status bar blame, rich hovers with autolinked issues
- **Gutter annotations**: whole-file blame and change-recency heatmap
- **Git CodeLens** above files and symbols
- Blame that understands **unsaved edits** (dirty buffers blame correctly)
- **Commit Graph**: virtualized canvas, ref chips, drag-free mutation actions
  (merge, rebase, cherry-pick, reset, revert) behind explicit confirmations
- **Interactive Rebase Editor**: drag-drop reorder, squash, reword, drop
- **Sidebar suite**: Commits, Branches (with PR chips), Remotes, Stashes,
  Tags, File & Line History, Contributors, Search & Compare, Worktrees
- **Visual File History**: bubble-chart timeline of a file's evolution
- **Launchpad**: your PRs across GitHub, GitLab, Bitbucket, Azure DevOps,
  triaged by actionability; **Start Work** from Jira Cloud, Linear or GitHub
  issues
- **Open Patches**: share WIP/stashes/commits as portable patch envelopes
  (file, Gist, or Snippet), applied 3-way on any machine
- **PR suggestions** from your editor selection
- **AI (bring your own key or fully offline)**: explain commits/WIP, generate
  commit messages, natural-language commit search — Anthropic, OpenAI-compatible,
  Gemini, Ollama, or VS Code language models
- **MCP server** (`gitglasses-mcp`) exposing repo intelligence to AI tools
- Crash-isolated native engine: fast on huge repos, and a crash never takes
  down VS Code

## Requirements

`git` ≥ 2.34 on PATH. The native engine binary ships inside the extension for
your platform.

## Settings

Blame:

- `gitglasses.currentLine.enabled` — inline blame on/off (also flipped by
  **GitGlasses: Toggle Inline Blame**)
- `gitglasses.currentLine.format` — inline blame text; tokens `${author}`,
  `${email}`, `${date}`, `${ago}`, `${summary}`, `${sha}`
- `gitglasses.statusBar.blame` — `auto` (default) shows status bar blame
  unless VS Code's own Git blame item (`git.blame.statusBarItem.enabled`) is
  on, so the same line is never described twice; `show` or `hide` to choose
  yourself. The GitGlasses item's tooltip is the full hover and a click opens
  the commit
- `gitglasses.statusBar.format` — status bar text, same tokens
- `gitglasses.hovers.enabled` — blame hovers on/off
- `gitglasses.blame.dateStyle` — `relative`, `absolute` or `iso` for `${date}`
- `gitglasses.blame.ignoreWhitespace` — `git blame -w`
- `gitglasses.blame.detectMovedLines` — `off`, `withinFile` (`-M`) or
  `acrossFiles` (`-C`)
- `gitglasses.blame.useIgnoreRevsFile` — honour git's `blame.ignoreRevsFile`,
  or the repository's `.git-blame-ignore-revs` when that is unset (on by
  default)
- `gitglasses.codeLens.enabled` — CodeLens on/off

Blame follows git: `.mailmap` names, ignore-revs files, and unsaved edits
(new lines show as uncommitted). Files tracked with Git LFS show where their
content last changed instead of line blame, since git only stores a pointer
for them. Blame pauses while a file has more than 8 MB of unsaved changes.

Other:

- `gitglasses.engine.path` — override the bundled engine binary
- `gitglasses.engine.logLevel` — engine logging to the GitGlasses output channel
