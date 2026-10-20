<!--
The README published to npm with gitglasses-mcp. scripts/pack-mcp.mjs packs
it as README.md with {{version}} replaced by the package version; README.md
in this directory describes running the server from a clone.
-->
# gitglasses-mcp

MCP (Model Context Protocol) server exposing GitGlasses repository insight as
tools: blame, log search, file history, commit show, diffs, refs, graph
summary, status, patch envelopes, a Launchpad-classified pull request list,
and the story of a line.

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
| `git_line_story` | Why a line is the way it is: its blame (ignore-revs honoured), the full commit message, the GitHub pull requests that merged it, the issues they name and the line's earlier versions with diffs, as bounded markdown with forge text quoted |

Every tool but `apply_patch` is read-only, and each declares that through MCP
tool annotations (`readOnlyHint`), so a client can gate or auto-approve on it.

Tools that render a whole commit, diff, status, ref list or patch take a
`maxChars` argument and truncate with a footer naming the limit; `git_blame`
takes `limit` hunks.

## Requirements

- Node.js 20.11 or newer.
- The `gitglasses-engine` binary. The GitGlasses extension for VS Code and
  Open VSX editors ships one for your platform; point `GITGLASSES_ENGINE` at
  it:

| Editor | Engine |
| --- | --- |
| VS Code on Linux or macOS | `~/.vscode/extensions/gitglasses.gitglasses-<version>-<platform>/bin/gitglasses-engine` |
| VS Code on Windows | `%USERPROFILE%\.vscode\extensions\gitglasses.gitglasses-<version>-win32-x64\bin\gitglasses-engine.exe` |
| VSCodium | the same, under `~/.vscode-oss/extensions` |

Without `GITGLASSES_ENGINE`, the server looks for `gitglasses-engine` on
`PATH`.

## Registration

Name the exact version, so your client keeps running the release you chose.
Replace `/path/to/gitglasses-engine` with the engine.

### Claude Code

```sh
claude mcp add gitglasses \
  -e GITGLASSES_ENGINE=/path/to/gitglasses-engine \
  -- npx -y gitglasses-mcp@{{version}}
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
      "command": "npx",
      "args": ["-y", "gitglasses-mcp@{{version}}"],
      "env": {
        "GITGLASSES_ENGINE": "/path/to/gitglasses-engine",
        "GITGLASSES_ALLOWED_ROOTS": "${workspaceFolder}",
        "GITHUB_TOKEN": "${input:github-token}"
      }
    }
  }
}
```

To avoid a download on each start, install it once with
`npm install -g gitglasses-mcp@{{version}}` and use `gitglasses-mcp` as the
command, with no arguments.

## Environment variables

| Variable | Purpose |
| --- | --- |
| `GITGLASSES_ENGINE` | Absolute path to the `gitglasses-engine` binary. When unset, the server searches `PATH`. |
| `GITHUB_TOKEN` | GitHub token used by `list_my_prs` and `git_line_story` (preferred). |
| `GITGLASSES_GITHUB_TOKEN` | Fallback token when `GITHUB_TOKEN` is unset. |
| `GITGLASSES_GITHUB_HOST` | GitHub Enterprise hostname for `list_my_prs` and `git_line_story`. Must be a bare hostname. Defaults to `github.com`. |
| `GITGLASSES_ALLOWED_ROOTS` | Path-separator delimited directories the server may read and, via `apply_patch`, write. Unset means **any repository the process can reach**. |

## Security model

The server runs with the privileges of whoever starts it, and every tool takes
an absolute `repoPath`. Read that literally: by default, an agent can name any
path on the machine and read the history, diffs, status and blame of whatever
repository contains it — not just the project under discussion. `repo/discover`
walks *upwards*, so a path inside a repository grants that repository.

`apply_patch` writes: it applies a patch to the working tree of whatever
repository `repoPath` names. The other eleven tools only read.

`GITGLASSES_ALLOWED_ROOTS` is what bounds where either can happen. Set it to
the directories this server may touch; paths outside are rejected before
reaching the engine, including via `..` traversal and via a symlink that
leaves a root — both sides of the comparison are canonicalised.

The GitHub host is deliberately **not** a tool argument. A token and the host
it authenticates to are inseparable, so both come from the environment; if the
agent could name the host, a prompt injection would be enough to have the
token sent somewhere else.

## License

MIT. Source, issues and the GitGlasses extension:
<https://github.com/danielwoz/gitglasses>.
