# GitGlasses

Open-source git supercharger for VS Code, powered by a native analysis
engine. MIT licensed, no account, no cloud — your tokens and your code never
leave your machine.

## Features

- **Inline blame** on the current line, with status bar details
- **Rich hovers**: commit author, date, message, and rename tracking
- **Gutter annotations**: whole-file blame and change-recency heatmap
- **Git CodeLens**: authorship above files and symbols
- Blame that understands **unsaved edits** (dirty buffers blame correctly)
- Crash-isolated native engine: fast on huge repos, and a crash never takes
  down VS Code

More on the way: commit graph, file history views, interactive rebase editor,
PR launchpad, and the rest of the roadmap — see the repository README.

## Requirements

`git` ≥ 2.34 on PATH. The native engine binary ships inside the extension for
your platform.

## Settings

- `gitglasses.currentLine.enabled` — inline blame on/off
- `gitglasses.codeLens.enabled` — CodeLens on/off
- `gitglasses.engine.path` — override the bundled engine binary
- `gitglasses.engine.logLevel` — engine logging to the GitGlasses output channel
