#pragma once

#include <functional>
#include <string>
#include <vector>

#include "util/cancel.h"
#include "util/result.h"

namespace gg::exec {

// Options for runGit() beyond the spawn defaults.
struct RunOpts {
  // "NAME=value" entries applied on top of the inherited environment.
  std::vector<std::string> extraEnv;
  // Hand stdout to the sink as one verbatim chunk instead of line by line.
  // Patch text needs this: CR characters and exact trailing newlines must
  // survive a round-trip.
  bool rawOutput = false;
};

// Receives the child's stdout: one call per line with the newline removed, or
// a single call with the whole stream when RunOpts::rawOutput is set.
using GitSink = std::function<void(std::string chunk)>;

// Exit status of a finished `git` invocation.
struct RunStatus {
  int exitCode = -1;
  std::string stderrText;
};

// Runs `git <args>` in `cwd` and drains its stdout into `sink`. Only spawn
// failures are Errors; a nonzero exit comes back in RunStatus::exitCode for
// the caller to interpret (conflict-aware methods treat some of them as
// results, not errors). Throws CancelledError when `token` fires.
Result<RunStatus> runGit(const std::string& cwd, std::vector<std::string> args,
                         const RunOpts& opts, const CancelToken& token, const GitSink& sink);

}  // namespace gg::exec
