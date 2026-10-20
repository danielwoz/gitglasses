// Tests for the shared test harness: ctest runs every test in its own
// process, often many at once, so each process needs temp paths and a git
// configuration that no other process shares.

#include <gtest/gtest.h>

#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <sstream>
#include <string>

#include "exec/sequence_editor.h"
#include "test_fixtures.h"
#include "util/temp_file.h"

namespace gg::testing {
namespace {

TEST(TestHarness, TempDirsAreFreshAndDistinct) {
  const std::filesystem::path first = makeTempDir("gg-harness-");
  const std::filesystem::path second = makeTempDir("gg-harness-");
  EXPECT_NE(first, second);
  EXPECT_TRUE(std::filesystem::is_directory(first));
  EXPECT_TRUE(std::filesystem::is_empty(first));
  EXPECT_TRUE(std::filesystem::is_directory(second));
  EXPECT_TRUE(std::filesystem::is_empty(second));
  std::filesystem::remove_all(first);
  std::filesystem::remove_all(second);
}

// Prints the fixture root on its own line; the cross-process test below runs
// this test in child processes and compares what they report.
TEST(TestHarness, ReportsFixtureRoot) {
  FixtureRepo fixture;
  ASSERT_TRUE(std::filesystem::is_directory(fixture.root() / ".git"));
  std::cout << "fixture-root=" << fixture.root().string() << std::endl;
}

#ifndef _WIN32
// Runs ReportsFixtureRoot in a fresh process and returns the root it used.
// Every child gets the same gtest random seed: gtest derives the seed from
// the start time in milliseconds, so processes that ctest -j launches
// together routinely share one, and nothing may be named after it.
std::string fixtureRootFromChildProcess() {
  const std::filesystem::path output = util::randomTempPath("gg-harness-", ".txt");
  const std::string command = "\"" + exec::selfExePath() +
                              "\" --gtest_filter=TestHarness.ReportsFixtureRoot"
                              " --gtest_random_seed=1 > \"" +
                              output.string() + "\" 2>&1";
  EXPECT_EQ(std::system(command.c_str()), 0) << command;
  std::ifstream in(output, std::ios::binary);
  std::string line;
  std::string root;
  while (std::getline(in, line)) {
    if (line.rfind("fixture-root=", 0) == 0) root = line.substr(13);
  }
  in.close();
  std::filesystem::remove(output);
  return root;
}

TEST(TestHarness, SeparateProcessesGetDistinctFixtureRoots) {
  const std::string first = fixtureRootFromChildProcess();
  const std::string second = fixtureRootFromChildProcess();
  ASSERT_FALSE(first.empty());
  ASSERT_FALSE(second.empty());
  EXPECT_NE(first, second);
}
#endif

TEST(TestHarness, GitReadsTheSuiteGlobalConfig) {
  const char* global = std::getenv("GIT_CONFIG_GLOBAL");
  ASSERT_NE(global, nullptr);
  EXPECT_TRUE(std::filesystem::is_regular_file(global));

  FixtureRepo fixture;
  EXPECT_EQ(gitCapture(fixture.root(), "config --global user.email"), "tests@example.invalid\n");
  // Repo-local identity still wins, which keeps fixture commit SHAs stable.
  EXPECT_EQ(gitCapture(fixture.root(), "config user.email"), "fixture@example.invalid\n");
}

}  // namespace
}  // namespace gg::testing
