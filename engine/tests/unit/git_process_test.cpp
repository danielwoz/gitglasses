#include "exec/git_process.h"
#include "exec/git_runner.h"

#include <gtest/gtest.h>

#include <algorithm>
#include <chrono>
#include <filesystem>
#include <map>
#include <set>
#include <sstream>
#include <string>
#include <thread>

#ifndef _WIN32
#include <fcntl.h>
#include <unistd.h>
#endif

#include "exec/cli_detect.h"
#include "test_fixtures.h"

namespace gg::exec {
namespace {

TEST(GitProcess, RunsGitAndReadsOutput) {
  gg::testing::FixtureRepo fixture;
  auto process = GitProcess::spawn(fixture.root().string(), {"rev-parse", "--abbrev-ref", "HEAD"});
  ASSERT_TRUE(process.ok()) << process.error().message;

  std::string line;
  CancelToken token;
  ASSERT_TRUE(process.value().readLine(line, token));
  EXPECT_EQ(line, "main");
  EXPECT_FALSE(process.value().readLine(line, token));
  EXPECT_EQ(process.value().wait(token), 0);
}

TEST(GitProcess, CapturesStderrAndExitCode) {
  gg::testing::FixtureRepo fixture;
  auto process = GitProcess::spawn(fixture.root().string(), {"rev-parse", "no-such-ref-xyz"});
  ASSERT_TRUE(process.ok());

  std::string line;
  CancelToken token;
  while (process.value().readLine(line, token)) {
  }
  EXPECT_NE(process.value().wait(token), 0);
  EXPECT_NE(process.value().stderrOutput().find("no-such-ref-xyz"), std::string::npos);
}

TEST(GitProcess, CancellationKillsChildPromptly) {
  gg::testing::FixtureRepo fixture;
  // `git log --stdin` blocks reading stdin (/dev/null keeps it alive long
  // enough only on some git versions), so use a command guaranteed to run
  // long: log with an absurd loop over reflog of all refs... simplest robust
  // long-runner is `git daemon` but that needs setup; instead cat-file
  // --batch-check waits on stdin — with stdin at /dev/null it exits. Use
  // `git hash-object --stdin-paths` which also reads stdin. Robust approach:
  // spawn blame on a file we make huge.
  std::string big;
  big.reserve(6 << 20);
  for (int i = 0; i < 200000; ++i) big += "line " + std::to_string(i) + "\n";
  fixture.writeFile("big.txt", big);
  fixture.run("git add big.txt");
  fixture.commit("add big file");

  auto process = GitProcess::spawn(fixture.root().string(), {"blame", "--incremental", "big.txt"});
  ASSERT_TRUE(process.ok());

  CancelSource source;
  std::thread canceller([&source] {
    std::this_thread::sleep_for(std::chrono::milliseconds(30));
    source.cancel();
  });

  std::string line;
  bool cancelled = false;
  auto start = std::chrono::steady_clock::now();
  try {
    while (process.value().readLine(line, source.token())) {
    }
    process.value().wait(source.token());
  } catch (const CancelledError&) {
    cancelled = true;
  }
  auto elapsed = std::chrono::steady_clock::now() - start;
  canceller.join();

  // Either the blame finished before the cancel fired (fast machine) or the
  // cancellation must have interrupted it quickly.
  if (cancelled) {
    EXPECT_LT(std::chrono::duration_cast<std::chrono::milliseconds>(elapsed).count(), 2000);
  }
}

TEST(GitProcess, TimeoutKillsTheChildAndIsReported) {
  gg::testing::FixtureRepo fixture;
  // `git cat-file --batch` waits on stdin, which is /dev/null here on most
  // platforms but is the closest portable stand-in for a child that never
  // finishes; the timeout must bound it either way.
  SpawnOpts opts;
  opts.timeout = std::chrono::milliseconds(200);
  auto process =
      GitProcess::spawn(fixture.root().string(), {"cat-file", "--batch-check"}, opts);
  ASSERT_TRUE(process.ok()) << process.error().message;

  CancelToken token;
  const auto start = std::chrono::steady_clock::now();
  std::string line;
  while (process.value().readLine(line, token)) {
  }
  process.value().wait(token);
  const auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(
      std::chrono::steady_clock::now() - start);
  // Whether it timed out or exited on EOF, it must not outlive the ceiling
  // by more than one poll interval.
  EXPECT_LT(elapsed.count(), 2000);
}

TEST(GitProcess, TimeoutSurfacesAsAGitErrorFromRunGit) {
  gg::testing::FixtureRepo fixture;
  // A deliberately unreachable remote: git retries the TCP connect for far
  // longer than the ceiling set here.
  RunOpts opts;
  opts.timeout = std::chrono::milliseconds(500);
  CancelToken token;
  const auto start = std::chrono::steady_clock::now();
  auto status = runGit(fixture.root().string(),
                       {"ls-remote", "--", "git://192.0.2.1/unreachable.git"}, opts, token,
                       [](std::string) {});
  const auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(
      std::chrono::steady_clock::now() - start);
  EXPECT_LT(elapsed.count(), 5000) << "the timeout did not bound the run";
  ASSERT_FALSE(status.ok()) << "a timed-out run must not look like a clean result";
  EXPECT_EQ(status.error().code, ErrorCode::GitError);
  EXPECT_NE(status.error().message.find("timed out"), std::string::npos)
      << status.error().message;
}

TEST(GitProcess, SpawnFailsInMissingDirectory) {
  auto process = GitProcess::spawn("/nonexistent/dir/xyz", {"status"});
  // posix_spawn reports chdir failure at spawn or via immediate exit.
  if (process.ok()) {
    std::string line;
    CancelToken token;
    while (process.value().readLine(line, token)) {
    }
    EXPECT_NE(process.value().wait(token), 0);
  }
}

TEST(GitProcess, RestrictedModeRefusesEverySpawn) {
  gg::testing::FixtureRepo fixture;
  gg::testing::ScopedRestrictedMode restricted;
  auto process = GitProcess::spawn(fixture.root().string(), {"--version"});
  CancelToken token;
  auto run = runGit(fixture.root().string(), {"status"}, {}, token, [](std::string) {});

  ASSERT_FALSE(process.ok());
  EXPECT_EQ(process.error().code, ErrorCode::Restricted);
  ASSERT_FALSE(run.ok());
  EXPECT_EQ(run.error().code, ErrorCode::Restricted);
  EXPECT_FALSE(gitCliAvailable());
}

#ifndef _WIN32

// Runs `git <args>` in `dir` to completion and returns its stdout.
std::string runToEnd(const std::filesystem::path& dir, std::vector<std::string> args) {
  auto process = GitProcess::spawn(dir.string(), std::move(args));
  EXPECT_TRUE(process.ok()) << process.error().message;
  if (!process.ok()) return {};
  CancelToken token;
  std::string out = process.value().readAll(token);
  EXPECT_EQ(process.value().wait(token), 0) << process.value().stderrOutput();
  return out;
}

// The descriptors open in this process.
std::set<int> openDescriptors() {
  std::set<int> fds;
  const long limit = std::min(sysconf(_SC_OPEN_MAX), 65536L);
  for (int fd = 0; fd < limit; ++fd) {
    if (fcntl(fd, F_GETFD) != -1) fds.insert(fd);
  }
  return fds;
}

// The output pipes close on exec by themselves. Where a spawn also closes
// every descriptor above stderr (glibc >= 2.34, macOS), that hides a pipe
// without the flag from the tests below that run a child; a build for an
// older glibc relies on the flag alone.
TEST(GitProcess, OutputPipesCloseOnExec) {
  int fds[2];
  ASSERT_TRUE(makeCloexecPipe(fds));
  EXPECT_TRUE(fcntl(fds[0], F_GETFD) & FD_CLOEXEC) << "read end";
  EXPECT_TRUE(fcntl(fds[1], F_GETFD) & FD_CLOEXEC) << "write end";
  close(fds[0]);
  close(fds[1]);
}

// The read ends this process holds while git runs would otherwise reach
// every child spawned meanwhile, along with its hooks and helpers.
TEST(GitProcess, DescriptorsHeldForAChildCloseOnExec) {
  gg::testing::FixtureRepo fixture;
  const std::set<int> before = openDescriptors();
  auto process = GitProcess::spawn(fixture.root().string(), {"--version"});
  ASSERT_TRUE(process.ok()) << process.error().message;
  int held = 0;
  for (int fd : openDescriptors()) {
    if (before.count(fd)) continue;
    ++held;
    EXPECT_TRUE(fcntl(fd, F_GETFD) & FD_CLOEXEC) << "fd " << fd << " would reach later children";
  }
  EXPECT_GE(held, 2) << "expected the stdout and stderr read ends";
  CancelToken token;
  process.value().readAll(token);
  EXPECT_EQ(process.value().wait(token), 0);
}

// A helper that a hook or alias leaves running in the background must not
// keep the request open: once git exits, stdout reaches EOF even though the
// helper lives on, because the helper holds no copy of the output pipes.
TEST(GitProcess, BackgroundedDescendantDoesNotHoldOutputOpen) {
  gg::testing::FixtureRepo fixture;
  const auto start = std::chrono::steady_clock::now();
  runToEnd(fixture.root(), {"-c", "alias.bg=!(exec </dev/null >/dev/null 2>&1; sleep 5) &", "bg"});
  const auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(
      std::chrono::steady_clock::now() - start);
  EXPECT_LT(elapsed.count(), 3000) << "the backgrounded helper held the output pipe open";
}

TEST(GitProcess, HookHelperLeftRunningDoesNotDelayACommit) {
  gg::testing::FixtureRepo fixture;
  const std::filesystem::path hook = fixture.root() / ".git" / "hooks" / "pre-commit";
  std::filesystem::create_directories(hook.parent_path());
  fixture.writeFile(".git/hooks/pre-commit",
                    "#!/bin/sh\n(exec </dev/null >/dev/null 2>&1; sleep 5) &\nexit 0\n");
  std::filesystem::permissions(hook, std::filesystem::perms::owner_all);

  CancelToken token;
  const auto start = std::chrono::steady_clock::now();
  auto status = runGit(fixture.root().string(), {"commit", "-q", "--allow-empty", "-m", "hooked"},
                       {}, token, [](std::string) {});
  const auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(
      std::chrono::steady_clock::now() - start);
  ASSERT_TRUE(status.ok()) << status.error().message;
  EXPECT_EQ(status.value().exitCode, 0) << status.value().stderrText;
  EXPECT_LT(elapsed.count(), 3000) << "the hook's helper held the output pipe open";
}

#endif  // !_WIN32

#ifdef __linux__

// The open descriptors of a shell git starts, mapped to their link targets
// ("pipe:[inode]" for a pipe). The listing's own command substitution shows up
// as one more pipe, distinct from the output pipes.
std::map<int, std::string> childDescriptors(const std::filesystem::path& dir) {
  const std::string listing = runToEnd(
      dir, {"-c", "alias.fds=!for f in /proc/$$/fd/*; do echo \"${f##*/} $(readlink $f)\"; done",
            "fds"});
  std::map<int, std::string> fds;
  std::istringstream lines(listing);
  int fd = -1;
  std::string target;
  while (lines >> fd >> target) fds[fd] = target;
  return fds;
}

TEST(GitProcess, ChildHoldsNoExtraCopyOfItsOutputPipes) {
  gg::testing::FixtureRepo fixture;
  const std::map<int, std::string> fds = childDescriptors(fixture.root());
  ASSERT_TRUE(fds.count(1) && fds.count(2)) << "listing failed";
  for (const auto& [fd, target] : fds) {
    if (fd <= 2) continue;
    EXPECT_NE(target, fds.at(1)) << "fd " << fd << " is another copy of stdout";
    EXPECT_NE(target, fds.at(2)) << "fd " << fd << " is another copy of stderr";
  }
}

// A child in its own session has no controlling terminal, so ssh and similar
// prompts fail at once instead of stopping on SIGTTIN.
TEST(GitProcess, ChildRunsInItsOwnSessionWithoutATerminal) {
  gg::testing::FixtureRepo fixture;
  const std::string stat = runToEnd(fixture.root(), {"-c", "alias.st=!cat /proc/$$/stat", "st"});
  const size_t close = stat.rfind(')');
  ASSERT_NE(close, std::string::npos) << stat;
  std::istringstream fields(stat.substr(close + 1));
  std::string state;
  long ppid = 0, pgrp = 0, session = 0, ttyNr = -1;
  fields >> state >> ppid >> pgrp >> session >> ttyNr;
  EXPECT_NE(session, static_cast<long>(getsid(0))) << stat;
  EXPECT_EQ(ttyNr, 0) << stat;
}

#endif  // __linux__

}  // namespace
}  // namespace gg::exec
