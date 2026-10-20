#include "exec/cli_detect.h"

#include <atomic>
#include <charconv>
#include <cstdlib>
#include <cstring>
#include <string>
#include <tuple>

#include "exec/git_process.h"
#include "util/cancel.h"

namespace gg::exec {

namespace {

std::atomic<bool> restricted{false};

bool probeGitCli() {
  auto process = GitProcess::spawn(".", {"--version"});
  if (!process) return false;
  CancelToken token;
  std::string line;
  while (process.value().readLine(line, token)) {
  }
  return process.value().wait(token) == 0;
}

bool cliDisabledByEnvironment() {
  const char* noCli = std::getenv("GG_NO_GIT_CLI");
  return noCli && std::strcmp(noCli, "1") == 0;
}

// Reads the decimal number at the front of `text` and drops it. False when
// `text` does not start with a digit.
bool takeNumber(std::string_view& text, int& out) {
  const char* begin = text.data();
  const char* end = begin + text.size();
  const auto [next, error] = std::from_chars(begin, end, out);
  if (error != std::errc() || next == begin) return false;
  text.remove_prefix(static_cast<size_t>(next - begin));
  return true;
}

}  // namespace

void setRestrictedMode(bool value) { restricted.store(value); }

bool restrictedMode() { return restricted.load(); }

bool gitCliAvailable() {
  if (restrictedMode()) return false;
  if (cliDisabledByEnvironment()) return false;
  static const bool available = probeGitCli();
  return available;
}

bool GitVersion::atLeast(int wantMajor, int wantMinor, int wantPatch) const {
  return std::tie(major, minor, patch) >= std::tie(wantMajor, wantMinor, wantPatch);
}

std::optional<GitVersion> parseGitVersion(std::string_view line) {
  constexpr std::string_view kPrefix = "git version ";
  if (line.substr(0, kPrefix.size()) != kPrefix) return std::nullopt;
  line.remove_prefix(kPrefix.size());
  GitVersion version;
  if (!takeNumber(line, version.major)) return std::nullopt;
  if (line.empty() || line.front() != '.') return std::nullopt;
  line.remove_prefix(1);
  if (!takeNumber(line, version.minor)) return std::nullopt;
  // "2.45.GIT" (a build from a source tree) and "2.45" carry no patch number.
  if (!line.empty() && line.front() == '.') {
    line.remove_prefix(1);
    if (!takeNumber(line, version.patch)) version.patch = 0;
  }
  return version;
}

std::optional<GitVersion> probeGitVersion() {
  if (restrictedMode() || cliDisabledByEnvironment()) return std::nullopt;
  auto process = GitProcess::spawn(".", {"--version"});
  if (!process) return std::nullopt;
  CancelToken token;
  std::string first;
  std::string line;
  bool sawLine = false;
  while (process.value().readLine(line, token)) {
    if (!sawLine) first = line;
    sawLine = true;
  }
  if (process.value().wait(token) != 0) return std::nullopt;
  return parseGitVersion(first);
}

}  // namespace gg::exec
