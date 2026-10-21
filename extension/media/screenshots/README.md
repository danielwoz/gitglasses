# Listing screenshots

The extension README and the repository README show the images below by
these exact names. The Marketplace and Open VSX listings load them from
`https://raw.githubusercontent.com/danielwoz/gitglasses/main/extension/media/screenshots/`,
so they must be committed to `main` before a release is published. They are
not packaged into the VSIX (`.vscodeignore` leaves this folder out).

Capture each at 1600×1000 (hero) or 1200×750, as PNG (the stores reject SVG),
in the Dark Modern theme unless noted, with a real repository rather than a
toy one, and keep the file under 500 KB.

| File | Shows | Used in |
| --- | --- | --- |
| `hero-graph.png` | The Commit Graph on a repository with merges and tags, with a commit's details (message, files, stats) open | extension README (top), repository README (top) |
| `blame.png` | Inline blame on the current line and the blame hover with the full commit message | extension README (Blame), repository README |
| `history.png` | Visual File History for a file with a few dozen revisions | extension README (File and line history), repository README |
| `search.png` | Search & Compare listing the commits found by a `change:` search, with the query in the header | extension README (Search commits), repository README |
| `launchpad.png` | Launchpad with pull requests grouped by what they need | extension README (Launchpad) |
| `ai-commit-message.png` | The Source Control view with the sparkle button and a generated multi-line message in the commit box | extension README (AI), repository README |

## How the current set was captured

Each image is the real extension, run under development with the release
engine in VS Code 1.142.0 on a 1600×1000 display, with a clean user-data
directory and the Dark Modern theme.

- `hero-graph.png`: a shared clone of git/git with `master` and
  `origin/master` at 106bdd26a, the first merge after v2.56.0, and a local
  `maint` tracking `origin/maint`, so branches, merges and the release tag
  fit on one screen. The details pane shows the checked-out merge.
- `blame.png`: git/git's `date.c` at line 110, cropped from the editor area.
- `history.png`: git/git's `editor.c` (45 revisions), in a 1200×750 window.
- `search.png`: `change:wait_for_pager file:pager.c` on git/git, with the
  second result open in the Commit Details panel.
- `ai-commit-message.png`: a staged change to git/git's `pager.c`. The
  provider is Ollama, answered by a local stand-in server that returns a
  fixed message.
- `launchpad.png`: a small fixture repository with fixture identities,
  connected as GitHub Enterprise Server to a local stand-in server that
  returns fixture pull requests.
