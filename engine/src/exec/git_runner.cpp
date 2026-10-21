#include "exec/git_runner.h"

#include <array>
#include <string_view>
#include <utility>

#include "exec/git_process.h"

namespace gg::exec {

namespace {

// Subcommands that can stop for input no one can give: a host-key
// confirmation, an ssh key passphrase or a credential for those that contact
// a remote, and a signing passphrase for those that create commits or tags
// (commit.gpgSign, tag.gpgSign). git runs with no terminal and
// GIT_TERMINAL_PROMPT=0, but gpg-agent's pinentry drawn on the terminal named
// by GPG_TTY, or a helper that ignores both, still waits until the timeout.
bool mayWaitForInput(const std::vector<std::string>& args) {
  static constexpr std::array<std::string_view, 12> kSubcommands = {
      "am",    "cherry-pick", "clone", "commit", "fetch",  "ls-remote",
      "merge", "pull",        "push",  "rebase", "revert", "tag"};
  // Global options come first; -c and -C take their value as the next word.
  size_t i = 0;
  while (i < args.size() && looksLikeGitOption(args[i])) {
    i += (args[i] == "-c" || args[i] == "-C") ? 2 : 1;
  }
  if (i >= args.size()) return false;
  for (std::string_view name : kSubcommands) {
    if (args[i] == name) return true;
  }
  return false;
}

}  // namespace

Result<RunStatus> runGit(const std::string& cwd, std::vector<std::string> args, const RunOpts& opts,
                         const CancelToken& token, const GitSink& sink) {
  const bool mayPrompt = mayWaitForInput(args);
  SpawnOpts spawnOpts;
  spawnOpts.extraEnv = opts.extraEnv;
  spawnOpts.rawOutput = opts.rawOutput;
  spawnOpts.timeout = opts.timeout;
  auto process = GitProcess::spawn(cwd, std::move(args), spawnOpts);
  if (!process) return process.error();

  if (opts.rawOutput) {
    sink(process.value().readAll(token));
  } else {
    std::string line;
    while (process.value().readLine(line, token)) sink(std::move(line));
  }

  RunStatus status;
  status.exitCode = process.value().wait(token);
  status.stderrText = process.value().stderrOutput();
  // Output produced before the kill is truncated at an arbitrary point, so a
  // timed-out run is an error rather than a short result.
  if (process.value().timedOut()) {
    std::string message = "git timed out after " + std::to_string(opts.timeout.count()) + "ms";
    if (mayPrompt) {
      message +=
          "; it may have been waiting for input GitGlasses cannot show, such as an ssh or "
          "signing passphrase, a host-key confirmation or a credential";
    }
    return Error{ErrorCode::GitError, std::move(message)};
  }
  return status;
}

}  // namespace gg::exec
