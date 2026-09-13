#include "services/mutate/rebase_methods.h"

#include <filesystem>
#include <fstream>
#include <string>
#include <utility>
#include <vector>

#include "exec/sequence_editor.h"
#include "services/mutate/mutate_common.h"
#include "services/params.h"
#include "util/temp_file.h"

namespace gg::services {

namespace {

using mutate_detail::GitOutput;
using mutate_detail::openRepo;
using mutate_detail::rebaseInProgress;
using mutate_detail::runGitOrThrow;
using mutate_detail::runGitWithEnv;

// POSIX-shell single-quoting: git runs editor commands through `sh -c`.
std::string shellQuote(const std::string& value) {
  std::string quoted = "'";
  for (const char c : value) {
    if (c == '\'') {
      quoted += "'\\''";
    } else {
      quoted += c;
    }
  }
  quoted += '\'';
  return quoted;
}

// Temp file carrying the rebase plan for the editor shims; removed when the
// rebase invocation returns.
class ControlFile {
 public:
  explicit ControlFile(const rpc::Json& plan) {
    path_ = util::randomTempPath("gg-rebase-", ".json");
    std::ofstream out(path_, std::ios::binary | std::ios::trunc);
    out << rpc::Json{{"plan", plan}, {"consumed", 0}}.dump();
    out.flush();
    ok_ = static_cast<bool>(out);
  }
  ~ControlFile() {
    std::error_code ec;
    std::filesystem::remove(path_, ec);
  }
  ControlFile(const ControlFile&) = delete;
  ControlFile& operator=(const ControlFile&) = delete;

  bool ok() const { return ok_; }
  std::string path() const { return path_.string(); }

 private:
  std::filesystem::path path_;
  bool ok_ = false;
};

void validatePlan(const rpc::Json& params) {
  if (!params.contains("plan") || !params["plan"].is_array()) {
    throw rpc::HandlerError{{ErrorCode::InvalidParams, "'plan' must be an array"}};
  }
  for (const auto& entry : params["plan"]) {
    const std::string action = entry.is_object() ? entry.value("action", "") : "";
    if (action != "pick" && action != "reword" && action != "squash" && action != "fixup" &&
        action != "drop" && action != "edit") {
      throw rpc::HandlerError{
          {ErrorCode::InvalidParams,
           "plan entries need an action of pick|reword|squash|fixup|drop|edit"}};
    }
    if (entry.value("sha", "").empty()) {
      throw rpc::HandlerError{{ErrorCode::InvalidParams, "plan entries need a non-empty 'sha'"}};
    }
  }
}

const core::Repo& requireWorktree(const core::Repo& repo) {
  if (repo.workdir().empty()) {
    throw rpc::HandlerError{{ErrorCode::GitError, "rebase requires a working tree"}};
  }
  return repo;
}

// Shared result mapping for rebase runs: exit 0 with no rebase state left is
// completion (an 'edit' stop also exits 0 but leaves state); a nonzero exit
// with rebase state on disk means git stopped on conflicts.
rpc::Json rebaseRunResult(const core::Repo& repo, const Result<GitOutput>& output,
                          const std::string& what) {
  if (!output) throw rpc::HandlerError{{output.error()}};
  const bool inProgress = rebaseInProgress(repo);
  if (output.value().exitCode == 0) {
    return {{"completed", !inProgress}, {"conflicts", false}};
  }
  if (inProgress) return {{"completed", false}, {"conflicts", true}};
  throw rpc::HandlerError{{ErrorCode::GitError,
                           what + " failed (" + std::to_string(output.value().exitCode) +
                               "): " + output.value().stderrText}};
}

}  // namespace

void registerRebaseMethods(rpc::Dispatcher& dispatcher, ServiceContext& context) {
  dispatcher.method(
      "rebase/preview",
      [&context](const rpc::Json& params, const CancelToken& token,
                 const rpc::NotifyFn&) -> rpc::Json {
        requireGitCli(context);
        const std::string upstream = requireString(params, "upstream");
        auto repo = openRepo(context, params);
        auto output = runGitOrThrow(
            repo, {"log", "--reverse", "--format=%H%x1f%s", upstream + "..HEAD"}, token,
            "git log");
        rpc::Json entries = rpc::Json::array();
        for (const auto& line : output.lines) {
          const size_t sep = line.find('\x1f');
          if (sep == std::string::npos) continue;
          entries.push_back({{"sha", line.substr(0, sep)}, {"summary", line.substr(sep + 1)}});
        }
        return {{"entries", std::move(entries)}};
      },
      rpc::Mode::Serial);

  dispatcher.method(
      "rebase/start",
      [&context](const rpc::Json& params, const CancelToken& token,
                 const rpc::NotifyFn&) -> rpc::Json {
        requireGitCli(context);
        const std::string upstream = requireString(params, "upstream");
        validatePlan(params);
        auto repo = openRepo(context, params);
        requireWorktree(repo);

        const ControlFile control(params["plan"]);
        if (!control.ok()) {
          throw rpc::HandlerError{{ErrorCode::Internal, "cannot write rebase control file"}};
        }
        // The editor values run through git's `sh -c`, which wants
        // forward-slash paths on every platform (Git for Windows included).
        const std::string self =
            shellQuote(std::filesystem::path(exec::selfExePath()).generic_string());
        const std::string controlArg =
            shellQuote(std::filesystem::path(control.path()).generic_string());
        auto output = runGitWithEnv(
            repo.workdir(), {"rebase", "-i", upstream},
            {{"GIT_SEQUENCE_EDITOR", self + " --edit-sequence " + controlArg},
             {"GIT_EDITOR", self + " --edit-message " + controlArg}},
            token);
        return rebaseRunResult(repo, output, "git rebase");
      },
      rpc::Mode::Serial);

  dispatcher.method(
      "rebase/continue",
      [&context](const rpc::Json& params, const CancelToken& token,
                 const rpc::NotifyFn&) -> rpc::Json {
        requireGitCli(context);
        auto repo = openRepo(context, params);
        requireWorktree(repo);
        // GIT_EDITOR=true accepts whatever message git prepared for the
        // resumed step.
        auto output = runGitWithEnv(repo.workdir(), {"rebase", "--continue"},
                                    {{"GIT_EDITOR", "true"}}, token);
        return rebaseRunResult(repo, output, "git rebase --continue");
      },
      rpc::Mode::Serial);

  dispatcher.method(
      "rebase/abort",
      [&context](const rpc::Json& params, const CancelToken& token,
                 const rpc::NotifyFn&) -> rpc::Json {
        requireGitCli(context);
        auto repo = openRepo(context, params);
        runGitOrThrow(repo, {"rebase", "--abort"}, token, "git rebase --abort");
        return rpc::Json::object();
      },
      rpc::Mode::Serial);
}

}  // namespace gg::services
