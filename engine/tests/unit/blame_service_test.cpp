#include "services/blame/blame_service.h"

#include <gtest/gtest.h>

#include "core/git2.h"
#include "test_fixtures.h"

namespace gg::services {
namespace {

// Fixture with layered history: three commits touching distinct line ranges
// of the same file, so hunks attribute to different commits.
struct BlameServiceTest : ::testing::Test {
  core::LibGit2 libgit2;
  gg::testing::FixtureRepo fixture;
  cache::BlameCache blameCache;
  BlameService service{blameCache};

  void SetUp() override {
    fixture.writeFile("code.txt", "alpha\nbeta\ngamma\n");
    fixture.run("git add code.txt");
    fixture.commit("add code");
    fixture.writeFile("code.txt", "alpha\nbeta MODIFIED\ngamma\n");
    fixture.run("git add code.txt");
    fixture.commit("modify beta");
  }

  Result<BlameSummary> blame(const BlameRequest& request, std::vector<exec::BlameHunk>* hunks) {
    auto repo = core::Repo::open(fixture.root().string());
    EXPECT_TRUE(repo.ok());
    return service.blame(repo.value(), request, CancelToken(),
                         [&](const exec::BlameHunk& h) { hunks->push_back(h); });
  }
};

TEST_F(BlameServiceTest, BlamesWorkingTreeAcrossCommits) {
  std::vector<exec::BlameHunk> hunks;
  auto summary = blame({.path = "code.txt"}, &hunks);
  ASSERT_TRUE(summary.ok()) << summary.error().message;
  EXPECT_FALSE(summary.value().fromCache);

  // Line 2 belongs to "modify beta"; lines 1 and 3 to "add code".
  ASSERT_GE(hunks.size(), 2u);
  std::string line1Sha, line2Sha;
  for (const auto& h : hunks) {
    for (std::uint32_t l = h.resultLine; l < h.resultLine + h.lineCount; ++l) {
      if (l == 1) line1Sha = h.sha;
      if (l == 2) line2Sha = h.sha;
    }
  }
  EXPECT_NE(line1Sha, line2Sha);
  EXPECT_EQ(summary.value().result->commits.at(line2Sha).summary, "modify beta");
  EXPECT_EQ(summary.value().result->commits.at(line1Sha).summary, "add code");
}

TEST_F(BlameServiceTest, SecondCleanBlameHitsCache) {
  std::vector<exec::BlameHunk> first, second;
  ASSERT_TRUE(blame({.path = "code.txt"}, &first).ok());
  auto summary = blame({.path = "code.txt"}, &second);
  ASSERT_TRUE(summary.ok());
  EXPECT_TRUE(summary.value().fromCache);
  ASSERT_EQ(first.size(), second.size());
  for (size_t i = 0; i < first.size(); ++i) {
    EXPECT_EQ(first[i].sha, second[i].sha);
    EXPECT_EQ(first[i].resultLine, second[i].resultLine);
  }
}

TEST_F(BlameServiceTest, EditingFileMissesCacheAndSeesUncommitted) {
  std::vector<exec::BlameHunk> before;
  ASSERT_TRUE(blame({.path = "code.txt"}, &before).ok());

  fixture.writeFile("code.txt", "alpha\nbeta MODIFIED\ngamma\nNEW LINE\n");
  std::vector<exec::BlameHunk> after;
  auto summary = blame({.path = "code.txt"}, &after);
  ASSERT_TRUE(summary.ok()) << summary.error().message;
  EXPECT_FALSE(summary.value().fromCache);

  bool sawUncommitted = false;
  for (const auto& h : after) {
    for (std::uint32_t l = h.resultLine; l < h.resultLine + h.lineCount; ++l) {
      if (l == 4) {
        EXPECT_EQ(h.sha, exec::kUncommittedSha);
        sawUncommitted = true;
      }
    }
  }
  EXPECT_TRUE(sawUncommitted);
}

TEST_F(BlameServiceTest, DirtyBufferContentsOverrideDisk) {
  // Disk stays clean; the "editor" has appended a line.
  std::vector<exec::BlameHunk> hunks;
  auto summary =
      blame({.path = "code.txt", .contents = "alpha\nbeta MODIFIED\ngamma\nunsaved edit\n"},
            &hunks);
  ASSERT_TRUE(summary.ok()) << summary.error().message;

  std::string line4Sha;
  for (const auto& h : hunks) {
    for (std::uint32_t l = h.resultLine; l < h.resultLine + h.lineCount; ++l) {
      if (l == 4) line4Sha = h.sha;
    }
  }
  EXPECT_EQ(line4Sha, exec::kUncommittedSha);
}

TEST_F(BlameServiceTest, RevBlameIgnoresWorkingTree) {
  fixture.writeFile("code.txt", "completely\ndifferent\n");
  std::vector<exec::BlameHunk> hunks;
  auto summary = blame({.path = "code.txt", .rev = std::string("HEAD")}, &hunks);
  ASSERT_TRUE(summary.ok()) << summary.error().message;
  for (const auto& h : hunks) {
    EXPECT_NE(h.sha, exec::kUncommittedSha);
  }
}

TEST_F(BlameServiceTest, BlameFollowsRename) {
  fixture.run("git mv code.txt renamed.txt");
  fixture.commit("rename code.txt");

  std::vector<exec::BlameHunk> hunks;
  auto summary = blame({.path = "renamed.txt"}, &hunks);
  ASSERT_TRUE(summary.ok()) << summary.error().message;

  // Content lines still attribute to the pre-rename commits, and the hunk
  // records the original path.
  bool sawOldPath = false;
  for (const auto& h : hunks) {
    if (h.path == "code.txt") sawOldPath = true;
    EXPECT_NE(h.sha, exec::kUncommittedSha);
  }
  EXPECT_TRUE(sawOldPath);
}

TEST_F(BlameServiceTest, MissingFileReturnsGitError) {
  std::vector<exec::BlameHunk> hunks;
  auto summary = blame({.path = "no-such-file.txt"}, &hunks);
  ASSERT_FALSE(summary.ok());
  EXPECT_EQ(summary.error().code, ErrorCode::GitError);
}

// Golden parity: our parsed hunks must reproduce `git blame --line-porcelain`
// line attribution exactly.
TEST_F(BlameServiceTest, ParityWithGitLinePorcelain) {
  fixture.writeFile("code.txt", "alpha\nbeta MODIFIED\ngamma\nfourth\n");
  fixture.run("git add code.txt");
  fixture.commit("add fourth line");

  std::vector<exec::BlameHunk> hunks;
  ASSERT_TRUE(blame({.path = "code.txt"}, &hunks).ok());
  std::map<std::uint32_t, std::string> ourShaByLine;
  for (const auto& h : hunks) {
    for (std::uint32_t l = h.resultLine; l < h.resultLine + h.lineCount; ++l) {
      ourShaByLine[l] = h.sha;
    }
  }

  // Ask git directly and compare per line.
  FILE* pipe = popen(("cd '" + fixture.root().string() +
                      "' && git blame --line-porcelain code.txt | grep -E '^[0-9a-f]{40} '")
                         .c_str(),
                     "r");
  ASSERT_NE(pipe, nullptr);
  char buf[256];
  std::uint32_t line = 0;
  while (fgets(buf, sizeof(buf), pipe)) {
    ++line;
    ASSERT_EQ(ourShaByLine.at(line), std::string(buf, 40)) << "mismatch at line " << line;
  }
  pclose(pipe);
  EXPECT_EQ(line, ourShaByLine.size());
}

}  // namespace
}  // namespace gg::services
