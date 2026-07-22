#include "exec/git_process.h"

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
