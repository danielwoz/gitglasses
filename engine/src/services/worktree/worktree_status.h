#pragma once

#include <cstddef>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include "core/repo.h"
#include "exec/cli_detect.h"
#include "rpc/dispatcher.h"
#include "util/cancel.h"

namespace gg::services::worktree {

// The coding agent a worktree appears to belong to, and what gave it away:
// "path" (where the agent puts its worktrees), "branch" (the branch name it
// creates) or "trailer" (a trailer on a commit it made).
struct AgentMatch {
  std::string name;
  std::string evidence;
};

// Recognises the worktree locations and branch names coding agents create:
//   Claude Code  .claude/worktrees/<name> on branch worktree-<name>; claude/*
//   Cursor       ~/.cursor/worktrees/<repo>/<id>; cursor/*
//   Codex        ~/.codex/worktrees/<id>/<repo>; codex/*
//   VS Code      <repo>.worktrees/agents-* and copilot-worktree-*; copilot/*
// `path` may use either separator. Conventions change between releases, so
// anything unrecognised is simply no match.
std::optional<AgentMatch> agentFromLocation(std::string_view path, std::string_view branch);

// The agent a commit trailer declares: Co-authored-by naming an agent's
// identity (Claude, Cursor Agent, Copilot, Codex, aider, Gemini, Jules), or
// an Assisted-by / Generated-by trailer ("Assisted-by: Claude Code:model"),
// whose first field is taken as the name. Names outside the known set are
// kept only when they are short and plain (letters, digits, spaces, . _ + -).
std::optional<std::string> agentFromTrailer(std::string_view key, std::string_view value);

// Conflicted paths from `git merge-tree --write-tree --name-only
// --no-messages -z` output: the tree id, then one NUL-terminated path per
// conflicted file (a file conflicted in several ways is listed once), at most
// `limit` of them.
std::vector<std::string> mergeTreeConflicts(std::string_view output, std::size_t limit);

// The repository's worktrees read through libgit2 alone, in the shape and
// order `git worktree list --porcelain` gives them: the main worktree (or the
// bare repository) first, then the linked worktrees sorted by path. As git
// does, a linked worktree's HEAD and prunability come from its
// administrative directory, never from what sits at its recorded path.
rpc::Json listWithLibgit2(const core::Repo& repo);

// Whether `path` names the directory `repo` serves: its working tree, or its
// gitdir when it is bare. Compares the files, not the spelling.
bool isRepoDirectory(const core::Repo& repo, const std::string& path);

// True when nothing exists at `path` (a worktree directory deleted, or on
// media that is not mounted); false when it exists or cannot be checked.
bool isMissingDirectory(const std::string& path);

// What can be checked about one worktree.
struct StatusRequest {
  // The worktree's directory, as worktree/list reports it.
  std::string path;
  // Revision to compare against; empty means the branch checked out in the
  // main worktree (or the HEAD branch of a bare repository).
  std::string base;
  // Whether the engine may run git (false in Restricted Mode and builds
  // without the CLI): the merge check and filtered-file rechecks need it.
  bool cliAvailable = false;
  bool restricted = false;
  // The git on PATH, when known; the merge check needs 2.38 or later.
  std::optional<exec::GitVersion> gitVersion;
};

// worktree/status for one worktree of `repo` (see the protocol schema).
// Throws HandlerError when `path` is not a worktree of the repository or an
// explicit base names no commit.
rpc::Json status(const core::Repo& repo, const StatusRequest& request, const CancelToken& token);

}  // namespace gg::services::worktree
