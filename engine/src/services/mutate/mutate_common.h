#pragma once

#include <string>
#include <utility>
#include <vector>

#include "core/repo.h"
#include "rpc/dispatcher.h"
#include "services/context.h"

namespace gg::services::mutate_detail {

// Captured result of a finished `git` invocation. Only spawn failures are
// Errors; nonzero exits come back in exitCode for the caller to interpret
// (conflict-aware methods treat some of them as results, not errors).
struct GitOutput {
  int exitCode = -1;
  std::vector<std::string> lines;  // stdout split on newlines
  std::string stderrText;
};

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

// Runs `git <args>` and throws HandlerError(GitError) with git's stderr
// unless it exited 0.
GitOutput runGitOrThrow(const core::Repo& repo, std::vector<std::string> args,
                        const CancelToken& token, const std::string& what);

// Runs a merge-like command whose failure may mean "stopped on conflicts":
// exit 0 -> {conflicts:false}; nonzero with conflict state -> {conflicts:true};
// any other failure throws GitError.
rpc::Json runConflictAware(const core::Repo& repo, std::vector<std::string> args,
                           const CancelToken& token, const std::string& what);

// True when an interactive or am-style rebase is in progress.
bool rebaseInProgress(const core::Repo& repo);

// True when the repository is mid-conflict: sequencer heads present
// (MERGE_HEAD / CHERRY_PICK_HEAD / REVERT_HEAD / rebase dirs) or conflict
// entries in the index.
bool inConflictState(const core::Repo& repo);

// Opens the repo for params["repoId"], throwing HandlerError on failure.
core::Repo openRepo(ServiceContext& context, const rpc::Json& params);

std::string headSha(const core::Repo& repo, const CancelToken& token);

// Fetches a required non-empty string param or throws InvalidParams.
std::string requireString(const rpc::Json& params, const char* key);

// Fetches a required non-empty array of non-empty strings or throws
// InvalidParams.
std::vector<std::string> requireStringArray(const rpc::Json& params, const char* key);

}  // namespace gg::services::mutate_detail
