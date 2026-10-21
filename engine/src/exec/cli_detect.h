#pragma once

#include <optional>
#include <string_view>

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

// A git release number, as `git --version` prints it.
struct GitVersion {
  int major = 0;
  int minor = 0;
  int patch = 0;

  // True for this release or any later one.
  bool atLeast(int wantMajor, int wantMinor, int wantPatch = 0) const;
};

// The release `git --version` names on its first line: "git version 2.43.0",
// "git version 2.39.3 (Apple Git-145)", "git version 2.41.0.windows.1",
// "git version 2.45.GIT". A missing patch number reads as 0; anything that
// does not start with "git version <major>.<minor>" is not understood.
std::optional<GitVersion> parseGitVersion(std::string_view line);

// Runs `git --version` now (no cache: the git on PATH is the one asked) and
// parses its answer. Empty when git does not run, as in Restricted Mode or
// with GG_NO_GIT_CLI=1, or when it names no release parseGitVersion reads.
std::optional<GitVersion> probeGitVersion();

}  // namespace gg::exec
