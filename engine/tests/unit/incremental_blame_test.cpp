#include "exec/parsers/incremental_blame.h"

#include <gtest/gtest.h>

#include <sstream>
#include <vector>

namespace gg::exec {
namespace {

std::pair<std::vector<BlameHunk>, std::map<std::string, BlameCommit>> parse(
    const std::string& output) {
  std::vector<BlameHunk> hunks;
  IncrementalBlameParser parser([&](const BlameHunk& h) { hunks.push_back(h); });
  std::istringstream stream(output);
  std::string line;
  while (std::getline(stream, line)) parser.feedLine(line);
  parser.finish();
  return {hunks, parser.commits()};
}

constexpr const char* kSha1 = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
constexpr const char* kSha2 = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

TEST(IncrementalBlameParser, ParsesSingleHunkWithMetadata) {
  auto [hunks, commits] = parse(std::string(kSha1) +
                                " 1 1 3\n"
                                "author Ada Lovelace\n"
                                "author-mail <ada@example.com>\n"
                                "author-time 1721623000\n"
                                "author-tz +0200\n"
                                "committer Charles Babbage\n"
                                "committer-mail <cb@example.com>\n"
                                "committer-time 1721624000\n"
                                "committer-tz +0000\n"
                                "summary add analytical engine\n"
                                "filename engine.cpp\n");

  ASSERT_EQ(hunks.size(), 1u);
  EXPECT_EQ(hunks[0].sha, kSha1);
  EXPECT_EQ(hunks[0].originalLine, 1u);
  EXPECT_EQ(hunks[0].resultLine, 1u);
  EXPECT_EQ(hunks[0].lineCount, 3u);
  EXPECT_EQ(hunks[0].path, "engine.cpp");

  const BlameCommit& commit = commits.at(kSha1);
  EXPECT_EQ(commit.author.name, "Ada Lovelace");
  EXPECT_EQ(commit.author.email, "ada@example.com");
  EXPECT_EQ(commit.author.time, 1721623000);
  EXPECT_EQ(commit.author.timezone, "+0200");
  EXPECT_EQ(commit.committer.name, "Charles Babbage");
  EXPECT_EQ(commit.summary, "add analytical engine");
  EXPECT_FALSE(commit.boundary);
}

TEST(IncrementalBlameParser, MetadataOnlyAppearsOncePerCommit) {
  auto [hunks, commits] = parse(std::string(kSha1) +
                                " 1 1 2\n"
                                "author First\n"
                                "author-mail <f@e.c>\n"
                                "summary one\n"
                                "filename f.txt\n" +
                                kSha2 +
                                " 5 3 1\n"
                                "author Second\n"
                                "author-mail <s@e.c>\n"
                                "summary two\n"
                                "filename f.txt\n" +
                                // second mention of kSha1: bare header + filename only
                                kSha1 +
                                " 9 4 1\n"
                                "filename f.txt\n");

  ASSERT_EQ(hunks.size(), 3u);
  EXPECT_EQ(hunks[2].sha, kSha1);
  EXPECT_EQ(hunks[2].resultLine, 4u);
  EXPECT_EQ(commits.size(), 2u);
  EXPECT_EQ(commits.at(kSha1).author.name, "First");
}

TEST(IncrementalBlameParser, ParsesPreviousAndBoundary) {
  auto [hunks, commits] = parse(std::string(kSha1) +
                                " 1 1 1\n"
                                "author A\n"
                                "boundary\n"
                                "previous " +
                                kSha2 +
                                " old/name.txt\n"
                                "filename new/name.txt\n");

  ASSERT_EQ(hunks.size(), 1u);
  EXPECT_TRUE(commits.at(kSha1).boundary);
  ASSERT_TRUE(hunks[0].previousSha.has_value());
  EXPECT_EQ(*hunks[0].previousSha, kSha2);
  EXPECT_EQ(*hunks[0].previousPath, "old/name.txt");
  EXPECT_EQ(hunks[0].path, "new/name.txt");
}

TEST(IncrementalBlameParser, HandlesFilenamesWithSpaces) {
  auto [hunks, commits] = parse(std::string(kSha1) +
                                " 1 1 1\n"
                                "author A\n"
                                "filename dir with spaces/my file.txt\n");
  ASSERT_EQ(hunks.size(), 1u);
  EXPECT_EQ(hunks[0].path, "dir with spaces/my file.txt");
}

TEST(IncrementalBlameParser, IgnoresGarbageBeforeFirstHeader) {
  auto [hunks, commits] = parse("warning: something\n" + std::string(kSha1) +
                                " 1 1 1\n"
                                "author A\n"
                                "filename f\n");
  ASSERT_EQ(hunks.size(), 1u);
}

TEST(IncrementalBlameParser, UncommittedShaIsStable) {
  auto [hunks, commits] = parse(std::string(kUncommittedSha) +
                                " 1 1 2\n"
                                "author Not Committed Yet\n"
                                "filename f.txt\n");
  ASSERT_EQ(hunks.size(), 1u);
  EXPECT_EQ(hunks[0].sha, kUncommittedSha);
}

}  // namespace
}  // namespace gg::exec
