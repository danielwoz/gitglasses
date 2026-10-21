#pragma once

#include <string>

#include "rpc/dispatcher.h"
#include "util/result.h"

namespace gg::services {

// error.data for a git failure, read from git's output (stderr and stdout;
// the engine runs git with LC_ALL=C, so the messages are stable): an object
// with `kind` and, when git named it, `host` and `partialClone`. Null when the
// output matches no known failure.
rpc::Json describeGitFailure(const std::string& output);

// The dispatcher's error-data hook: describes GitError failures from their
// message, which carries git's output. Null for every other error.
rpc::Json gitErrorData(const Error& error);

}  // namespace gg::services
