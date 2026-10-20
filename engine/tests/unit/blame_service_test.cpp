#include "services/blame/blame_service.h"

#include <gtest/gtest.h>

#include <map>
#include <set>
#include <string>
#include <vector>

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

  // Ask git directly and compare per line. Porcelain header lines start with
  // "<sha> <origLine> <finalLine>"; content lines start with a tab, so a
  // 40-hex-then-space prefix uniquely selects the headers.
  const auto isHex40 = [](const std::string& s) {
    return s.size() > 40 && s[40] == ' ' &&
           s.find_first_not_of("0123456789abcdef") == 40;
  };
  std::uint32_t line = 0;
  for (const auto& porcelain :
       gg::testing::gitLines(fixture.root(), "blame --line-porcelain code.txt")) {
    if (!isHex40(porcelain)) continue;
    ++line;
    ASSERT_EQ(ourShaByLine.at(line), porcelain.substr(0, 40)) << "mismatch at line " << line;
  }
  EXPECT_EQ(line, ourShaByLine.size());
}

// Line -> sha for one blame.
std::map<std::uint32_t, std::string> linesOf(const std::vector<exec::BlameHunk>& hunks) {
  std::map<std::uint32_t, std::string> lines;
  for (const auto& h : hunks) {
    for (std::uint32_t l = h.resultLine; l < h.resultLine + h.lineCount; ++l) lines[l] = h.sha;
  }
  return lines;
}

std::string revSha(const gg::testing::FixtureRepo& fixture, const std::string& spec) {
  std::string sha = gg::testing::gitCapture(fixture.root(), "rev-parse " + spec);
  while (!sha.empty() && (sha.back() == '\n' || sha.back() == '\r')) sha.pop_back();
  return sha;
}

// A commit whose only change is whitespace, made by someone tidying up.
struct IgnoreRevsTest : BlameServiceTest {
  std::string formatSha;

  void SetUp() override {
    BlameServiceTest::SetUp();
    fixture.writeFile("code.txt", "alpha \nbeta MODIFIED \ngamma \n");
    fixture.run("git add code.txt");
    fixture.commit("reformat");
    formatSha = revSha(fixture, "HEAD");
  }

  std::map<std::uint32_t, std::string> lines(const BlameRequest& request,
                                             bool* fromCache = nullptr) {
    std::vector<exec::BlameHunk> hunks;
    auto summary = blame(request, &hunks);
    EXPECT_TRUE(summary.ok()) << (summary.ok() ? "" : summary.error().message);
    if (fromCache && summary.ok()) *fromCache = summary.value().fromCache;
    return linesOf(hunks);
  }
};

// A configured ignore-revs file that is missing (a global setting most
// repositories have no file for) must not stop blame.
TEST_F(IgnoreRevsTest, MissingConfiguredFileDoesNotBreakBlame) {
  fixture.run("git config blame.ignoreRevsFile no-such-revs-file");
  const auto attribution = lines({.path = "code.txt"});
  ASSERT_EQ(attribution.size(), 3u);
  EXPECT_EQ(attribution.at(1), formatSha);
}

TEST_F(IgnoreRevsTest, ConfiguredFilesThatExistAreHonoured) {
  fixture.writeFile("revs.txt", formatSha + "\n");
  fixture.run("git config blame.ignoreRevsFile no-such-revs-file");
  fixture.run("git config --add blame.ignoreRevsFile revs.txt");
  const auto attribution = lines({.path = "code.txt"});
  ASSERT_EQ(attribution.size(), 3u);
  for (const auto& [line, sha] : attribution) EXPECT_NE(sha, formatSha) << "line " << line;
}

