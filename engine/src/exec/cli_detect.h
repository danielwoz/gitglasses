#pragma once

namespace gg::exec {

// Message carried by every refusal Restricted Mode causes.
inline constexpr const char* kRestrictedModeMessage =
    "not available in Restricted Mode: the repository is not trusted, so the engine runs no "
    "git command and changes nothing";

// Restricted Mode serves a repository whose contents are not trusted. git runs
// programs named by a repository's own configuration and attributes (hooks,
// clean/smudge filters, core.fsmonitor, diff drivers, core.sshCommand), so in
// this mode the engine runs no git process at all: GitProcess::spawn refuses
// every invocation and gitCliAvailable() reports false. Set once at startup,
// before the first ServiceContext is built.
void setRestrictedMode(bool restricted);
bool restrictedMode();

// True when a usable `git` CLI is on PATH and the engine may run it. False in
// Restricted Mode, without probing. The environment variable GG_NO_GIT_CLI=1
// also forces false (override hook for tests and CLI-less deployments); it is
// re-read on every call so contexts created after the variable changes
// observe it. The probe itself (`git --version` exiting 0) runs once and its
// result is cached for the life of the process.
bool gitCliAvailable();

}  // namespace gg::exec
