#pragma once

#include <gtest/gtest.h>

#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <optional>
#include <sstream>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

#include "exec/cli_detect.h"
#include "util/temp_file.h"

namespace gg::testing {

// Sets or clears a process environment variable; children spawned via
// std::system inherit it, which replaces shell-side `VAR=x cmd` prefixes.
inline void setEnvVar(const std::string& name, const std::string& value) {
#ifdef _WIN32
  ::_putenv_s(name.c_str(), value.c_str());
#else
  ::setenv(name.c_str(), value.c_str(), 1);
#endif
}

inline void unsetEnvVar(const std::string& name) {
#ifdef _WIN32
  ::_putenv_s(name.c_str(), "");
#else
  ::unsetenv(name.c_str());
#endif
}

// Sets an environment variable for the current scope and restores the prior
// state on destruction.
class ScopedEnv {
 public:
  ScopedEnv(std::string name, const std::string& value) : name_(std::move(name)) {
    if (const char* old = std::getenv(name_.c_str())) previous_ = old;
    setEnvVar(name_, value);
  }
  ~ScopedEnv() {
    if (previous_) {
      setEnvVar(name_, *previous_);
    } else {
      unsetEnvVar(name_);
    }
  }
  ScopedEnv(const ScopedEnv&) = delete;
  ScopedEnv& operator=(const ScopedEnv&) = delete;

 private:
  std::string name_;
  std::optional<std::string> previous_;
};

// Creates a fresh, empty directory in the system temp directory and returns
// its path. The name carries a random component, so test processes running
// concurrently (ctest -j, or several checkouts on one machine) never share a
// directory.
inline std::filesystem::path makeTempDir(const std::string& prefix) {
  for (int attempt = 0; attempt < 8; ++attempt) {
    std::filesystem::path dir = util::randomTempPath(prefix, "");
    // create_directory reports false for an existing path, so a name another
    // process already holds is never reused.
    if (std::filesystem::create_directory(dir)) return dir;
  }
  throw std::runtime_error("could not create a unique temp directory for " + prefix);
}

// Turns the engine's Restricted Mode on for the current scope. Declared before
// a session, so the session's context is built in the mode and the mode is
// cleared only after the session has shut down.
class ScopedRestrictedMode {
 public:
  ScopedRestrictedMode() { exec::setRestrictedMode(true); }
  ~ScopedRestrictedMode() { exec::setRestrictedMode(false); }
  ScopedRestrictedMode(const ScopedRestrictedMode&) = delete;
  ScopedRestrictedMode& operator=(const ScopedRestrictedMode&) = delete;
};

// Platform null device for discarding command output.
inline const char* nullDevice() {
#ifdef _WIN32
  return "NUL";
#else
  return "/dev/null";
#endif
}

// Fixture commands must be a single git invocation whose only quoting is
// double quotes: that subset means the same thing to sh and to cmd.exe.
inline void assertPortableGitCommand(const std::string& command) {
  ASSERT_EQ(command.rfind("git ", 0), 0u) << "fixture commands must invoke git: " << command;
  ASSERT_EQ(command.find_first_of("'&|;<>`$"), std::string::npos)
      << "shell-specific syntax is not portable: " << command;
}

// Runs a single `git ...` command in `dir`, asserting success. The repository
// is addressed with `git -C` instead of a shell `cd`.
inline void runGit(const std::filesystem::path& dir, const std::string& command) {
  assertPortableGitCommand(command);
  const std::string full = "git -C \"" + dir.string() + "\" " + command.substr(4);
  ASSERT_EQ(std::system(full.c_str()), 0) << "fixture command failed: " << command;
}

// Runs `git <args>` in `dir` and returns its stdout. Output is captured via a
// temp-file redirection, which behaves identically under sh and cmd.exe.
// `quiet` also discards stderr; the exit status is intentionally ignored so
// probes that may fail (e.g. rev-parse of a missing ref) return "".
inline std::string gitCapture(const std::filesystem::path& dir, const std::string& args,
                              bool quiet = false) {
  const std::filesystem::path outFile = util::randomTempPath("gg-capture-", ".txt");
  std::string command =
      "git -C \"" + dir.string() + "\" " + args + " > \"" + outFile.string() + "\"";
  if (quiet) command += std::string(" 2>") + nullDevice();
  // Exit status deliberately ignored: probes may fail and return "".
  [[maybe_unused]] const int rc = std::system(command.c_str());
  std::ifstream in(outFile, std::ios::binary);
  std::ostringstream buffer;
  buffer << in.rdbuf();
  std::error_code ec;
  std::filesystem::remove(outFile, ec);
  return buffer.str();
}

// gitCapture split into lines (trailing newline dropped).
inline std::vector<std::string> gitLines(const std::filesystem::path& dir,
                                         const std::string& args) {
  const std::string output = gitCapture(dir, args);
  std::vector<std::string> lines;
  size_t pos = 0;
  while (pos < output.size()) {
    const size_t nl = output.find('\n', pos);
    if (nl == std::string::npos) {
      lines.push_back(output.substr(pos));
      break;
    }
    lines.push_back(output.substr(pos, nl - pos));
    pos = nl + 1;
  }
  return lines;
}

// Whether the git on PATH is at least `major`.`minor`.
inline bool gitAtLeast(const std::filesystem::path& dir, int major, int minor) {
  int haveMajor = 0;
  int haveMinor = 0;
  const std::string version = gitLines(dir, "--version").at(0);
  if (std::sscanf(version.c_str(), "git version %d.%d", &haveMajor, &haveMinor) != 2) return true;
  return haveMajor > major || (haveMajor == major && haveMinor >= minor);
}

// Creates a throwaway git repository with deterministic identity/dates and a
// single initial commit. Removed on destruction.
class FixtureRepo {
 public:
  FixtureRepo() {
    root_ = makeTempDir("gg-fixture-");
    // Hermetic against host/system git config (e.g. Git for Windows ships
    // system-level core.autocrlf=true, which would change checked-out bytes
    // and blob hashes).
    setEnvVar("GIT_CONFIG_NOSYSTEM", "1");
    run("git init -q -b main");
    run("git config core.autocrlf false");
    run("git config user.name Fixture");
    run("git config user.email fixture@example.invalid");
    run("git config commit.gpgsign false");
    // No background maintenance after commits: newer git starts a detached
    // `git maintenance run --auto` that repacks while a test looks.
    run("git config maintenance.auto false");
    run("git config gc.auto 0");
    writeFile("README.md", "fixture\n");
    run("git add README.md");
    commit("initial commit");
  }

