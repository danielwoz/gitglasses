<!--
The README published to npm with gitglasses-mcp. scripts/pack-mcp.mjs packs
it as README.md with {{version}} replaced by the package version, leaving
out this comment; README.md in this directory describes running the server
from a clone. The note under the heading is for readers of the repository
while releases do not publish the package; it goes when they do again.
-->
# gitglasses-mcp

> **Not shipped for now.** The GitGlasses extension does not include this
> server, and releases do not publish it to npm. It can be built from source
> and run on its own, as [README.md](README.md) in this directory describes.

MCP (Model Context Protocol) server exposing GitGlasses repository insight as
tools: blame, log search, file history, commit show, diffs, refs, graph
summary, status, patch envelopes, a Launchpad-classified pull request
list, the AI provenance commits declare and the story of a line.

The server speaks MCP over stdio and drives a `gitglasses-engine` process
(spawned lazily on the first repository tool call).

## Tools

| Tool | Description |
| --- | --- |
| `git_blame` | Per-hunk author/date/sha/summary for a file or single line |
| `git_provenance` | Per-hunk declared AI provenance of a line range: git-ai notes, trailers, agent identities |
| `git_log_search` | Search commits by message, author, sha, code change (`git log -S`/`-G`), path or date, or list recent commits |
| `git_file_history` | File history following renames, or the commits that changed a range of lines (`git log -L`) |
| `git_commit_show` | Commit metadata + changed files with +/- counts |
| `git_diff` | Uncommitted changes as a unified diff, unstaged or staged, for the repository or one file |
| `git_refs` | Branches, remote-tracking branches and tags with the sha each points at |
| `git_compare` | A branch against another from their merge base: commits ahead and behind, changed files with +/- counts, optionally the diff |
| `git_graph_summary` | Lane-indented text rendering of the commit graph |
| `git_status` | Branch, ahead/behind, staged/unstaged/untracked/conflicted |
| `git_worktrees` | Every worktree with its uncommitted count, ahead/behind a base, whether it merges cleanly, last activity and the coding agent working in it |
| `create_patch` | Patch envelope from `wip`, `stash:<n>` or `commit:<revision>` |
| `apply_patch` | Apply a patch to the working tree (**writes**) |
| `list_my_prs` | Open PRs involving you on GitHub, GitLab, Bitbucket and Azure DevOps, grouped into launchpad buckets |
| `git_line_story` | Why a line is the way it is: its blame (ignore-revs honoured), the full commit message, the GitHub pull requests that merged it, the issues they name and the line's earlier versions with diffs, as bounded markdown with forge text quoted |

Every tool but `apply_patch` is read-only, and each declares that through MCP
tool annotations (`readOnlyHint`), so a client can gate or auto-approve on it.

Tools that render a whole commit, diff, status, ref list or patch take a
`maxChars` argument and truncate with a footer naming the limit; `git_blame`
takes `limit` hunks.

## Requirements

Node.js 20.11 or newer. The `gitglasses-engine` binary the server drives
comes with it: each platform's engine is a package of its own
(`@gitglasses/engine-linux-x64`, `@gitglasses/engine-darwin-arm64`,
`@gitglasses/engine-win32-x64`, and so on, with `-musl` builds for Alpine),
listed as optional dependencies, so npm installs only the one your machine
needs and the server finds it without any setting. Set `GITGLASSES_ENGINE`
to use another engine, such as the one the GitGlasses extension ships.

## Registration

Name the exact version, so your client keeps running the release you chose.

### Claude Code

```sh
claude mcp add gitglasses -- npx -y gitglasses-mcp@{{version}}
# Also let git run in the repositories under ~/code (file history, patches,
# code search, diffs):
claude mcp add gitglasses -- npx -y gitglasses-mcp@{{version}} --allow ~/code
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
| `GITGLASSES_ENGINE` | Absolute path to the `gitglasses-engine` binary. When unset, the server uses the engine package npm installed for this platform, then searches `PATH`. |
| `GITHUB_TOKEN` | GitHub token used by `list_my_prs` and `git_line_story` (preferred). |
| `GITGLASSES_GITHUB_TOKEN` | Fallback token when `GITHUB_TOKEN` is unset. |
| `GITGLASSES_GITHUB_HOST` | GitHub Enterprise hostname for `list_my_prs` and `git_line_story`. Must be a bare hostname. Defaults to `github.com`. |
| `GITLAB_TOKEN` | GitLab token used by `list_my_prs` (`GITGLASSES_GITLAB_TOKEN` also works). |
| `GITGLASSES_GITLAB_HOST` | Self-managed GitLab hostname. Must be a bare hostname. Defaults to `gitlab.com`. |
| `GITGLASSES_BITBUCKET_TOKEN` | Bitbucket Cloud access token, or app password with `GITGLASSES_BITBUCKET_USERNAME`. Cloud lists the pull requests you authored. |
| `GITGLASSES_BITBUCKET_DC_TOKEN` | Bitbucket Data Center token; needs `GITGLASSES_BITBUCKET_DC_HOST`, a bare hostname. |
| `GITGLASSES_AZURE_DEVOPS_TOKEN` | Azure DevOps personal access token; needs `GITGLASSES_AZURE_DEVOPS_ORG`, the organization. |
| `GITGLASSES_ALLOWED_ROOTS` | Path-separator delimited directories the server reads and, via `apply_patch`, writes, with git allowed to run there. Same as passing each with `--allow`; `*` allows every path. Unset means the client's workspace roots, read without git. |

## Trust model

The server runs with the privileges of whoever starts it, and every tool takes
an absolute `repoPath`.

**Which repositories.** By default the server serves only repositories inside
the client's MCP roots, the workspace folders the client shares with it. A
client that offers no roots gets the server's working directory instead,
unless that is the filesystem root, your home directory or a directory that
holds it. `--read <dir>` (repeatable) adds directories to read the same way,
for clients that share no roots. `--allow <dir>` (repeatable) or
`GITGLASSES_ALLOWED_ROOTS` replaces the client's roots and the working
directory with the directories you name, where git may run. A path outside them is rejected
before it reaches the engine, including via `..` traversal and via a symlink
that leaves a root, and so is a path whose repository extends outside them.

**Whether git runs.** git runs programs that a repository's own configuration,
attributes and hooks name (`core.fsmonitor`, filters, textconv drivers, hooks,
`core.sshCommand`), and a prompt-injected agent can name any path. So
repositories served from the client's roots or a `--read` directory are read
by an engine that runs no git at all: blame, log, search, status, diffs, refs, branch comparisons
and the commit graph come straight from the repository. File history,
patches, code search and the diffs of `git_commit_show` and `git_compare`
need git and work only in the directories you allow; allow only directories
whose repositories you trust.

`apply_patch` writes: it applies a patch to the working tree of the repository
`repoPath` names, so it needs an allowed repository. The other tools only
read.

In a partial (blobless or treeless) clone, a tool that needs file contents the
clone lacks has git download them from the clone's own remote, but only in
an allowed repository; read without git, those line counts are reported as
unknown. `list_my_prs` is the only tool that calls a hosting service's API.

Hosts are deliberately **not** tool arguments. A token and the host it
authenticates to are inseparable, so both come from the environment, and each
token is only ever sent to its own host; if the agent could name the host, a
prompt injection would be enough to have the token sent somewhere else.

## License

MIT. Source, issues and the GitGlasses extension:
<https://github.com/danielwoz/gitglasses>.
