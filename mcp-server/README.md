# gitglasses-mcp

MCP (Model Context Protocol) server exposing gitglasses repository insight as
tools: blame, log search, file history, commit show, diffs, refs, graph
summary, status, patch envelopes, and a Launchpad-classified pull request
list.

The server speaks MCP over stdio and drives a `gitglasses-engine` process
(spawned lazily on the first repository tool call).

## Tools

| Tool | Description |
| --- | --- |
| `git_blame` | Per-hunk author/date/sha/summary for a file or single line |
| `git_log_search` | Search commits by message, author, sha, code change (`git log -S`/`-G`), path or date, or list recent commits |
| `git_file_history` | File history following renames, or the commits that changed a range of lines (`git log -L`) |
| `git_commit_show` | Commit metadata + changed files with +/- counts |
| `git_diff` | Uncommitted changes as a unified diff, unstaged or staged, for the repository or one file |
| `git_refs` | Branches, remote-tracking branches and tags with the sha each points at |
| `git_compare` | A branch against another from their merge base: commits ahead and behind, changed files with +/- counts, optionally the diff |
| `git_graph_summary` | Lane-indented text rendering of the commit graph |
| `git_status` | Branch, ahead/behind, staged/unstaged/untracked/conflicted |
| `create_patch` | Patch envelope from `wip`, `stash:<n>` or `commit:<revision>` |
| `apply_patch` | Apply a patch to the working tree (**writes**) |
| `list_my_prs` | Open PRs involving you, grouped into launchpad buckets |

