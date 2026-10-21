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
| `git_log_search` | Search commits by text/author/sha, or list recent commits |
| `git_file_history` | File history following renames |
| `git_commit_show` | Commit metadata + changed files with +/- counts |
| `git_diff` | Uncommitted changes as a unified diff, unstaged or staged, for the repository or one file |
| `git_refs` | Branches, remote-tracking branches and tags with the sha each points at |
| `git_graph_summary` | Lane-indented text rendering of the commit graph |
| `git_status` | Branch, ahead/behind, staged/unstaged/untracked/conflicted |
| `create_patch` | Patch envelope from `wip`, `stash:<n>` or `commit:<sha>` |
| `apply_patch` | Apply a patch to the working tree (**writes**) |
| `list_my_prs` | Open PRs involving you, grouped into launchpad buckets |

Every tool but `apply_patch` is read-only, and each declares that through MCP
tool annotations (`readOnlyHint`), so a client can gate or auto-approve on it.
`git_file_history`, `create_patch`, `apply_patch` and the diff of
`git_commit_show` need git, so they work only in repositories you allow (see
[Trust model](#trust-model)).

Tools that render a whole commit, diff, status, ref list or patch take a
`maxChars` argument and truncate with a footer naming the limit; `git_blame`
takes `limit` hunks.

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

The server drives the `gitglasses-engine` binary. The GitGlasses extension
ships one for your platform, so once the extension is installed, point
`GITGLASSES_ENGINE` at it:

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
| `GITGLASSES_ENGINE` | Absolute path to the `gitglasses-engine` binary. When unset, the server looks for a release build in the clone it runs from (`build/release/engine/`), then searches `PATH`. |
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
Starting the server with `--allow <dir>` (repeatable) or setting
`GITGLASSES_ALLOWED_ROOTS` replaces those defaults with the directories you
name; `--allow '*'` admits every path. A path outside them is rejected before
it reaches the engine, including via `..` traversal and via a symlink that
leaves a root, since both sides of the comparison are canonicalised. A path
whose repository extends outside them, such as a subfolder of a larger
repository, is rejected too, because `repo/discover` walks *upwards*.

**Whether git runs.** git runs programs that a repository's own configuration,
attributes and hooks name: `core.fsmonitor`, clean and smudge filters,
textconv drivers, hooks, `core.sshCommand`. A repository that arrived as an
archive or a shared folder can carry any of them, and a prompt-injected agent
can name its path. So repositories served from the client's roots are read by
an engine started with `--restricted`, which runs no git at all: blame, log,
search, status, diffs, refs and the commit graph come straight from the
repository through libgit2. `git_file_history`, `create_patch` and
`apply_patch` are refused there with a message saying how to enable them, and
`git_commit_show` leaves out the diff with a note. Repositories inside the
directories you allow are read by a full engine, where git runs with the
repository's own configuration exactly as it does in your shell; allow only
directories whose repositories you trust.

`apply_patch` writes: it applies a patch to the working tree of the repository
`repoPath` names, so it needs an allowed repository. The other tools only
read.

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
