#include "exec/parsers/history_log.h"

#include <gtest/gtest.h>

#include <string>
#include <vector>

namespace gg::exec {
namespace {

std::vector<HistoryEntry> parse(HistoryLogParser::Stats stats, const std::string& defaultPath,
                                const std::vector<std::string>& lines) {
  std::vector<HistoryEntry> entries;
  HistoryLogParser parser(stats, defaultPath,
                          [&entries](const HistoryEntry& e) { entries.push_back(e); });
  for (const auto& line : lines) parser.feedLine(line);
  parser.finish();
  return entries;
}

std::string record(const std::string& sha, const std::string& name, const std::string& email,
                   const std::string& time, const std::string& summary) {
  return "\x1e" + sha + "\x1f" + name + "\x1f" + email + "\x1f" + time + "\x1f" + summary;
}

const std::string kShaA(40, 'a');
const std::string kShaB(40, 'b');

TEST(HistoryLogParser, ParsesRecordsWithNumstat) {
  auto entries = parse(HistoryLogParser::Stats::Numstat, "file.txt",
                       {
                           record(kShaA, "Ada Lovelace", "ada@example.com", "1700000060",
                                  "add feature: with punctuation"),
                           "",
                           "3\t1\tfile.txt",
                           record(kShaB, "Bob", "bob@example.com", "1700000000", "initial"),
                           "",
                           "5\t0\tfile.txt",
                       });
  ASSERT_EQ(entries.size(), 2u);
  EXPECT_EQ(entries[0].sha, kShaA);
  EXPECT_EQ(entries[0].author.name, "Ada Lovelace");
  EXPECT_EQ(entries[0].author.email, "ada@example.com");
  EXPECT_EQ(entries[0].author.time, 1700000060);
  EXPECT_EQ(entries[0].summary, "add feature: with punctuation");
  EXPECT_EQ(entries[0].path, "file.txt");
  EXPECT_EQ(entries[0].additions, 3u);
  EXPECT_EQ(entries[0].deletions, 1u);
  EXPECT_EQ(entries[1].additions, 5u);
  EXPECT_EQ(entries[1].deletions, 0u);
}

TEST(HistoryLogParser, RecordWithoutNumstatKeepsDefaultPathAndZeroCounts) {
  auto entries = parse(HistoryLogParser::Stats::Numstat, "fallback.txt",
                       {record(kShaA, "A", "a@x", "1", "merge-ish record"), ""});
  ASSERT_EQ(entries.size(), 1u);
  EXPECT_EQ(entries[0].path, "fallback.txt");
  EXPECT_EQ(entries[0].additions, 0u);
  EXPECT_EQ(entries[0].deletions, 0u);
}

TEST(HistoryLogParser, ParsesFullFormRename) {
  auto entries = parse(HistoryLogParser::Stats::Numstat, "d",
                       {record(kShaA, "A", "a@x", "1", "rename"), "",
                        "0\t0\toriginal.txt => renamed-once.txt"});
  ASSERT_EQ(entries.size(), 1u);
  EXPECT_EQ(entries[0].path, "renamed-once.txt");
}

TEST(HistoryLogParser, ParsesBraceFormRenames) {
  EXPECT_EQ(numstatCurrentPath("dir/{old.txt => new.txt}"), "dir/new.txt");
  EXPECT_EQ(numstatCurrentPath("pre{old => new}post.txt"), "prenewpost.txt");
  EXPECT_EQ(numstatCurrentPath("src/{ => sub}/file.c"), "src/sub/file.c");
  EXPECT_EQ(numstatCurrentPath("{a => b}/deep/file.c"), "b/deep/file.c");
  EXPECT_EQ(numstatCurrentPath("old.txt => nested/renamed.txt"), "nested/renamed.txt");
  EXPECT_EQ(numstatCurrentPath("plain.txt"), "plain.txt");
  // A brace without rename syntax is a literal file name.
  EXPECT_EQ(numstatCurrentPath("we{ird}.txt"), "we{ird}.txt");
  EXPECT_EQ(numstatCurrentPath("path with spaces.txt"), "path with spaces.txt");
}

TEST(HistoryLogParser, BinaryNumstatCountsAsZero) {
  auto entries = parse(HistoryLogParser::Stats::Numstat, "d",
                       {record(kShaA, "A", "a@x", "1", "binary"), "", "-\t-\timage.png"});
  ASSERT_EQ(entries.size(), 1u);
  EXPECT_EQ(entries[0].path, "image.png");
  EXPECT_EQ(entries[0].additions, 0u);
  EXPECT_EQ(entries[0].deletions, 0u);
}

TEST(HistoryLogParser, OnlyFirstNumstatLineIsUsed) {
  auto entries = parse(HistoryLogParser::Stats::Numstat, "d",
                       {record(kShaA, "A", "a@x", "1", "touches file"), "", "2\t1\tfirst.txt",
                        "9\t9\tsecond.txt"});
  ASSERT_EQ(entries.size(), 1u);
  EXPECT_EQ(entries[0].path, "first.txt");
  EXPECT_EQ(entries[0].additions, 2u);
}

TEST(HistoryLogParser, LineModeSkipsPatchOutput) {
  // -L output interleaves diff text with the records; lines that look like
  // numstat (removed lines starting with '-', context lines with tabs) must
  // never be mistaken for stats.
  auto entries = parse(HistoryLogParser::Stats::None, "file.txt",
                       {
                           record(kShaA, "A", "a@x", "5", "edit line"),
                           "",
                           "diff --git a/file.txt b/file.txt",
                           "--- a/file.txt",
                           "+++ b/file.txt",
                           "@@ -1,3 +1,3 @@",
                           "-\t-\tdeceptive removed line",
                           "+3\t1\tdeceptive added line",
                           " context",
                           record(kShaB, "B", "b@x", "3", "older edit"),
                           "",
                           "@@ -1,2 +1,2 @@",
                       });
  ASSERT_EQ(entries.size(), 2u);
  EXPECT_EQ(entries[0].sha, kShaA);
  EXPECT_EQ(entries[0].path, "file.txt");
  EXPECT_EQ(entries[0].additions, 0u);
  EXPECT_EQ(entries[0].deletions, 0u);
  EXPECT_EQ(entries[1].sha, kShaB);
  EXPECT_EQ(entries[1].summary, "older edit");
}

TEST(HistoryLogParser, MalformedRecordIsDropped) {
  auto entries = parse(HistoryLogParser::Stats::Numstat, "d",
                       {"\x1e" + kShaA + "\x1fonly-two-fields",
                        record(kShaB, "B", "b@x", "2", "good"), "", "1\t0\tf.txt"});
  ASSERT_EQ(entries.size(), 1u);
  EXPECT_EQ(entries[0].sha, kShaB);
}

TEST(HistoryLogParser, FinishEmitsTrailingRecord) {
  std::vector<HistoryEntry> entries;
  HistoryLogParser parser(HistoryLogParser::Stats::Numstat, "d",
                          [&entries](const HistoryEntry& e) { entries.push_back(e); });
  parser.feedLine(record(kShaA, "A", "a@x", "1", "last"));
  EXPECT_TRUE(entries.empty());  // not emitted until terminated
  parser.finish();
  ASSERT_EQ(entries.size(), 1u);
  EXPECT_EQ(entries[0].summary, "last");
}

}  // namespace
}  // namespace gg::exec
