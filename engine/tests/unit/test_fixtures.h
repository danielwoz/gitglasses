#pragma once

#include <gtest/gtest.h>

#include <cstdlib>
#include <filesystem>
#include <string>

namespace gg::testing {

// Creates a throwaway git repository with deterministic identity/dates and a
// single initial commit. Removed on destruction.
class FixtureRepo {
 public:
  FixtureRepo() {
    root_ = std::filesystem::temp_directory_path() /
            ("gg-fixture-" + std::to_string(::testing::UnitTest::GetInstance()->random_seed()) +
             "-" + std::to_string(counter()++));
    std::filesystem::create_directories(root_);
    run("git init -q -b main");
    run("git config user.name Fixture");
    run("git config user.email fixture@example.invalid");
    run("git config commit.gpgsign false");
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
    FILE* f = std::fopen(file.string().c_str(), "wb");
    ASSERT_NE(f, nullptr);
    std::fwrite(contents.data(), 1, contents.size(), f);
    std::fclose(f);
  }

  void commit(const std::string& message) {
    // Fixed dates keep fixture SHAs deterministic across runs.
    run("GIT_AUTHOR_DATE='2026-01-01T00:00:00Z' GIT_COMMITTER_DATE='2026-01-01T00:00:00Z' "
        "git commit -q --allow-empty -m '" +
        message + "'");
  }

  void run(const std::string& command) {
    const std::string full = "cd '" + root_.string() + "' && " + command;
    ASSERT_EQ(std::system(full.c_str()), 0) << "fixture command failed: " << command;
  }

 private:
  static int& counter() {
    static int value = 0;
    return value;
  }

  std::filesystem::path root_;
};

}  // namespace gg::testing
