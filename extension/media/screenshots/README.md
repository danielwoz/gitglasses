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
