#pragma once

namespace gg::exec {

// True when a usable `git` CLI is on PATH. The environment variable
// GG_NO_GIT_CLI=1 forces false (override hook for tests and CLI-less
// deployments); it is re-read on every call so contexts created after the
// variable changes observe it. A positive probe (`git --version` exiting 0)
// is cached for the life of the process.
bool gitCliAvailable();

}  // namespace gg::exec