TEST_F(IgnoreRevsTest, RepositoryIgnoreRevsFileIsUsedWhenNothingIsConfigured) {
  fixture.writeFile(".git-blame-ignore-revs", "# formatting\n" + formatSha + "\n");
  auto attribution = lines({.path = "code.txt"});
  ASSERT_EQ(attribution.size(), 3u);
  EXPECT_EQ(attribution.at(1), revSha(fixture, "HEAD~2"));
  EXPECT_EQ(attribution.at(2), revSha(fixture, "HEAD~1"));

  // Asked not to, blame shows the formatting commit again.
  BlameRequest unfiltered{.path = "code.txt"};
  unfiltered.options.ignoreRevs = false;
  attribution = lines(unfiltered);
  EXPECT_EQ(attribution.at(1), formatSha);
}

// The ignore-revs file's contents are part of the cache key: editing it must
// not leave the old attribution in place.
TEST_F(IgnoreRevsTest, EditingTheIgnoreRevsFileMissesTheCache) {
  fixture.writeFile(".git-blame-ignore-revs", formatSha + "\n");
  bool fromCache = true;
  EXPECT_NE(lines({.path = "code.txt"}, &fromCache).at(1), formatSha);
  EXPECT_FALSE(fromCache);

  fixture.writeFile(".git-blame-ignore-revs", "");
  EXPECT_EQ(lines({.path = "code.txt"}, &fromCache).at(1), formatSha);
  EXPECT_FALSE(fromCache);
}

TEST_F(IgnoreRevsTest, IgnoreWhitespaceLooksThroughWhitespaceOnlyChanges) {
  BlameRequest request{.path = "code.txt"};
  request.options.ignoreRevs = false;
  EXPECT_EQ(lines(request).at(1), formatSha);
  request.options.ignoreWhitespace = true;
  const auto attribution = lines(request);
  EXPECT_EQ(attribution.at(1), revSha(fixture, "HEAD~2"));
  EXPECT_EQ(attribution.at(2), revSha(fixture, "HEAD~1"));
}

// Lines long enough for git's move detection (20 alphanumerics or more).
constexpr const char* kBlockA =
    "block a line one with plenty of characters\n"
    "block a line two with plenty of characters\n"
    "block a line three with plenty of characters\n";
constexpr const char* kBlockB =
    "block b line one with plenty of characters\n"
    "block b line two with plenty of characters\n"
    "block b line three with plenty of characters\n";

TEST_F(BlameServiceTest, MoveDetectionWithinFileFollowsMovedLines) {
  fixture.writeFile("moves.txt", std::string("head\n") + kBlockA + "middle\n" + kBlockB);
  fixture.run("git add moves.txt");
  fixture.commit("write blocks");
  const std::string writeSha = revSha(fixture, "HEAD");
  fixture.writeFile("moves.txt", std::string("head\n") + kBlockB + "middle\n" + kBlockA);
  fixture.run("git add moves.txt");
  fixture.commit("swap blocks");
  const std::string swapSha = revSha(fixture, "HEAD");

  std::vector<exec::BlameHunk> plain;
  ASSERT_TRUE(blame({.path = "moves.txt"}, &plain).ok());
  bool swapOwnsALine = false;
  for (const auto& [line, sha] : linesOf(plain)) swapOwnsALine |= sha == swapSha;
  EXPECT_TRUE(swapOwnsALine);

  BlameRequest request{.path = "moves.txt"};
  request.options.moves = MoveDetection::WithinFile;
  std::vector<exec::BlameHunk> moved;
  auto summary = blame(request, &moved);
  ASSERT_TRUE(summary.ok()) << summary.error().message;
  EXPECT_FALSE(summary.value().fromCache);
  // Every block line keeps its author; only the short "middle" line, too
  // short for git to recognise as moved, goes to the swap.
  const auto attribution = linesOf(moved);
  ASSERT_EQ(attribution.size(), 8u);
  for (const auto& [line, sha] : attribution) {
    if (line == 5) continue;
    EXPECT_EQ(sha, writeSha) << "line " << line;
  }
}