  ~FixtureRepo() {
    std::error_code ec;
    std::filesystem::remove_all(root_, ec);
  }

  const std::filesystem::path& root() const { return root_; }

  void writeFile(const std::string& name, const std::string& contents) {
    std::filesystem::path file = root_ / name;
    std::filesystem::create_directories(file.parent_path());
    // Binary mode keeps "\n" bytes as-is on every platform, so blob hashes
    // (and therefore commit SHAs) stay identical.
    FILE* f = std::fopen(file.string().c_str(), "wb");
    ASSERT_NE(f, nullptr);
    std::fwrite(contents.data(), 1, contents.size(), f);
    std::fclose(f);
  }

  // Commits with the fixed fixture dates, keeping SHAs deterministic.
  void commit(const std::string& message) { commitAt("2026-01-01T00:00:00Z", message); }

  // Commits with an explicit author/committer date.
  void commitAt(const std::string& date, const std::string& message) {
    ASSERT_EQ(message.find_first_of("\"'"), std::string::npos)
        << "fixture messages must not contain quotes: " << message;
    runAt(date, "git commit -q --allow-empty -m \"" + message + "\"");
  }

  // Runs a git command with both git dates pinned to `date`.
  void runAt(const std::string& date, const std::string& command) {
    ScopedEnv author("GIT_AUTHOR_DATE", date);
    ScopedEnv committer("GIT_COMMITTER_DATE", date);
    run(command);
  }

  // Runs a single `git ...` command inside the repo, asserting success.
  void run(const std::string& command) { runGit(root_, command); }

  // Runs a git command whose failure is expected or tolerated (e.g. a merge
  // that must conflict); all output is discarded.
  void tryRun(const std::string& command) {
    assertPortableGitCommand(command);
    const std::string full = "git -C \"" + root_.string() + "\" " + command.substr(4) + " > " +
                             nullDevice() + " 2>&1";
    // Failure is the tolerated case; the exit status is irrelevant.
    [[maybe_unused]] const int rc = std::system(full.c_str());
  }

 private:
  std::filesystem::path root_;
};

}  // namespace gg::testing
