#include "services/mutate/mutate_common.h"

#include <git2.h>

#include <filesystem>

#include "exec/git_process.h"

namespace gg::services::mutate_detail {

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
  auto process = exec::GitProcess::spawn(repoCwd(repo), std::move(args));
  if (!process) return process.error();
  GitOutput output;
  std::string line;
  while (process.value().readLine(line, token)) output.lines.push_back(line);
  output.exitCode = process.value().wait(token);
  output.stderrText = process.value().stderrOutput();
  return output;
}

Result<GitOutput> runGitWithEnv(const std::string& cwd, std::vector<std::string> args,
                                const std::vector<std::pair<std::string, std::string>>& extraEnv,
                                const CancelToken& token) {
  exec::SpawnOpts opts;
  opts.extraEnv.reserve(extraEnv.size());
  for (const auto& [name, value] : extraEnv) opts.extraEnv.push_back(name + "=" + value);
  auto process = exec::GitProcess::spawn(cwd, std::move(args), opts);
  if (!process) return process.error();
  GitOutput output;
  std::string line;
  while (process.value().readLine(line, token)) {
    if (!line.empty() && line.back() == '\r') line.pop_back();
    output.lines.push_back(line);
  }
  output.exitCode = process.value().wait(token);
  output.stderrText = process.value().stderrOutput();
  return output;
}

GitOutput runGitOrThrow(const core::Repo& repo, std::vector<std::string> args,
                        const CancelToken& token, const std::string& what) {
  auto output = runGit(repo, std::move(args), token);
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

std::string requireString(const rpc::Json& params, const char* key) {
  const std::string value = params.value(key, "");
  if (value.empty()) {
    throw rpc::HandlerError{
        {ErrorCode::InvalidParams, std::string("'") + key + "' is required"}};
  }
  return value;
}

std::vector<std::string> requireStringArray(const rpc::Json& params, const char* key) {
  if (!params.contains(key) || !params[key].is_array() || params[key].empty()) {
    throw rpc::HandlerError{{ErrorCode::InvalidParams,
                             std::string("'") + key + "' must be a non-empty array"}};
  }
  std::vector<std::string> values;
  for (const auto& entry : params[key]) {
    if (!entry.is_string() || entry.get<std::string>().empty()) {
      throw rpc::HandlerError{{ErrorCode::InvalidParams,
                               std::string("'") + key + "' entries must be non-empty strings"}};
    }
    values.push_back(entry.get<std::string>());
  }
  return values;
}

}  // namespace gg::services::mutate_detail