TEST_F(BlameServiceTest, MoveDetectionAcrossFilesFollowsLinesToTheirOriginalFile) {
  fixture.writeFile("from.txt", std::string("keep\n") + kBlockA);
  fixture.writeFile("to.txt", "target\n");
  fixture.run("git add from.txt to.txt");
  fixture.commit("write source");
  const std::string writeSha = revSha(fixture, "HEAD");
  fixture.writeFile("from.txt", "keep\n");
  fixture.writeFile("to.txt", std::string("target\n") + kBlockA);
  fixture.run("git add from.txt to.txt");
  fixture.commit("move block");

  BlameRequest request{.path = "to.txt"};
  request.options.moves = MoveDetection::AcrossFiles;
  std::vector<exec::BlameHunk> hunks;
  ASSERT_TRUE(blame(request, &hunks).ok());
  const auto attribution = linesOf(hunks);
  ASSERT_EQ(attribution.size(), 4u);
  for (std::uint32_t line = 2; line <= 4; ++line) EXPECT_EQ(attribution.at(line), writeSha);
  bool sawSourcePath = false;
  for (const auto& h : hunks) sawSourcePath |= h.path == "from.txt";
  EXPECT_TRUE(sawSourcePath);
}

TEST_F(BlameServiceTest, ReportsLfsTrackedPaths) {
  fixture.writeFile(".gitattributes", "*.csv filter=lfs diff=lfs merge=lfs -text\n");
  fixture.writeFile("data.csv",
                    "version https://git-lfs.github.com/spec/v1\n"
                    "oid sha256:0000000000000000000000000000000000000000000000000000000000000000\n"
                    "size 3820\n");
  fixture.run("git add .gitattributes data.csv");
  fixture.commit("track data with lfs");

  std::vector<exec::BlameHunk> hunks;
  auto lfs = blame({.path = "data.csv"}, &hunks);
  ASSERT_TRUE(lfs.ok()) << lfs.error().message;
  EXPECT_TRUE(lfs.value().lfs);
  // The flag holds for a cached answer too.
  auto again = blame({.path = "data.csv"}, &hunks);
  ASSERT_TRUE(again.ok());
  EXPECT_TRUE(again.value().fromCache);
  EXPECT_TRUE(again.value().lfs);

  auto plain = blame({.path = "code.txt"}, &hunks);
  ASSERT_TRUE(plain.ok());
  EXPECT_FALSE(plain.value().lfs);
}

// git prints a path with bytes outside ASCII in C-quoted form unless told
// otherwise; hunk paths must name the real file.
TEST_F(BlameServiceTest, NonAsciiPathsComeBackUnquoted) {
#ifdef _WIN32
  GTEST_SKIP() << "fixture commands pass non-ASCII names through the console code page";
#else
  fixture.writeFile("caf\xc3\xa9.txt", "un\ndeux\n");
  fixture.run("git add .");
  fixture.commit("add cafe");
  fixture.run("git mv caf\xc3\xa9.txt \"r\xc3\xa9sum\xc3\xa9 notes.txt\"");
  fixture.commit("rename");
  fixture.writeFile("r\xc3\xa9sum\xc3\xa9 notes.txt", "un\ndeux\ntrois\n");
  fixture.run("git add .");
  fixture.commit("append");

  std::vector<exec::BlameHunk> hunks;
  auto summary = blame({.path = "r\xc3\xa9sum\xc3\xa9 notes.txt"}, &hunks);
  ASSERT_TRUE(summary.ok()) << summary.error().message;
  std::set<std::string> paths;
  for (const auto& h : hunks) {
    paths.insert(h.path);
    if (h.previousPath) paths.insert(*h.previousPath);
  }
  EXPECT_EQ(paths, (std::set<std::string>{"caf\xc3\xa9.txt", "r\xc3\xa9sum\xc3\xa9 notes.txt"}));
#endif
}

}  // namespace
}  // namespace gg::services