Every tool but `apply_patch` is read-only, and each declares that through MCP
tool annotations (`readOnlyHint`), so a client can gate or auto-approve on it.
`git_file_history`, `create_patch`, `apply_patch`, the code, path and date
filters of `git_log_search` and the diffs of `git_commit_show` and
`git_compare` need git, so they work only in repositories you allow (see
[Trust model](#trust-model)).

Tools that render a whole commit, diff, status, ref list or patch take a
`maxChars` argument and truncate with a footer naming the limit; `git_blame`
takes `limit` hunks.

## With the GitGlasses extension

The GitGlasses extension for VS Code and Open VSX editors ships this server
and its engine, so most people need no installation at all:

- **VS Code 1.101 or newer and Cursor**: the extension registers the server
  with the editor's agents (Copilot agent mode, Cursor's agent) as soon as a
  folder is open. It runs on the editor's own Node with the extension's
  engine. In a trusted workspace git may run in the workspace folders; in
  Restricted Mode it runs nowhere. The `gitglasses.mcp.enabled` setting
  turns this off.
- **Claude Code and Codex**: run **GitGlasses: Add MCP Server to Claude
  Code** (it uses `claude mcp add-json` for your user configuration) or
  **GitGlasses: Add MCP Server to Codex** (it shows the change to
  `~/.codex/config.toml` before writing it).
- **Any other agent** (Claude Desktop, Windsurf, Kiro, Theia AI and others):
  **GitGlasses: Copy MCP Server Config** copies an `mcpServers` entry with
  absolute paths to paste into the agent's settings.

Each command asks whether the agent may run git in the workspace's folders;
by default it may not, and the server reads the project the agent works in
without git. Many desktop apps share no folders with their servers, so the
configuration **Copy MCP Server Config** produces also names the workspace's
folders, to read without git (`--read`). The paths point into the installed
extension, so run the command again after GitGlasses updates. The Home view's **MCP Server**
section shows the registration and offers the same commands.

## Installation

`gitglasses-mcp` is not on npm yet. Until a release publishes it, do not run
`npx gitglasses-mcp`: npx would download and run whatever is published under
that name, with your tokens in its environment. Build the server from a clone
instead (Node.js 20.11 or newer, pnpm):

```sh
git clone https://github.com/danielwoz/gitglasses.git
cd gitglasses
pnpm install --frozen-lockfile
pnpm --filter "gitglasses-mcp..." build
```

The server is `mcp-server/dist/cli.js` in the clone; start it with `node`.

### The engine

The server drives the `gitglasses-engine` binary. Installed from npm, it
comes with the server: each platform's engine is a package of its own
(`@gitglasses/engine-linux-x64`, `@gitglasses/engine-darwin-arm64`, and so
on, with `-musl` builds for Alpine), listed as optional dependencies of
`gitglasses-mcp`, so npm installs only the one your machine needs and the
server finds it without any setting. Run from a clone, it needs an engine;
the GitGlasses extension ships one for your platform, so once the extension
is installed, point `GITGLASSES_ENGINE` at it:

| Editor | Engine |
| --- | --- |
| VS Code on Linux or macOS | `~/.vscode/extensions/gitglasses.gitglasses-<version>-<platform>/bin/gitglasses-engine` |
| VS Code on Windows | `%USERPROFILE%\.vscode\extensions\gitglasses.gitglasses-<version>-win32-x64\bin\gitglasses-engine.exe` |
| VSCodium | the same, under `~/.vscode-oss/extensions` |

Alternatively build the engine in the same clone (see the repository README):
a release build at `build/release/engine/` is found without any setting.

## Registration

Replace `/path/to/gitglasses` with the clone and `/path/to/gitglasses-engine`
with the engine.

### Claude Code

```sh
claude mcp add gitglasses \
  -e GITGLASSES_ENGINE=/path/to/gitglasses-engine \
  -- node /path/to/gitglasses/mcp-server/dist/cli.js
# Also let git run in the repositories under ~/code (file history, patches):
claude mcp add gitglasses \
  -e GITGLASSES_ENGINE=/path/to/gitglasses-engine \
  -- node /path/to/gitglasses/mcp-server/dist/cli.js --allow ~/code
```

### VS Code (`.vscode/mcp.json`)

```json
{
  "inputs": [
    { "type": "promptString", "id": "github-token", "description": "GitHub token", "password": true }
  ],
  "servers": {
    "gitglasses": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/gitglasses/mcp-server/dist/cli.js"],
      "env": {
        "GITGLASSES_ENGINE": "/path/to/gitglasses-engine",
        "GITGLASSES_ALLOWED_ROOTS": "${workspaceFolder}",
        "GITHUB_TOKEN": "${input:github-token}"
      }
    }
  }
}
```

## Environment variables

| Variable | Purpose |
| --- | --- |
| `GITGLASSES_ENGINE` | Absolute path to the `gitglasses-engine` binary. When unset, the server looks for the `@gitglasses/engine-*` package npm installed for this platform, then for a release build in the clone it runs from (`build/release/engine/`), then searches `PATH`. |
| `GITHUB_TOKEN` | GitHub token used by `list_my_prs` (preferred). |
| `GITGLASSES_GITHUB_TOKEN` | Fallback token when `GITHUB_TOKEN` is unset. |
| `GITGLASSES_GITHUB_HOST` | GitHub Enterprise hostname for `list_my_prs`. Must be a bare hostname. Defaults to `github.com`. |
| `GITGLASSES_ALLOWED_ROOTS` | Path-separator delimited directories the server reads and, via `apply_patch`, writes, with git allowed to run there. Same as passing each with `--allow`; `*` allows every path. Unset means the client's workspace roots, read without git (see [Trust model](#trust-model)). |

## Trust model

The server runs with the privileges of whoever starts it, and every tool takes
an absolute `repoPath`. Two questions decide what a call may do: which
repositories it may touch, and whether git may run in them.

**Which repositories.** By default the server serves only repositories inside
the client's MCP roots, the workspace folders the client shares with it,
re-read whenever the client reports a change. A client that offers no roots
gets the server's working directory instead, unless that is the filesystem
root, your home directory or a directory that holds it (such as `/home`),
which would cover every repository you have.
Starting the server with `--read <dir>` (repeatable) adds directories to read
the same way, without git, for clients that share no roots: desktop apps
often start their servers from `/` or your home directory. Starting it with
`--allow <dir>` (repeatable) or setting `GITGLASSES_ALLOWED_ROOTS` replaces
the client's roots and the working directory with the directories you name,
where git may run; `--allow '*'` admits every path. Each `--allow` and
`--read` value is one directory, taken as written. A path outside them is rejected before
it reaches the engine, including via `..` traversal and via a symlink that
leaves a root, since both sides of the comparison are canonicalised. A path
whose repository extends outside them, such as a subfolder of a larger
repository, is rejected too, because `repo/discover` walks *upwards*.

**Whether git runs.** git runs programs that a repository's own configuration,
attributes and hooks name: `core.fsmonitor`, clean and smudge filters,
textconv drivers, hooks, `core.sshCommand`. A repository that arrived as an
archive or a shared folder can carry any of them, and a prompt-injected agent
can name its path. So repositories served from the client's roots or a
`--read` directory are read by an engine started with `--restricted`, which
runs no git at all: blame, log,
search, status, diffs, refs and the commit graph come straight from the
repository through libgit2, and so does `git_compare`'s merge base, commits
and file list. `git_file_history`, `create_patch`, `apply_patch` and
`git_log_search`'s code, path and date filters are refused there with a
message saying how to enable them, and `git_commit_show` and `git_compare`
leave out the diff with a note. Repositories inside the
directories you allow are read by a full engine, where git runs with the
repository's own configuration exactly as it does in your shell; allow only
directories whose repositories you trust.

`apply_patch` writes: it applies a patch to the working tree of the repository
`repoPath` names, so it needs an allowed repository. The other tools only
read.

**Network.** The tools read repositories on disk. A partial (blobless or
treeless) clone lacks some file contents by design; in an allowed repository,
a tool that needs them (blame, file history, the files and diff of a commit
or a comparison) has git download them from the clone's own remote with your
git credentials, as `git blame` or `git diff` would there. The engine that
runs no git cannot download them, so it reports those files' line counts as
unknown. Code searches (`content`) never download. `list_my_prs` is the only
tool that calls a hosting service's API.

The GitHub host is deliberately **not** a tool argument. A token and the host
it authenticates to are inseparable, so both come from the environment; if the
agent could name the host, a prompt injection would be enough to have the
token sent somewhere else.

## Development

```sh
pnpm --filter gitglasses-mcp build
pnpm --filter gitglasses-mcp test
```

The integration test spawns the real engine binary and is skipped (with a
console note) when no binary can be found.

The npm package is packed with `node scripts/pack-mcp.mjs` from the repository
root, never with `pnpm pack`: npm users get `npm-readme.md` as the package's
README, since this one describes running the server from a clone.
