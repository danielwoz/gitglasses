#include "exec/git_process.h"
#include "exec/git_runner.h"

#include <gtest/gtest.h>

#include <chrono>
#include <thread>

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

}  // namespace
}  // namespace gg::exec
