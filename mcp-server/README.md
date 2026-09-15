# gitglasses-mcp

MCP (Model Context Protocol) server exposing gitglasses repository insight as
tools: blame, log search, file history, commit show, graph summary, status,
patch envelopes, and a Launchpad-classified pull request list.

The server speaks MCP over stdio and drives a `gitglasses-engine` process
(spawned lazily on the first repository tool call).

## Tools

| Tool | Description |
| --- | --- |
| `git_blame` | Per-hunk author/date/sha/summary for a file or single line |
| `git_log_search` | Search commits by text/author/sha, or list recent commits |
| `git_file_history` | File history following renames |
| `git_commit_show` | Commit metadata + changed files with +/- counts |
| `git_graph_summary` | Lane-indented text rendering of the commit graph |
| `git_status` | Branch, ahead/behind, staged/unstaged/untracked/conflicted |
| `create_patch` | Patch envelope from `wip`, `stash:<n>` or `commit:<sha>` |
| `apply_patch` | Apply a patch to the working tree (**writes**) |
| `list_my_prs` | Open PRs involving you, grouped into launchpad buckets |

Every tool but `apply_patch` is read-only, and each declares that through MCP
tool annotations (`readOnlyHint`), so a client can gate or auto-approve on it.

Tools that render a whole commit, status or patch take a `maxChars` argument
and truncate with a footer naming the limit; `git_blame` takes `limit` hunks.

## Registration

### Claude Code

```sh
claude mcp add gitglasses -- npx gitglasses-mcp
```

### VS Code (`.vscode/mcp.json`)

```json
{
  "servers": {
    "gitglasses": {
      "type": "stdio",
      "command": "npx",
      "args": ["gitglasses-mcp"],
      "env": {
        "GITGLASSES_ENGINE": "/path/to/gitglasses-engine",
        "GITHUB_TOKEN": "${input:github-token}"
      }
    }
  }
}
```

## Environment variables

| Variable | Purpose |
| --- | --- |
| `GITGLASSES_ENGINE` | Absolute path to the `gitglasses-engine` binary. When unset, the server looks for `../build/release/engine/gitglasses-engine` relative to this package, then searches `PATH`. |
| `GITHUB_TOKEN` | GitHub token used by `list_my_prs` (preferred). |
| `GITGLASSES_GITHUB_TOKEN` | Fallback token when `GITHUB_TOKEN` is unset. |
| `GITGLASSES_GITHUB_HOST` | GitHub Enterprise hostname for `list_my_prs`. Must be a bare hostname. Defaults to `github.com`. |
| `GITGLASSES_ALLOWED_ROOTS` | Path-separator delimited directories the server may read and, via `apply_patch`, write. Unset means **any repository the process can reach**. |

## Security model

The server runs with the privileges of whoever starts it, and every tool takes
an absolute `repoPath`. Read that literally: by default, an agent can name any
path on the machine and read the history, diffs, status and blame of whatever
repository contains it — not just the project under discussion. `repo/discover`
walks *upwards*, so a path inside a repository grants that repository.

`apply_patch` writes: it applies a patch to the working tree of whatever
repository `repoPath` names. The other eight tools only read.

`GITGLASSES_ALLOWED_ROOTS` is what bounds where either can happen. Set it to
the directories this server may touch; paths outside are rejected before
reaching the engine, including via `..` traversal and via a symlink that
leaves a root — both sides of the comparison are canonicalised.

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
