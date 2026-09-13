#include "exec/git_runner.h"

#include <utility>

#include "exec/git_process.h"

namespace gg::exec {

Result<RunStatus> runGit(const std::string& cwd, std::vector<std::string> args,
                         const RunOpts& opts, const CancelToken& token, const GitSink& sink) {
  SpawnOpts spawnOpts;
  spawnOpts.extraEnv = opts.extraEnv;
  spawnOpts.rawOutput = opts.rawOutput;
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
  return status;
}

}  // namespace gg::exec
