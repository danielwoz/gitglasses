#pragma once

#include <chrono>
#include <cstdint>
#include <optional>
#include <string>
#include <utility>
#include <vector>

#include "core/repo.h"
#include "exec/git_process.h"
#include "rpc/dispatcher.h"
#include "services/context.h"

namespace gg::services::mutate_detail {

// Captured result of a finished `git` invocation. Spawn failures and timeouts
// are Errors; nonzero exits come back in exitCode for the caller to interpret
// (conflict-aware methods treat some of them as results, not errors).
struct GitOutput {
  int exitCode = -1;
  std::vector<std::string> lines;  // stdout split on newlines
  std::string stderrText;
};

// Rejects a value that git's option parser would read as a flag (see
// exec::looksLikeGitOption for why this matters), throwing
// HandlerError(InvalidParams). `what` names the field for the error message.
const std::string& requirePositional(const std::string& value, const char* what);

// Same, applied to each element of a list (e.g. cherry-pick shas).
const std::vector<std::string>& requirePositionals(const std::vector<std::string>& values,
                                                   const char* what);

// Directory git commands run in: the working tree, or the gitdir for bare
// repositories.
std::string repoCwd(const core::Repo& repo);

// Runs `git <args>` in the repo through exec::GitProcess.
Result<GitOutput> runGit(const core::Repo& repo, std::vector<std::string> args,
                         const CancelToken& token);

// Runs `git <args>` with extra environment variables that override inherited
// values (the rebase methods inject GIT_SEQUENCE_EDITOR / GIT_EDITOR).
Result<GitOutput> runGitWithEnv(const std::string& cwd, std::vector<std::string> args,
                                const std::vector<std::pair<std::string, std::string>>& extraEnv,
                                const CancelToken& token);

// Throws HandlerError(GitError) for a run that failed: "<what> failed
// (<code>): " and git's stderr, or its stdout when stderr is empty (some
// commands explain themselves there). error.data describes the failure
// (see git_errors.h), with `operation` when the repository was left in the
// middle of one.
[[noreturn]] void throwGitFailure(const std::string& what, const GitOutput& output,
                                  const std::string& operation = "none");

// Runs `git <args>` and throws as throwGitFailure describes unless it exited
// 0. Remote-facing callers raise `timeout` to the network ceiling.
GitOutput runGitOrThrow(const core::Repo& repo, std::vector<std::string> args,
                        const CancelToken& token, const std::string& what,
                        std::chrono::milliseconds timeout = exec::kDefaultGitTimeout);

// Runs a merge-like command whose failure may mean "stopped on conflicts".
// Conflicts are reported only when the index really holds unmerged entries:
// {conflicts:true} then, whatever git's exit code. Any other failure throws
// GitError carrying git's message, with error.data.operation naming what
// the repository was left in the middle of (a signing failure or a hook can
// stop a merge or cherry-pick without a single conflict).
rpc::Json runConflictAware(const core::Repo& repo, std::vector<std::string> args,
                           const CancelToken& token, const std::string& what,
                           std::chrono::milliseconds timeout = exec::kDefaultGitTimeout);

// True when an interactive or am-style rebase is in progress.
bool rebaseInProgress(const core::Repo& repo);

// Multi-step operation the repository is stopped in the middle of, read from
// the sequencer state in the gitdir.
struct SequencerState {
  // "none", "rebase", "merge", "cherry-pick" or "revert".
  std::string operation = "none";
  // Index holds unmerged entries.
  bool conflicted = false;
  // Position and length of a running rebase; absent for the other operations
  // and for rebases whose counters git has not written.
  std::optional<std::int64_t> step;
  std::optional<std::int64_t> total;
};

// Reads the repository's sequencer state. An idle repository reports
// operation "none" with no conflicts.
SequencerState sequencerState(const core::Repo& repo);

// True when the repository is mid-conflict: sequencer heads present
// (MERGE_HEAD / CHERRY_PICK_HEAD / REVERT_HEAD / rebase dirs) or conflict
// entries in the index.
bool inConflictState(const core::Repo& repo);

// Opens the repo for params["repoId"], throwing HandlerError on failure.
core::Repo openRepo(ServiceContext& context, const rpc::Json& params);

std::string headSha(const core::Repo& repo, const CancelToken& token);

}  // namespace gg::services::mutate_detail
