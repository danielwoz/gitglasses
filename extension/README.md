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
  triaged by actionability; **Start Work** from Jira/Linear/GitHub issues
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
