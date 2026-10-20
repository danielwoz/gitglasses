#include "services/mutate/rebase_methods.h"

#include <cstdint>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "exec/sequence_editor.h"
#include "services/mutate/mutate_common.h"
#include "services/params.h"
#include "util/temp_file.h"
#include "util/utf8_path.h"

namespace gg::services {

namespace {

using mutate_detail::GitOutput;
using mutate_detail::openRepo;
using mutate_detail::rebaseInProgress;
using mutate_detail::requirePositional;
using mutate_detail::runGit;
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

// The editor shim command for `mode` with `control` as its control file. git
// runs it through `sh -c`, which wants forward-slash paths on every platform
// (Git for Windows included).
std::string shimCommand(const std::string& mode, const std::filesystem::path& control) {
  return shellQuote(util::genericUtf8(util::pathFromUtf8(exec::selfExePath()))) + " " + mode + " " +
         shellQuote(util::genericUtf8(control));
}

// git strips message lines that start with the comment character, so the
// rebase runs with one that no line of the plan's messages starts with.
std::string chooseCommentChar(const rpc::Json& plan) {
  static constexpr std::string_view kCandidates = "#;@!$%^&|:~*+";
  for (const char candidate : kCandidates) {
    bool used = false;
    for (const auto& entry : plan) {
      std::istringstream lines(entry.value("message", ""));
      std::string line;
      while (!used && std::getline(lines, line)) used = !line.empty() && line.front() == candidate;
      if (used) break;
    }
    if (!used) return std::string(1, candidate);
  }
  return "#";
}

// Temp file carrying the rebase plan for the editor shims; removed when the
// rebase invocation returns. The sequence editor leaves a copy in git's
// rebase state for a resumed rebase.
class ControlFile {
 public:
  ControlFile(const rpc::Json& plan, const std::string& commentChar) {
    path_ = util::randomTempPath("gg-rebase-", ".json");
    std::ofstream out(path_, std::ios::binary | std::ios::trunc);
    out << rpc::Json{{"plan", plan}, {"commentChar", commentChar}}.dump();
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
  const std::filesystem::path& path() const { return path_; }

  // Why the sequence editor refused the plan, or "" when it did not.
  std::string error() const {
    std::ifstream in(path_, std::ios::binary);
    std::ostringstream buffer;
    buffer << in.rdbuf();
    const rpc::Json parsed = rpc::Json::parse(buffer.str(), nullptr, false);
    return parsed.is_object() ? parsed.value("error", "") : "";
  }

 private:
  std::filesystem::path path_;
  bool ok_ = false;
};

void validatePlan(const rpc::Json& params) {
  if (!params.contains("plan") || !params["plan"].is_array()) {
    throw rpc::HandlerError{{ErrorCode::InvalidParams, "'plan' must be an array"}};
  }
  if (params["plan"].empty()) {
    throw rpc::HandlerError{
        {ErrorCode::InvalidParams, "'plan' must list the commits rebase/preview returned"}};
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

// The commit `rev` names, as a full sha.
std::string resolveCommit(const core::Repo& repo, const std::string& rev,
                          const CancelToken& token) {
  auto output = runGit(repo, {"rev-parse", "--verify", "--quiet", rev + "^{commit}"}, token);
  if (!output) throw rpc::HandlerError{{output.error()}};
  if (output.value().exitCode != 0 || output.value().lines.empty()) {
    throw rpc::HandlerError{{ErrorCode::GitError, "'" + rev + "' does not name a commit"}};
  }
  return output.value().lines.front();
}

// The plan the sequence editor left in a running rebase's state, if any.
std::filesystem::path persistedPlan(const core::Repo& repo) {
  return util::pathFromUtf8(repo.gitdir()) / "rebase-merge" / exec::kPersistedPlanName;
}

// Everything git said about a failure: stderr, or stdout when git explained
// itself there.
std::string gitMessage(const GitOutput& output) {
  if (!output.stderrText.empty()) return output.stderrText;
  std::string text;
  for (const auto& line : output.lines) text += line + "\n";
  return text;
}

// Shared result mapping for rebase runs: exit 0 with no rebase state left is
// completion (an 'edit' stop also exits 0 but leaves state); a nonzero exit
// with rebase state on disk means git stopped on conflicts. `refusal` is the
// sequence editor's reason for refusing the plan, reported in place of git's
// generic editor failure.
rpc::Json rebaseRunResult(const core::Repo& repo, const Result<GitOutput>& output,
                          const std::string& what, const std::string& refusal = "") {
  if (!output) throw rpc::HandlerError{{output.error()}};
  const bool inProgress = rebaseInProgress(repo);
  if (output.value().exitCode == 0) {
    return {{"completed", !inProgress}, {"conflicts", false}};
  }
  if (inProgress) return {{"completed", false}, {"conflicts", true}};
  if (!refusal.empty()) {
    throw rpc::HandlerError{{ErrorCode::GitError, "rebase not started: " + refusal}};
  }
  throw rpc::HandlerError{{ErrorCode::GitError, what + " failed (" +
                                                    std::to_string(output.value().exitCode) +
                                                    "): " + gitMessage(output.value())}};
}

// Resumes a stopped rebase with `--continue` or `--skip`. A rebase this engine
// started still applies its plan's messages; any other one keeps the messages
// git prepared.
rpc::Json resumeRebase(ServiceContext& context, const rpc::Json& params, const CancelToken& token,
                       const std::string& flag) {
  requireGitCli(context);
  auto repo = openRepo(context, params);
  requireWorktree(repo);
  const std::filesystem::path plan = persistedPlan(repo);
  std::error_code ec;
  std::vector<std::string> args;
  std::vector<std::pair<std::string, std::string>> env;
  if (std::filesystem::exists(plan, ec)) {
    std::ifstream in(plan, std::ios::binary);
    std::ostringstream buffer;
    buffer << in.rdbuf();
    const rpc::Json parsed = rpc::Json::parse(buffer.str(), nullptr, false);
    const std::string commentChar = parsed.is_object() ? parsed.value("commentChar", "#") : "#";
    args = {"-c", "core.commentChar=" + commentChar};
    env = {{"GIT_EDITOR", shimCommand("--edit-message", plan)}};
  } else {
    // GIT_EDITOR=true accepts whatever message git prepared for the resumed
    // step.
    env = {{"GIT_EDITOR", "true"}};
  }
  args.insert(args.end(), {"rebase", flag});
  auto output = runGitWithEnv(repo.workdir(), std::move(args), env, token);
  return rebaseRunResult(repo, output, "git rebase " + flag);
}

}  // namespace

void registerRebaseMethods(rpc::Dispatcher& dispatcher, ServiceContext& context) {
  dispatcher.method(
      "rebase/preview",
      [&context](const rpc::Json& params, const CancelToken& token,
                 const rpc::NotifyFn&) -> rpc::Json {
        requireGitCli(context);
        // Concatenated into git arguments, so a leading '-' would survive as
        // an option ("--output=x" -> "--output=x^{commit}").
        const std::string upstream =
            requirePositional(requireString(params, "upstream"), "upstream");
        auto repo = openRepo(context, params);
        const std::string head = resolveCommit(repo, "HEAD", token);
        const std::string onto = resolveCommit(repo, upstream, token);
        // The commits `git rebase -i` puts in its todo, in its order: no
        // merges (they are flattened, not replayed) and none whose change the
        // upstream already has.
        auto output =
            runGitOrThrow(repo,
                          {"log", "--reverse", "--topo-order", "--no-merges", "--cherry-pick",
                           "--right-only", "--format=%H%x1f%s", onto + "..." + head},
                          token, "git log");
        rpc::Json entries = rpc::Json::array();
        for (const auto& line : output.lines) {
          const size_t sep = line.find('\x1f');
          if (sep == std::string::npos) continue;
          entries.push_back({{"sha", line.substr(0, sep)}, {"summary", line.substr(sep + 1)}});
        }
        auto merges = runGitOrThrow(repo, {"rev-list", "--count", "--merges", onto + ".." + head},
                                    token, "git rev-list");
        const std::int64_t mergeCount = merges.lines.empty() ? 0 : std::stoll(merges.lines.front());
        return {{"entries", std::move(entries)},
                {"headSha", head},
                {"upstreamSha", onto},
                {"mergeCount", mergeCount}};
      },
      rpc::Mode::Concurrent);

  dispatcher.method(
      "rebase/start",
      [&context](const rpc::Json& params, const CancelToken& token,
                 const rpc::NotifyFn&) -> rpc::Json {
        requireGitCli(context);
        // Reaches `git rebase -i <upstream>` as a positional.
        const std::string upstream =
            requirePositional(requireString(params, "upstream"), "upstream");
        validatePlan(params);
        const std::string expectedHead = optionalString(params, "expectedHead");
        const std::string expectedUpstream = optionalString(params, "expectedUpstream");
        if (params.contains("updateRefs") && !params["updateRefs"].is_boolean()) {
          throw rpc::HandlerError{{ErrorCode::InvalidParams, "'updateRefs' must be a boolean"}};
        }
        auto repo = openRepo(context, params);
        requireWorktree(repo);

        if (rebaseInProgress(repo)) {
          throw rpc::HandlerError{
              {ErrorCode::GitError,
               "a rebase is already in progress; continue, skip or abort it first"}};
        }
        // The plan was made for a branch tip and base; replaying it after
        // either moved would rebase commits the user never reviewed, or drop
        // ones made since.
        if (!expectedHead.empty()) {
          const std::string head = resolveCommit(repo, "HEAD", token);
          if (head != expectedHead) {
            throw rpc::HandlerError{
                {ErrorCode::GitError, "the branch moved since the rebase plan was made (HEAD was " +
                                          expectedHead.substr(0, 7) + ", is now " +
                                          head.substr(0, 7) + "); reload the plan"}};
          }
        }
        if (!expectedUpstream.empty()) {
          const std::string onto = resolveCommit(repo, upstream, token);
          if (onto != expectedUpstream) {
            throw rpc::HandlerError{
                {ErrorCode::GitError, "'" + upstream +
                                          "' moved since the rebase plan was made (it was " +
                                          expectedUpstream.substr(0, 7) + ", is now " +
                                          onto.substr(0, 7) + "); reload the plan"}};
          }
        }

        const rpc::Json& plan = params["plan"];
        const std::string commentChar = chooseCommentChar(plan);
        const ControlFile control(plan, commentChar);
        if (!control.ok()) {
          throw rpc::HandlerError{{ErrorCode::Internal, "cannot write rebase control file"}};
        }
        // The plan is authoritative, so config that rewrites the todo
        // (autosquash, rebase-merges) is switched off, and the todo is
        // generated with full command names for the shim to read.
        std::vector<std::string> args = {"-c",
                                         "core.commentChar=" + commentChar,
                                         "-c",
                                         "rebase.abbreviateCommands=false",
                                         "rebase",
                                         "-i",
                                         "--no-autosquash",
                                         "--no-rebase-merges"};
        if (params.value("autoStash", false)) args.push_back("--autostash");
        if (params.contains("updateRefs")) {
          args.push_back(params["updateRefs"].get<bool>() ? "--update-refs" : "--no-update-refs");
        }
        args.push_back(upstream);
        auto output =
            runGitWithEnv(repo.workdir(), std::move(args),
                          {{"GIT_SEQUENCE_EDITOR", shimCommand("--edit-sequence", control.path())},
                           {"GIT_EDITOR", shimCommand("--edit-message", control.path())}},
                          token);
        return rebaseRunResult(repo, output, "git rebase", control.error());
      },
      rpc::Mode::Serial);

  dispatcher.method(
      "rebase/continue",
      [&context](const rpc::Json& params, const CancelToken& token, const rpc::NotifyFn&)
          -> rpc::Json { return resumeRebase(context, params, token, "--continue"); },
      rpc::Mode::Serial);

  dispatcher.method(
      "rebase/skip",
      [&context](const rpc::Json& params, const CancelToken& token, const rpc::NotifyFn&)
          -> rpc::Json { return resumeRebase(context, params, token, "--skip"); },
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
