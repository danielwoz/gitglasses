# GitHub front door

The repository page is where people land from the Marketplace and Open VSX
"Repository" links. These settings are not in the code, so a repository
admin applies them once. `scripts/github-front-door.sh` prints the `gh`
commands for everything that has an API; run it with `--apply` to make the
changes.

```sh
scripts/github-front-door.sh            # print what would change
scripts/github-front-door.sh --apply    # change it (needs admin on the repository)
```

## What the script sets

| Setting | Value | Why |
| --- | --- | --- |
| Description | "Free, open-source git toolkit for VS Code and Open VSX: inline blame, Commit Graph, history, commit search, rebase and worktrees. No account, no telemetry." | Shown under the repository name and in search results; empty today. |
| Website | the Marketplace listing | One click from the repository to installing it. |
| Topics | `vscode-extension`, `open-vsx`, `vscodium`, `git`, `git-blame`, `git-history`, `commit-graph`, `interactive-rebase`, `libgit2`, `developer-tools` | Topic pages and GitHub search. No other product's name. |
| Discussions | on | The extension's Q&A link (`qna` in `extension/package.json`) points at Discussions. Until they are on, that link is a 404. |
| Wiki | off | The wiki is empty; the docs live in `docs/`. |
| Private vulnerability reporting | on | `SECURITY.md` asks for private reports, and the extension stores forge tokens. |
| Release notes | each changelog section, for the releases that predate notes taken from the changelog (0.1.x, and 0.2.0 if its release was published without them) | Release pages say what changed instead of only a compare link. The release workflow fills them in from 0.3 on (`scripts/release-notes.mjs`). |

## By hand

These have no API, or need a decision first:

- **Social preview image** (Settings › General › Social preview): a 1280×640
  PNG of the Commit Graph, so links shared in chat show a picture. The
  listing screenshots in `extension/media/screenshots/` are a good source.
- **Discussions categories:** keep Q&A, Ideas and Announcements; delete the
  rest. Pin a "Getting started" post that links the extension README.
- **npm names:** releases do not publish `gitglasses-mcp` to npm for now, so
  no npm credentials are needed. Reserving the names is still worthwhile, so
  nobody else takes them; see
  [step 8 of the one-time setup](releasing.md#8-npm-reserve-the-names).
- **Screenshots:** commit the images that
  `extension/media/screenshots/README.md` lists to `main` before publishing
  0.3; the store listings load them from there.

## Already in the repository

`CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`, issue forms for bugs
and feature requests, and a pull request template with the clean-room
attestation are committed, so the community profile only needs the settings
above.
