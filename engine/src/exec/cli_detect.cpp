#include "exec/cli_detect.h"

#include <cstdlib>
#include <cstring>
#include <string>

#include "exec/git_process.h"
#include "util/cancel.h"

namespace gg::exec {

namespace {

bool probeGitCli() {
  auto process = GitProcess::spawn(".", {"--version"});
  if (!process) return false;
  CancelToken token;
  std::string line;
  while (process.value().readLine(line, token)) {
  }
  return process.value().wait(token) == 0;
}

}  // namespace

bool gitCliAvailable() {
  const char* noCli = std::getenv("GG_NO_GIT_CLI");
  if (noCli && std::strcmp(noCli, "1") == 0) return false;
  static const bool available = probeGitCli();
  return available;
}

}  // namespace gg::exec
