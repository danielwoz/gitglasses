#include "services/mutate/mutate_common.h"

#include <git2.h>

#include <filesystem>
#include <fstream>
#include <utility>

#include "exec/git_process.h"
#include "exec/git_runner.h"

namespace gg::services::mutate_detail {

namespace {

// Collects a run's stdout lines and exit status into a GitOutput.
Result<GitOutput> collectLines(const std::string& cwd, std::vector<std::string> args,
                               const exec::RunOpts& opts, const CancelToken& token) {
  GitOutput output;
  auto status = exec::runGit(cwd, std::move(args), opts, token,
                             [&output](std::string line) {
                               output.lines.push_back(std::move(line));
                             });
  if (!status) return status.error();
  output.exitCode = status.value().exitCode;
  output.stderrText = status.value().stderrText;
  return output;
}

// Reads a positive counter git writes one-per-line into the sequencer
// directory (msgnum/end, next/last).
std::optional<std::int64_t> readCounter(const std::filesystem::path& file) {
  std::ifstream in(file);
  std::int64_t value = 0;
  if (in >> value && value > 0) return value;
  return std::nullopt;
}

}  // namespace

const std::string& requirePositional(const std::string& value, const char* what) {
  if (exec::looksLikeGitOption(value)) {
    throw rpc::HandlerError{
        {ErrorCode::InvalidParams,
         std::string(what) + " may not begin with '-' (would be parsed as a git option)"}};
  }
  return value;
}

const std::vector<std::string>& requirePositionals(const std::vector<std::string>& values,
                                                   const char* what) {
  for (const auto& value : values) requirePositional(value, what);
  return values;
}

std::string repoCwd(const core::Repo& repo) {
  return repo.workdir().empty() ? repo.gitdir() : repo.workdir();
}

Result<GitOutput> runGit(const core::Repo& repo, std::vector<std::string> args,
                         const CancelToken& token) {
  return collectLines(repoCwd(repo), std::move(args), {}, token);
}

Result<GitOutput> runGitWithEnv(const std::string& cwd, std::vector<std::string> args,
                                const std::vector<std::pair<std::string, std::string>>& extraEnv,
                                const CancelToken& token) {
  exec::RunOpts opts;
  opts.extraEnv.reserve(extraEnv.size());
  for (const auto& [name, value] : extraEnv) opts.extraEnv.push_back(name + "=" + value);
  return collectLines(cwd, std::move(args), opts, token);
}

GitOutput runGitOrThrow(const core::Repo& repo, std::vector<std::string> args,
                        const CancelToken& token, const std::string& what,
                        std::chrono::milliseconds timeout) {
  exec::RunOpts opts;
  opts.timeout = timeout;
  auto output = collectLines(repoCwd(repo), std::move(args), opts, token);
  if (!output) throw rpc::HandlerError{{output.error()}};
  if (output.value().exitCode != 0) {
    throw rpc::HandlerError{{ErrorCode::GitError,
                             what + " failed (" + std::to_string(output.value().exitCode) +
                                 "): " + output.value().stderrText}};
  }
  return std::move(output.value());
}

rpc::Json runConflictAware(const core::Repo& repo, std::vector<std::string> args,
                           const CancelToken& token, const std::string& what) {
  auto output = runGit(repo, std::move(args), token);
  if (!output) throw rpc::HandlerError{{output.error()}};
  if (output.value().exitCode == 0) return {{"conflicts", false}};
  if (inConflictState(repo)) return {{"conflicts", true}};
  throw rpc::HandlerError{{ErrorCode::GitError,
                           what + " failed (" + std::to_string(output.value().exitCode) +
                               "): " + output.value().stderrText}};
}

bool rebaseInProgress(const core::Repo& repo) {
  namespace fs = std::filesystem;
  const fs::path gitdir(repo.gitdir());
  std::error_code ec;
  return fs::exists(gitdir / "rebase-merge", ec) || fs::exists(gitdir / "rebase-apply", ec);
}

SequencerState sequencerState(const core::Repo& repo) {
  namespace fs = std::filesystem;
  const fs::path gitdir(repo.gitdir());
  std::error_code ec;
  SequencerState state;

  // Rebase first: a conflicted step also leaves CHERRY_PICK_HEAD behind,
  // which on its own would read as a plain cherry-pick.
  if (fs::exists(gitdir / "rebase-merge", ec)) {
    state.operation = "rebase";
    state.step = readCounter(gitdir / "rebase-merge" / "msgnum");
    state.total = readCounter(gitdir / "rebase-merge" / "end");
  } else if (fs::exists(gitdir / "rebase-apply", ec)) {
    state.operation = "rebase";
    state.step = readCounter(gitdir / "rebase-apply" / "next");
    state.total = readCounter(gitdir / "rebase-apply" / "last");
  } else if (fs::exists(gitdir / "CHERRY_PICK_HEAD", ec)) {
    state.operation = "cherry-pick";
  } else if (fs::exists(gitdir / "REVERT_HEAD", ec)) {
    state.operation = "revert";
  } else if (fs::exists(gitdir / "MERGE_HEAD", ec)) {
    state.operation = "merge";
  }

  git_index* rawIndex = nullptr;
  if (git_repository_index(&rawIndex, repo.raw()) == 0) {
    state.conflicted = git_index_has_conflicts(rawIndex) != 0;
    git_index_free(rawIndex);
  }
  return state;
}

bool inConflictState(const core::Repo& repo) {
  namespace fs = std::filesystem;
  const fs::path gitdir(repo.gitdir());
  std::error_code ec;
  for (const char* marker : {"MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD"}) {
    if (fs::exists(gitdir / marker, ec)) return true;
  }
  if (rebaseInProgress(repo)) return true;
  git_index* rawIndex = nullptr;
  if (git_repository_index(&rawIndex, repo.raw()) != 0) return false;
  const bool conflicts = git_index_has_conflicts(rawIndex) != 0;
  git_index_free(rawIndex);
  return conflicts;
}

core::Repo openRepo(ServiceContext& context, const rpc::Json& params) {
  auto repo = context.registry.open(params.value("repoId", ""));
  if (!repo) throw rpc::HandlerError{{repo.error()}};
  return std::move(repo).value();
}

std::string headSha(const core::Repo& repo, const CancelToken& token) {
  auto output = runGitOrThrow(repo, {"rev-parse", "HEAD"}, token, "git rev-parse HEAD");
  if (output.lines.empty()) {
    throw rpc::HandlerError{{ErrorCode::GitError, "git rev-parse HEAD produced no output"}};
  }
  return output.lines.front();
}

}  // namespace gg::services::mutate_detail
