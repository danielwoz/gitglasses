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
- **Interactive Rebase Editor**: reorder by drag-drop or Alt+↑/↓; pick,
  reword, edit, squash, fixup, drop and autosquash. It checks the working tree
  first (offering to stash), refuses a plan the branch has moved past, and
  pauses on conflicts with Continue, Skip and Abort while you fix the files.
  It can also edit the list of a `git rebase -i` run in a terminal
- **Sidebar suite**: Commits, Branches (with PR chips), Remotes, Stashes,
  Tags, File & Line History, Contributors, Search & Compare, Worktrees. Act
  from the tree: switch, create, rename, delete, merge, rebase, push and
  compare branches; create, push and delete tags; apply, pop, drop and show
  stashes; fetch, prune, add and remove remotes
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

- `gitglasses.currentLine.enabled` — inline blame on/off
- `gitglasses.codeLens.enabled` — CodeLens on/off
- `gitglasses.engine.path` — override the bundled engine binary
- `gitglasses.engine.logLevel` — engine logging to the GitGlasses output channel
- `gitglasses.rebaseEditor.enabled` — open the todo of a `git rebase -i` started
  outside GitGlasses in the rebase editor (git must use VS Code as its editor,
  e.g. `git config --global sequence.editor "code --wait"`); off by default
