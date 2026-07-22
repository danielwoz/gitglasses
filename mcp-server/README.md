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
| `create_patch` | Patch envelope JSON from `wip`, `stash:<n>` or `commit:<sha>` |
| `apply_patch` | Apply a patch envelope JSON string |
| `list_my_prs` | Open PRs involving you, grouped into launchpad buckets |

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

## Development

```sh
pnpm --filter gitglasses-mcp build
pnpm --filter gitglasses-mcp test
```

The integration test spawns the real engine binary and is skipped (with a
console note) when no binary can be found.
