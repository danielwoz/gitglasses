// End-to-end tests for commit/details, driven through the full server loop
// against real repositories built with the git CLI.

#include <gtest/gtest.h>
#include <nlohmann/json.hpp>

#include <cstdint>
#include <filesystem>
#include <string>
#include <utility>

#include "services/commit/commit_methods.h"
#include "test_fixtures.h"
#include "test_session.h"

namespace gg {
namespace {

using Json = nlohmann::json;
using gg::testing::FixtureRepo;
using gg::testing::initRequest;
using gg::testing::InteractiveSession;

constexpr const char* kDate = "@1700000000 +0000";

Json req(std::int64_t id, const std::string& method, Json params) {
  return {{"jsonrpc", "2.0"}, {"id", id}, {"method", method}, {"params", std::move(params)}};
}

std::string rev(const FixtureRepo& fixture, const std::string& spec) {
  std::string sha = gg::testing::gitCapture(fixture.root(), "rev-parse " + spec);
  while (!sha.empty() && (sha.back() == '\n' || sha.back() == '\r')) sha.pop_back();
  return sha;
}

// Commits the index with `message` read from a file, so it can hold blank
// lines, angle brackets and quotes.
void commitMessage(FixtureRepo& fixture, const std::string& message) {
  fixture.writeFile(".git/GG_TEST_MSG", message);
  fixture.runAt(kDate, "git commit -q --allow-empty -F .git/GG_TEST_MSG");
}

std::string discoverRepo(InteractiveSession& session, const std::filesystem::path& root) {
  session.request(initRequest(1));
  Json discover = session.request(req(2, "repo/discover", {{"path", root.string()}}));
  return discover["result"]["repoId"];
}

Json details(InteractiveSession& session, std::int64_t id, const std::string& repoId,
             const std::string& sha) {
  Json response = session.request(req(id, "commit/details", {{"repoId", repoId}, {"sha", sha}}));
  EXPECT_TRUE(response.contains("result")) << sha << ": " << response.dump();
  return response.value("result", Json::object());
}

TEST(CommitService, NormalCommitWithBodyAndTrailers) {
  FixtureRepo fixture;
  const std::string parent = rev(fixture, "HEAD");
  fixture.writeFile("README.md", "fixture\nsecond\nthird\n");
  fixture.writeFile("src/parser.txt", "a\nb\n");
  fixture.run("git add README.md src/parser.txt");
  commitMessage(fixture,
                "Add the frame parser\n"
                "\n"
                "The parser reads frames\n"
                "and validates them.\n"
                "\n"
                "Signed-off-by: Fixture <fixture@example.invalid>\n"
                "Reviewed-by: Someone Else <else@example.invalid>\n");
  const std::string sha = rev(fixture, "HEAD");

  InteractiveSession session;
  const std::string repoId = discoverRepo(session, fixture.root());
  Json result = details(session, 10, repoId, sha);

  EXPECT_EQ(result["sha"], sha);
  EXPECT_EQ(result["parents"], Json::array({parent}));
  EXPECT_EQ(
      result["author"],
      Json({{"name", "Fixture"}, {"email", "fixture@example.invalid"}, {"time", 1700000000}}));
  EXPECT_EQ(result["committer"], result["author"]);
  EXPECT_EQ(result["subject"], "Add the frame parser");
  EXPECT_EQ(result["body"],
            "The parser reads frames\n"
            "and validates them.\n"
            "\n"
            "Signed-off-by: Fixture <fixture@example.invalid>\n"
            "Reviewed-by: Someone Else <else@example.invalid>");
  EXPECT_EQ(
      result["trailers"],
      Json::array({{{"key", "Signed-off-by"}, {"value", "Fixture <fixture@example.invalid>"}},
                   {{"key", "Reviewed-by"}, {"value", "Someone Else <else@example.invalid>"}}}));
  EXPECT_EQ(result["refs"], Json::array({{{"name", "HEAD"}, {"kind", "head"}},
                                         {{"name", "main"}, {"kind", "branch"}}}));
  EXPECT_EQ(result["files"], Json::array({{{"path", "README.md"},
                                           {"status", "M"},
                                           {"additions", 2},
                                           {"deletions", 0},
                                           {"binary", false}},
                                          {{"path", "src/parser.txt"},
                                           {"status", "A"},
                                           {"additions", 2},
                                           {"deletions", 0},
                                           {"binary", false}}}));
  EXPECT_EQ(result["stats"], Json({{"files", 2}, {"additions", 4}, {"deletions", 0}}));
  EXPECT_EQ(result["truncated"], false);
}

TEST(CommitService, SubjectFoldsAMultiLineFirstParagraph) {
  FixtureRepo fixture;
  commitMessage(fixture, "first line\nsecond line\n\nthe body\n");

  InteractiveSession session;
  const std::string repoId = discoverRepo(session, fixture.root());
  Json result = details(session, 10, repoId, "HEAD");

  EXPECT_EQ(result["subject"], "first line second line");
  EXPECT_EQ(result["body"], "the body");
  EXPECT_EQ(result["trailers"], Json::array());
  // An empty commit changes nothing.
  EXPECT_EQ(result["files"], Json::array());
  EXPECT_EQ(result["stats"], Json({{"files", 0}, {"additions", 0}, {"deletions", 0}}));
}

TEST(CommitService, MergeCommitDiffsAgainstFirstParent) {
  FixtureRepo fixture;
  fixture.run("git checkout -q -b feature");
  fixture.writeFile("feature.txt", "one\ntwo\nthree\n");
  fixture.run("git add feature.txt");
  fixture.runAt(kDate, "git commit -q -m \"feature work\"");
  const std::string featureTip = rev(fixture, "HEAD");
  fixture.run("git checkout -q main");
  fixture.writeFile("main.txt", "main\n");
  fixture.run("git add main.txt");
  fixture.runAt(kDate, "git commit -q -m \"main work\"");
  const std::string mainTip = rev(fixture, "HEAD");
  fixture.runAt(kDate, "git merge -q --no-ff -m \"merge feature\" feature");
  const std::string merge = rev(fixture, "HEAD");

  InteractiveSession session;
  const std::string repoId = discoverRepo(session, fixture.root());
  Json result = details(session, 10, repoId, merge);

  EXPECT_EQ(result["parents"], Json::array({mainTip, featureTip}));
  EXPECT_EQ(result["subject"], "merge feature");
  // Only what the merge brought in relative to main: feature.txt.
  EXPECT_EQ(result["files"], Json::array({{{"path", "feature.txt"},
                                           {"status", "A"},
                                           {"additions", 3},
                                           {"deletions", 0},
                                           {"binary", false}}}));
  EXPECT_EQ(result["stats"], Json({{"files", 1}, {"additions", 3}, {"deletions", 0}}));
}

TEST(CommitService, RootCommitDiffsAgainstTheEmptyTree) {
  FixtureRepo fixture;
  const std::string root = rev(fixture, "HEAD");

  InteractiveSession session;
  const std::string repoId = discoverRepo(session, fixture.root());
  Json result = details(session, 10, repoId, root);

  EXPECT_EQ(result["parents"], Json::array());
  EXPECT_EQ(result["subject"], "initial commit");
  EXPECT_EQ(result["body"], "");
  EXPECT_EQ(result["files"], Json::array({{{"path", "README.md"},
                                           {"status", "A"},
                                           {"additions", 1},
                                           {"deletions", 0},
                                           {"binary", false}}}));
  EXPECT_EQ(result["stats"], Json({{"files", 1}, {"additions", 1}, {"deletions", 0}}));
}

TEST(CommitService, RenameIsPairedWithItsSource) {
  FixtureRepo fixture;
  std::string contents;
  for (int i = 1; i <= 20; ++i) contents += "line " + std::to_string(i) + "\n";
  fixture.writeFile("old/name.txt", contents);
  fixture.run("git add old/name.txt");
  fixture.commit("add name");
  // A small edit alongside the move keeps it above the similarity threshold.
  contents.replace(contents.find("line 20\n"), 8, "line twenty\n");
  fixture.writeFile("new/name.txt", contents);
  fixture.run("git rm -q old/name.txt");
  fixture.run("git add new/name.txt");
  fixture.commit("move name");

  InteractiveSession session;
  const std::string repoId = discoverRepo(session, fixture.root());
  Json result = details(session, 10, repoId, "HEAD");

  EXPECT_EQ(result["files"], Json::array({{{"path", "new/name.txt"},
                                           {"origPath", "old/name.txt"},
                                           {"status", "R"},
                                           {"additions", 1},
                                           {"deletions", 1},
                                           {"binary", false}}}));
  EXPECT_EQ(result["stats"], Json({{"files", 1}, {"additions", 1}, {"deletions", 1}}));
}

TEST(CommitService, BinaryFilesAreFlaggedWithoutLineCounts) {
  FixtureRepo fixture;
  fixture.writeFile("blob.bin", std::string("\x00\x01\x02\x03\xff\xfe\x00payload", 14));
  fixture.writeFile("notes.txt", "text\n");
  fixture.run("git add blob.bin notes.txt");
  fixture.commit("add binary");
  fixture.writeFile("blob.bin", std::string("\x00\x01\x99\x03\xff\xfe\x00payload", 14));
  fixture.run("git add blob.bin");
  fixture.commit("change binary");

  InteractiveSession session;
  const std::string repoId = discoverRepo(session, fixture.root());

  Json added = details(session, 10, repoId, "HEAD~1");
  EXPECT_EQ(added["files"], Json::array({{{"path", "blob.bin"},
                                          {"status", "A"},
                                          {"additions", 0},
                                          {"deletions", 0},
                                          {"binary", true}},
                                         {{"path", "notes.txt"},
                                          {"status", "A"},
                                          {"additions", 1},
                                          {"deletions", 0},
                                          {"binary", false}}}));
  EXPECT_EQ(added["stats"], Json({{"files", 2}, {"additions", 1}, {"deletions", 0}}));

  Json changed = details(session, 11, repoId, "HEAD");
  EXPECT_EQ(changed["files"], Json::array({{{"path", "blob.bin"},
                                            {"status", "M"},
                                            {"additions", 0},
                                            {"deletions", 0},
                                            {"binary", true}}}));
}

TEST(CommitService, ListsTheRefsPointingAtTheCommit) {
  FixtureRepo fixture;
  fixture.writeFile("a.txt", "a\n");
  fixture.run("git add a.txt");
  fixture.commit("tagged");
  const std::string tagged = rev(fixture, "HEAD");
  fixture.run("git tag v1.0");
  fixture.runAt(kDate, "git tag -a v1.1 -m \"annotated\"");
  fixture.run("git branch feature");
  fixture.run("git branch alpha");
  fixture.run("git update-ref refs/remotes/origin/main HEAD");
  fixture.run("git symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/main");
  fixture.writeFile("b.txt", "b\n");
  fixture.run("git add b.txt");
  fixture.commit("later");
  const std::string later = rev(fixture, "HEAD");

  InteractiveSession session;
  const std::string repoId = discoverRepo(session, fixture.root());

  // HEAD and main have moved on; the rest still point at `tagged`.
  Json result = details(session, 10, repoId, tagged);
  EXPECT_EQ(result["refs"], Json::array({{{"name", "alpha"}, {"kind", "branch"}},
                                         {{"name", "feature"}, {"kind", "branch"}},
                                         {{"name", "origin/main"}, {"kind", "remote"}},
                                         {{"name", "v1.0"}, {"kind", "tag"}},
                                         {{"name", "v1.1"}, {"kind", "tag"}}}));

  Json head = details(session, 11, repoId, later);
  EXPECT_EQ(head["refs"], Json::array({{{"name", "HEAD"}, {"kind", "head"}},
                                       {{"name", "main"}, {"kind", "branch"}}}));

  // A detached HEAD is reported as HEAD alone.
  fixture.run("git checkout -q --detach " + tagged);
  Json detached = details(session, 12, repoId, tagged);
  ASSERT_FALSE(detached["refs"].empty());
  EXPECT_EQ(detached["refs"][0], Json({{"name", "HEAD"}, {"kind", "head"}}));
  EXPECT_EQ(detached["refs"].size(), 6u);
}

TEST(CommitService, AcceptsAnyRevisionNamingACommit) {
  FixtureRepo fixture;
  fixture.run("git branch feature");
  fixture.run("git tag v1.0");
  fixture.runAt(kDate, "git tag -a v1.1 -m \"annotated\"");
  const std::string sha = rev(fixture, "HEAD");

  InteractiveSession session;
  const std::string repoId = discoverRepo(session, fixture.root());
  std::int64_t id = 10;
  for (const std::string& spec :
       {sha, sha.substr(0, 7), std::string("HEAD"), std::string("main"), std::string("feature"),
        std::string("v1.0"), std::string("v1.1"), std::string("refs/heads/main")}) {
    EXPECT_EQ(details(session, id++, repoId, spec)["sha"], sha) << spec;
  }
}

TEST(CommitService, RejectsWhatDoesNotNameACommit) {
  FixtureRepo fixture;
  InteractiveSession session;
  const std::string repoId = discoverRepo(session, fixture.root());

  const auto code = [&](std::int64_t id, Json params) {
    Json response = session.request(req(id, "commit/details", std::move(params)));
    EXPECT_TRUE(response.contains("error")) << response.dump();
    return response["error"].value("code", 0);
  };

  constexpr int kInvalidParams = -32602;
  constexpr int kGitError = -32001;
  EXPECT_EQ(code(10, {{"repoId", repoId}, {"sha", "deadbeefdeadbeef"}}), kGitError);
  EXPECT_EQ(code(11, {{"repoId", repoId}, {"sha", std::string(40, 'a')}}), kGitError);
  EXPECT_EQ(code(12, {{"repoId", repoId}, {"sha", "no-such-branch"}}), kGitError);
  EXPECT_EQ(code(13, {{"repoId", repoId}, {"sha", "HEAD^{tree}"}}), kGitError);
  EXPECT_EQ(code(14, {{"repoId", repoId}, {"sha", "--output=/tmp/x"}}), kInvalidParams);
  EXPECT_EQ(code(15, {{"repoId", repoId}, {"sha", ""}}), kInvalidParams);
  EXPECT_EQ(code(16, {{"repoId", repoId}}), kInvalidParams);
  EXPECT_EQ(code(17, {{"repoId", "no-such-repo"}, {"sha", "HEAD"}}), -32000);
}

TEST(CommitService, CapsTheFileListAndReportsTruncation) {
  FixtureRepo fixture;
  const std::size_t count = services::kMaxCommitDetailFiles + 5;
  for (std::size_t i = 0; i < count; ++i) {
    fixture.writeFile("many/f" + std::to_string(i) + ".txt", "x\n");
  }
  fixture.run("git add many");
  fixture.commit("many files");

  InteractiveSession session;
  const std::string repoId = discoverRepo(session, fixture.root());
  Json result = details(session, 10, repoId, "HEAD");

  EXPECT_EQ(result["truncated"], true);
  EXPECT_EQ(result["files"].size(), services::kMaxCommitDetailFiles);
  EXPECT_EQ(result["stats"]["files"], count);
  // Line counts cover the listed files.
  EXPECT_EQ(result["stats"]["additions"], services::kMaxCommitDetailFiles);
}

}  // namespace
}  // namespace gg
