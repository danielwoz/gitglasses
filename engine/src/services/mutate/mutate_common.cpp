#include "services/mutate/mutate_common.h"

#include <git2.h>

#include <algorithm>
#include <array>
#include <filesystem>
#include <fstream>
#include <string_view>
#include <utility>

#include "exec/askpass.h"
#include "exec/git_process.h"
#include "exec/git_runner.h"
#include "exec/sequence_editor.h"
#include "services/mutate/git_errors.h"

namespace gg::services::mutate_detail {

namespace {

#ifndef _WIN32
// The subcommand of a git argv: the first word after the global options (-c
// and -C take their value as the next word).
std::string_view subcommandOf(const std::vector<std::string>& args) {
  size_t i = 0;
  while (i < args.size() && exec::looksLikeGitOption(args[i])) {
    i += (args[i] == "-c" || args[i] == "-C") ? 2 : 1;
  }
  return i < args.size() ? std::string_view(args[i]) : std::string_view();
}
#endif

// Value of a string config entry, with the level it was found at.
struct ConfigValue {
  std::string value;
  int level = -1;
};

ConfigValue configEntry(git_config* config, const char* name) {
  ConfigValue out;
  git_config_entry* entry = nullptr;
  if (git_config_get_entry(&entry, config, name) == 0 && entry) {
    out.value = entry->value ? entry->value : "";
    out.level = static_cast<int>(entry->level);
    git_config_entry_free(entry);
  }
  return out;
}

// Puts the gpg signing shim (exec/gpg_shim.cpp) in front of gpg for a
// command that may sign a commit, so a passphrase gpg cannot ask for on a
// terminal is asked for in the editor instead. Applies only while prompts
// reach a client, to repositories that sign with OpenPGP (commit.gpgSign,
// gpg.format unset or openpgp); the user's own gpg program, if configured,
// is the one the shim runs.
void prepareSigning(const std::string& cwd, std::vector<std::string>& args, exec::RunOpts& opts) {
#ifdef _WIN32
  (void)cwd;
  (void)args;
  (void)opts;
#else
  if (!exec::askpassEnabled()) return;
  static constexpr std::array<std::string_view, 7> kCommitting = {
      "am", "cherry-pick", "commit", "merge", "pull", "rebase", "revert"};
  const std::string_view subcommand = subcommandOf(args);
  bool committing = false;
  for (std::string_view name : kCommitting) committing = committing || subcommand == name;
  if (!committing) return;

  git_repository* raw = nullptr;
  if (git_repository_open_ext(&raw, cwd.c_str(), 0, nullptr) != 0) return;
  git_config* config = nullptr;
  const bool haveConfig = git_repository_config_snapshot(&config, raw) == 0;
  git_repository_free(raw);
  if (!haveConfig) return;
  int sign = 0;
  const bool signs = git_config_get_bool(&sign, config, "commit.gpgsign") == 0 && sign;
  const std::string format = configEntry(config, "gpg.format").value;
  // gpg.program and gpg.openpgp.program name the same setting; the one from
  // the more specific config file wins.
  const ConfigValue openpgp = configEntry(config, "gpg.openpgp.program");
  const ConfigValue generic = configEntry(config, "gpg.program");
  git_config_free(config);
  if (!signs || (!format.empty() && format != "openpgp")) return;

  std::string program = "gpg";
  if (openpgp.level >= 0 && openpgp.level >= generic.level && !openpgp.value.empty()) {
    program = openpgp.value;
  } else if (generic.level >= 0 && !generic.value.empty()) {
    program = generic.value;
  }
  args.insert(args.begin(), {"-c", "gpg.program=" + exec::selfExePath()});
  opts.extraEnv.push_back(std::string(exec::kGpgProgramVar) + "=" + program);
#endif
}

// Collects a run's stdout lines and exit status into a GitOutput.
Result<GitOutput> collectLines(const std::string& cwd, std::vector<std::string> args,
                               exec::RunOpts opts, const CancelToken& token) {
  prepareSigning(cwd, args, opts);
  GitOutput output;
  auto status = exec::runGit(cwd, std::move(args), opts, token, [&output](std::string line) {
    output.lines.push_back(std::move(line));
  });
  if (!status) return status.error();
  output.exitCode = status.value().exitCode;
  output.stderrText = status.value().stderrText;
  output.promptDeclined = status.value().promptDeclined;
  return output;
}

bool blank(const std::string& text) {
  return text.find_first_not_of(" \t\r\n") == std::string::npos;
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

void throwGitFailure(const std::string& what, const GitOutput& output,
                     const std::string& operation) {
  std::string stdoutText;
  for (const auto& line : output.lines) stdoutText += line + "\n";
  const std::string& detail = blank(output.stderrText) ? stdoutText : output.stderrText;
  rpc::Json data = describeGitFailure(output.stderrText + "\n" + stdoutText);
  if (output.promptDeclined) {
    rpc::Json cancelled = {{"kind", "cancelled"}};
    if (data.is_object() && data.contains("host")) cancelled["host"] = data["host"];
    data = std::move(cancelled);
  }
  if (operation != "none") {
    if (data.is_null()) data = {{"kind", "stopped"}};
    data["operation"] = operation;
  }
  throw rpc::HandlerError{
      {ErrorCode::GitError, what + " failed (" + std::to_string(output.exitCode) + "): " + detail},
      std::move(data)};
}

GitOutput runGitOrThrow(const core::Repo& repo, std::vector<std::string> args,
                        const CancelToken& token, const std::string& what,
                        std::chrono::milliseconds timeout) {
  exec::RunOpts opts;
  opts.timeout = timeout;
  auto output = collectLines(repoCwd(repo), std::move(args), opts, token);
  if (!output) throw rpc::HandlerError{{output.error()}};
  if (output.value().exitCode != 0) throwGitFailure(what, output.value());
  return std::move(output.value());
}

rpc::Json runConflictAware(const core::Repo& repo, std::vector<std::string> args,
                           const CancelToken& token, const std::string& what,
                           std::chrono::milliseconds timeout) {
  exec::RunOpts opts;
  opts.timeout = timeout;
  auto output = collectLines(repoCwd(repo), std::move(args), opts, token);
  if (!output) throw rpc::HandlerError{{output.error()}};
  const SequencerState state = sequencerState(repo);
  if (state.conflicted) return {{"conflicts", true}};
  if (output.value().exitCode == 0) return {{"conflicts", false}};
  throwGitFailure(what, output.value(), state.operation);
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

  // The repository keeps the index it loaded first; git may have rewritten
  // the file since (a merge, an abort, the next rebase step), so reload it
  // when it changed on disk.
  git_index* rawIndex = nullptr;
  if (git_repository_index(&rawIndex, repo.raw()) == 0) {
    if (git_index_read(rawIndex, /*force=*/0) == 0) {
      state.conflicted = git_index_has_conflicts(rawIndex) != 0;
    }
    git_index_free(rawIndex);
  }
  return state;
}

std::string configString(const core::Repo& repo, const std::string& key) {
  git_config* config = nullptr;
  if (git_repository_config_snapshot(&config, repo.raw()) != 0) return {};
  std::string value = configEntry(config, key.c_str()).value;
  git_config_free(config);
  return value;
}

std::vector<std::string> remoteNames(const core::Repo& repo) {
  std::vector<std::string> names;
  git_strarray list{};
  if (git_remote_list(&list, repo.raw()) != 0) return names;
  for (size_t i = 0; i < list.count; ++i) names.emplace_back(list.strings[i]);
  git_strarray_dispose(&list);
  std::sort(names.begin(), names.end());
  return names;
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
