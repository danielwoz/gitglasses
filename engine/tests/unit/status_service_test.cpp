// End-to-end tests for status/summary, diff/commit, diff/refs,
// diff/fileHunks, stage/files and stage/hunks, driven through the full server
// loop. Git's own porcelain output is the parity oracle for staging results.

#include <gtest/gtest.h>
#include <nlohmann/json.hpp>

#include <cstdio>
#include <filesystem>
#include <string>
#include <vector>

#include "test_fixtures.h"
#include "test_session.h"

namespace gg {
namespace {

using Json = nlohmann::json;
using gg::testing::FixtureRepo;
using gg::testing::initRequest;
using gg::testing::InteractiveSession;

Json req(std::int64_t id, const std::string& method, Json params) {
  return {{"jsonrpc", "2.0"}, {"id", id}, {"method", method}, {"params", std::move(params)}};
}

std::string gitOut(const std::filesystem::path& root, const std::string& args) {
  return gg::testing::gitCapture(root, args);
}

std::string rev(const FixtureRepo& fixture, const std::string& spec) {
  std::string sha = gitOut(fixture.root(), "rev-parse " + spec);
  while (!sha.empty() && sha.back() == '\n') sha.pop_back();
  return sha;
}

void commitTick(FixtureRepo& fixture, const std::string& message, int tick) {
  const std::string date = "@" + std::to_string(1700000000 + 60 * tick) + " +0000";
  fixture.commitAt(date, message);
}

std::string discoverRepo(InteractiveSession& session, const std::filesystem::path& root) {
  session.request(initRequest(1));
  Json discover = session.request(req(2, "repo/discover", {{"path", root.string()}}));
  return discover["result"]["repoId"];
}

Json statusSummary(InteractiveSession& session, std::int64_t id, const std::string& repoId) {
  Json response = session.request(req(id, "status/summary", {{"repoId", repoId}}));
  EXPECT_TRUE(response.contains("result")) << response.dump();
  return response["result"];
}

// Finds the FileChange for `path`, failing the test when absent.
Json changeFor(const Json& changes, const std::string& path) {
  for (const auto& change : changes) {
    if (change["path"] == path) return change;
  }
  ADD_FAILURE() << "no change for " << path << " in " << changes.dump();
  return {};
}

bool hasPath(const Json& changes, const std::string& path) {
  for (const auto& change : changes) {
    if (change["path"] == path) return true;
  }
  return false;
}

TEST(StatusService, SummarySplitsStagedUnstagedUntracked) {
  FixtureRepo fixture;
  fixture.writeFile("a.txt", "one\n");
  fixture.writeFile("b.txt", "one\n");
  fixture.writeFile("d.txt", "one\n");
  fixture.writeFile("e.txt", "stable content that survives the rename\n");
  fixture.run("git add a.txt b.txt d.txt e.txt");
  commitTick(fixture, "seed", 1);

  fixture.writeFile("a.txt", "one\ntwo\n");
  fixture.run("git add a.txt");                  // staged M
  fixture.writeFile("b.txt", "one\nchanged\n");  // unstaged M
  fixture.writeFile("c.txt", "new\n");
  fixture.run("git add c.txt");        // staged A
  fixture.run("git rm -q d.txt");      // staged D
  fixture.run("git mv e.txt e2.txt");  // staged R
  fixture.writeFile("untracked.txt", "loose\n");

  InteractiveSession session;
  const std::string repoId = discoverRepo(session, fixture.root());
  Json summary = statusSummary(session, 10, repoId);

  EXPECT_EQ(summary["branch"], "main");
  EXPECT_FALSE(summary.contains("upstream"));
  EXPECT_EQ(summary["ahead"], 0);
  EXPECT_EQ(summary["behind"], 0);

  ASSERT_EQ(summary["staged"].size(), 4u) << summary["staged"].dump();
  EXPECT_EQ(changeFor(summary["staged"], "a.txt")["status"], "M");
  EXPECT_EQ(changeFor(summary["staged"], "c.txt")["status"], "A");
  EXPECT_EQ(changeFor(summary["staged"], "d.txt")["status"], "D");
  const Json renamed = changeFor(summary["staged"], "e2.txt");
  EXPECT_EQ(renamed["status"], "R");
  EXPECT_EQ(renamed["origPath"], "e.txt");
  // Line stats are intentionally 0 in status (the UI uses diff/* for counts).
  EXPECT_EQ(changeFor(summary["staged"], "a.txt")["additions"], 0);

  ASSERT_EQ(summary["unstaged"].size(), 1u) << summary["unstaged"].dump();
  EXPECT_EQ(changeFor(summary["unstaged"], "b.txt")["status"], "M");
  EXPECT_EQ(summary["untracked"], Json::array({"untracked.txt"}));
  EXPECT_TRUE(summary["conflicted"].empty());
}

TEST(StatusService, SummaryReportsConflicts) {
  FixtureRepo fixture;
  fixture.writeFile("c.txt", "base\n");
  fixture.run("git add c.txt");
  commitTick(fixture, "base", 1);
  fixture.run("git checkout -q -b left");
  fixture.writeFile("c.txt", "left\n");
  fixture.run("git add c.txt");
  commitTick(fixture, "left", 2);
  fixture.run("git checkout -q main");
  fixture.writeFile("c.txt", "right\n");
  fixture.run("git add c.txt");
  commitTick(fixture, "right", 3);
  fixture.tryRun("git merge left");  // conflicts, exit != 0

  InteractiveSession session;
  const std::string repoId = discoverRepo(session, fixture.root());
  Json summary = statusSummary(session, 10, repoId);

  EXPECT_EQ(summary["branch"], "main");
  EXPECT_EQ(summary["conflicted"], Json::array({"c.txt"}));
  EXPECT_FALSE(hasPath(summary["staged"], "c.txt"));
  EXPECT_FALSE(hasPath(summary["unstaged"], "c.txt"));
}

TEST(StatusService, SummaryAheadBehindAgainstClonedUpstream) {
  FixtureRepo fixture;
  commitTick(fixture, "c1", 1);
  commitTick(fixture, "c2", 2);
  fixture.run("git clone --bare -q . upstream.git");
  fixture.run("git remote add origin upstream.git");
  fixture.run("git fetch -q origin");
  fixture.run("git branch -q --set-upstream-to=origin/main main");
  fixture.run("git reset -q --hard HEAD~1");  // behind 1
  commitTick(fixture, "c3", 3);               // ahead 1

  InteractiveSession session;
  const std::string repoId = discoverRepo(session, fixture.root());
  Json summary = statusSummary(session, 10, repoId);

  EXPECT_EQ(summary["branch"], "main");
  EXPECT_EQ(summary["upstream"], "origin/main");
  EXPECT_EQ(summary["ahead"], 1);
  EXPECT_EQ(summary["behind"], 1);
}

TEST(StatusService, SummaryUnbornHead) {
  struct UnbornRepo {
    std::filesystem::path root;
    UnbornRepo() {
      root = std::filesystem::temp_directory_path() /
             ("gg-status-unborn-" +
              std::to_string(::testing::UnitTest::GetInstance()->random_seed()));
      std::filesystem::create_directories(root);
      gg::testing::runGit(root, "git init -q -b main");
      std::ofstream(root / "loose.txt", std::ios::binary) << "hi\n";
    }
    ~UnbornRepo() {
      std::error_code ec;
      std::filesystem::remove_all(root, ec);
    }
  } unborn;

  InteractiveSession session;
  const std::string repoId = discoverRepo(session, unborn.root);
  Json summary = statusSummary(session, 10, repoId);

  EXPECT_EQ(summary["branch"], "");
  EXPECT_FALSE(summary.contains("upstream"));
  EXPECT_EQ(summary["ahead"], 0);
  EXPECT_EQ(summary["behind"], 0);
  EXPECT_TRUE(summary["staged"].empty());
  EXPECT_TRUE(summary["unstaged"].empty());
  EXPECT_EQ(summary["untracked"], Json::array({"loose.txt"}));
}

TEST(StatusService, DiffCommitRootModifyAndRename) {
  FixtureRepo fixture;
  const std::string rootSha = rev(fixture, "HEAD");
  fixture.writeFile("README.md", "fixture\nmore\n");
  fixture.run("git add README.md");
  commitTick(fixture, "extend readme", 1);
  const std::string modifySha = rev(fixture, "HEAD");
  fixture.run("git mv README.md RENAMED.md");
  commitTick(fixture, "rename readme", 2);
  const std::string renameSha = rev(fixture, "HEAD");

  InteractiveSession session;
  const std::string repoId = discoverRepo(session, fixture.root());

  // Root commit diffs against the empty tree.
  Json root = session.request(req(10, "diff/commit", {{"repoId", repoId}, {"sha", rootSha}}));
  ASSERT_EQ(root["result"]["files"].size(), 1u) << root.dump();
  EXPECT_EQ(root["result"]["files"][0],
            Json({{"path", "README.md"},
                  {"status", "A"},
                  {"additions", 1},
                  {"deletions", 0}}));

  Json modify =
      session.request(req(11, "diff/commit", {{"repoId", repoId}, {"sha", modifySha}}));
  EXPECT_EQ(modify["result"]["files"][0],
            Json({{"path", "README.md"},
                  {"status", "M"},
                  {"additions", 1},
                  {"deletions", 0}}));

  Json rename =
      session.request(req(12, "diff/commit", {{"repoId", repoId}, {"sha", renameSha}}));
  ASSERT_EQ(rename["result"]["files"].size(), 1u) << rename.dump();
  EXPECT_EQ(rename["result"]["files"][0],
            Json({{"path", "RENAMED.md"},
                  {"status", "R"},
                  {"origPath", "README.md"},
                  {"additions", 0},
                  {"deletions", 0}}));

  Json bad = session.request(req(13, "diff/commit", {{"repoId", repoId}, {"sha", "deadbeef"}}));
  EXPECT_EQ(bad["error"]["code"], -32001);
}

TEST(StatusService, DiffRefsBetweenBranches) {
  FixtureRepo fixture;
  commitTick(fixture, "base", 1);
  fixture.run("git checkout -q -b feature");
  fixture.writeFile("feature.txt", "one\ntwo\nthree\n");
  fixture.writeFile("README.md", "fixture\nfeature edit\n");
  fixture.run("git add feature.txt README.md");
  commitTick(fixture, "feature work", 2);
  fixture.run("git checkout -q main");

  InteractiveSession session;
  const std::string repoId = discoverRepo(session, fixture.root());

  Json diff = session.request(
      req(10, "diff/refs", {{"repoId", repoId}, {"base", "main"}, {"head", "feature"}}));
  const Json& files = diff["result"]["files"];
  ASSERT_EQ(files.size(), 2u) << diff.dump();
  EXPECT_EQ(changeFor(files, "README.md")["status"], "M");
  EXPECT_EQ(changeFor(files, "README.md")["additions"], 1);
  EXPECT_EQ(changeFor(files, "README.md")["deletions"], 0);
  EXPECT_EQ(changeFor(files, "feature.txt")["status"], "A");
  EXPECT_EQ(changeFor(files, "feature.txt")["additions"], 3);

  // Reversed direction flips add to delete.
  Json reversed = session.request(
      req(11, "diff/refs", {{"repoId", repoId}, {"base", "feature"}, {"head", "main"}}));
  EXPECT_EQ(changeFor(reversed["result"]["files"], "feature.txt")["status"], "D");
}

TEST(StatusService, DiffFileHunksUnstagedAndStaged) {
  FixtureRepo fixture;
  std::string contents;
  for (int i = 1; i <= 10; ++i) contents += "l" + std::to_string(i) + "\n";
  fixture.writeFile("h.txt", contents);
  fixture.run("git add h.txt");
  commitTick(fixture, "seed", 1);
  std::string edited = contents;
  edited.replace(edited.find("l5\n"), 3, "L5-changed\n");
  fixture.writeFile("h.txt", edited);

  InteractiveSession session;
  const std::string repoId = discoverRepo(session, fixture.root());

  Json unstaged = session.request(
      req(10, "diff/fileHunks", {{"repoId", repoId}, {"path", "h.txt"}, {"staged", false}}));
  const Json& hunks = unstaged["result"]["hunks"];
  ASSERT_EQ(hunks.size(), 1u) << unstaged.dump();
  // The header keeps git's function-context suffix (here the nearest
  // preceding line matching the default function pattern).
  EXPECT_EQ(hunks[0]["header"], "@@ -2,7 +2,7 @@ l1");
  EXPECT_EQ(hunks[0]["oldStart"], 2);
  EXPECT_EQ(hunks[0]["oldLines"], 7);
  EXPECT_EQ(hunks[0]["newStart"], 2);
  EXPECT_EQ(hunks[0]["newLines"], 7);
  EXPECT_EQ(hunks[0]["lines"],
            Json::array({" l2", " l3", " l4", "-l5", "+L5-changed", " l6", " l7", " l8"}));

  // Nothing staged yet.
  Json stagedEmpty = session.request(
      req(11, "diff/fileHunks", {{"repoId", repoId}, {"path", "h.txt"}, {"staged", true}}));
  EXPECT_TRUE(stagedEmpty["result"]["hunks"].empty());

  fixture.run("git add h.txt");
  Json staged = session.request(
      req(12, "diff/fileHunks", {{"repoId", repoId}, {"path", "h.txt"}, {"staged", true}}));
  ASSERT_EQ(staged["result"]["hunks"].size(), 1u);
  EXPECT_EQ(staged["result"]["hunks"][0]["lines"], hunks[0]["lines"]);
  Json unstagedEmpty = session.request(
      req(13, "diff/fileHunks", {{"repoId", repoId}, {"path", "h.txt"}, {"staged", false}}));
  EXPECT_TRUE(unstagedEmpty["result"]["hunks"].empty());
}

TEST(StatusService, DiffHandlesBinaryFiles) {
  FixtureRepo fixture;
  const std::string binary1("\x00\x01\x02\x03\xff\xfe\x00payload", 14);
  fixture.writeFile("blob.bin", binary1);
  fixture.run("git add blob.bin");
  commitTick(fixture, "add binary", 1);

  InteractiveSession session;
  const std::string repoId = discoverRepo(session, fixture.root());

  Json commit =
      session.request(req(10, "diff/commit", {{"repoId", repoId}, {"sha", rev(fixture, "HEAD")}}));
  ASSERT_EQ(commit["result"]["files"].size(), 1u);
  EXPECT_EQ(commit["result"]["files"][0]["path"], "blob.bin");
  EXPECT_EQ(commit["result"]["files"][0]["status"], "A");
  EXPECT_EQ(commit["result"]["files"][0]["additions"], 0);
  EXPECT_EQ(commit["result"]["files"][0]["deletions"], 0);

  const std::string binary2("\x00\x01\x99\x03\xff\xfe\x00payload", 14);
  fixture.writeFile("blob.bin", binary2);
  Json hunks = session.request(
      req(11, "diff/fileHunks", {{"repoId", repoId}, {"path", "blob.bin"}, {"staged", false}}));
  EXPECT_TRUE(hunks["result"]["hunks"].empty());
}

TEST(StatusService, StageFilesStageAndUnstage) {
  FixtureRepo fixture;
  fixture.writeFile("a.txt", "one\n");
  fixture.writeFile("d.txt", "doomed\n");
  fixture.run("git add a.txt d.txt");
  commitTick(fixture, "seed", 1);
  fixture.writeFile("a.txt", "one\ntwo\n");
  fixture.writeFile("n.txt", "brand new\n");
  std::filesystem::remove(fixture.root() / "d.txt");

  InteractiveSession session;
  const std::string repoId = discoverRepo(session, fixture.root());

  Json stage = session.request(req(10, "stage/files",
                                   {{"repoId", repoId},
                                    {"paths", {"a.txt", "n.txt", "d.txt"}},
                                    {"action", "stage"}}));
  ASSERT_TRUE(stage.contains("result")) << stage.dump();

  Json summary = statusSummary(session, 11, repoId);
  EXPECT_EQ(changeFor(summary["staged"], "a.txt")["status"], "M");
  EXPECT_EQ(changeFor(summary["staged"], "n.txt")["status"], "A");
  EXPECT_EQ(changeFor(summary["staged"], "d.txt")["status"], "D");
  EXPECT_TRUE(summary["unstaged"].empty());
  EXPECT_TRUE(summary["untracked"].empty());
  // Parity: git sees the same staged set.
  EXPECT_EQ(gitOut(fixture.root(), "diff --cached --name-status"),
            "M\ta.txt\nD\td.txt\nA\tn.txt\n");

  Json unstage = session.request(req(12, "stage/files",
                                     {{"repoId", repoId},
                                      {"paths", {"a.txt", "n.txt", "d.txt"}},
                                      {"action", "unstage"}}));
  ASSERT_TRUE(unstage.contains("result")) << unstage.dump();

  Json after = statusSummary(session, 13, repoId);
  EXPECT_TRUE(after["staged"].empty());
  EXPECT_EQ(changeFor(after["unstaged"], "a.txt")["status"], "M");
  EXPECT_EQ(changeFor(after["unstaged"], "d.txt")["status"], "D");
  EXPECT_EQ(after["untracked"], Json::array({"n.txt"}));

  Json badAction = session.request(
      req(14, "stage/files", {{"repoId", repoId}, {"paths", {"a.txt"}}, {"action", "toggle"}}));
  EXPECT_EQ(badAction["error"]["code"], -32602);
}

TEST(StatusService, StageHunksStagesOnlySelectedHunk) {
  FixtureRepo fixture;
  std::string contents;
  for (int i = 1; i <= 20; ++i) {
    contents += (i < 10 ? "line0" : "line") + std::to_string(i) + "\n";
  }
  fixture.writeFile("hunky.txt", contents);
  fixture.run("git add hunky.txt");
  commitTick(fixture, "seed", 1);
  std::string edited = contents;
  edited.replace(edited.find("line02\n"), 7, "line02 EDITED\n");
  edited.replace(edited.find("line18\n"), 7, "line18 EDITED\n");
  fixture.writeFile("hunky.txt", edited);

  InteractiveSession session;
  const std::string repoId = discoverRepo(session, fixture.root());

  Json unstaged = session.request(
      req(10, "diff/fileHunks", {{"repoId", repoId}, {"path", "hunky.txt"}, {"staged", false}}));
  const Json& hunks = unstaged["result"]["hunks"];
  ASSERT_EQ(hunks.size(), 2u) << unstaged.dump();

  Json firstRange = {{"oldStart", hunks[0]["oldStart"]},
                     {"oldLines", hunks[0]["oldLines"]},
                     {"newStart", hunks[0]["newStart"]},
                     {"newLines", hunks[0]["newLines"]}};
  Json stage = session.request(req(11, "stage/hunks",
                                   {{"repoId", repoId},
                                    {"path", "hunky.txt"},
                                    {"action", "stage"},
                                    {"hunks", Json::array({firstRange})}}));
  ASSERT_TRUE(stage.contains("result")) << stage.dump();

  // The file is now both staged (hunk 1) and unstaged (hunk 2).
  Json summary = statusSummary(session, 12, repoId);
  EXPECT_EQ(changeFor(summary["staged"], "hunky.txt")["status"], "M");
  EXPECT_EQ(changeFor(summary["unstaged"], "hunky.txt")["status"], "M");

  // Parity via the CLI: the index diff holds exactly hunk 1, the worktree
  // diff exactly hunk 2.
  const std::string cached = gitOut(fixture.root(), "diff --cached");
  EXPECT_NE(cached.find("+line02 EDITED"), std::string::npos) << cached;
  EXPECT_EQ(cached.find("line18 EDITED"), std::string::npos) << cached;
  const std::string worktree = gitOut(fixture.root(), "diff");
  EXPECT_NE(worktree.find("+line18 EDITED"), std::string::npos) << worktree;
  EXPECT_EQ(worktree.find("line02 EDITED"), std::string::npos) << worktree;

  // Unstage the staged hunk again (ranges from a fresh staged diff).
  Json stagedHunks = session.request(
      req(13, "diff/fileHunks", {{"repoId", repoId}, {"path", "hunky.txt"}, {"staged", true}}));
  ASSERT_EQ(stagedHunks["result"]["hunks"].size(), 1u);
  const Json& staged0 = stagedHunks["result"]["hunks"][0];
  Json unstageReq = session.request(req(14, "stage/hunks",
                                        {{"repoId", repoId},
                                         {"path", "hunky.txt"},
                                         {"action", "unstage"},
                                         {"hunks",
                                          Json::array({{{"oldStart", staged0["oldStart"]},
                                                        {"oldLines", staged0["oldLines"]},
                                                        {"newStart", staged0["newStart"]},
                                                        {"newLines", staged0["newLines"]}}})}}));
  ASSERT_TRUE(unstageReq.contains("result")) << unstageReq.dump();
  EXPECT_EQ(gitOut(fixture.root(), "diff --cached"), "");
  Json after = statusSummary(session, 15, repoId);
  EXPECT_TRUE(after["staged"].empty());
  EXPECT_EQ(changeFor(after["unstaged"], "hunky.txt")["status"], "M");

  // Stale ranges are rejected instead of applying the wrong lines.
  Json stale = session.request(req(16, "stage/hunks",
                                   {{"repoId", repoId},
                                    {"path", "hunky.txt"},
                                    {"action", "stage"},
                                    {"hunks",
                                     Json::array({{{"oldStart", 999},
                                                   {"oldLines", 1},
                                                   {"newStart", 999},
                                                   {"newLines", 1}}})}}));
  EXPECT_EQ(stale["error"]["code"], -32001);
}

}  // namespace
}  // namespace gg
