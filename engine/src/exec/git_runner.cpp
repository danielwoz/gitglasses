#include "exec/git_runner.h"

#include <utility>

#include "exec/git_process.h"

namespace gg::exec {

Result<RunStatus> runGit(const std::string& cwd, std::vector<std::string> args,
                         const RunOpts& opts, const CancelToken& token, const GitSink& sink) {
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
    return Error{ErrorCode::GitError,
                 "git timed out after " + std::to_string(opts.timeout.count()) + "ms"};
  }
  return status;
}

}  // namespace gg::exec
