// End-to-end tests for the history/log/search/refs services, driven through
// the full server loop the way the extension drives the engine. Git's own
// output is used as the parity oracle wherever the protocol mirrors a
// porcelain command.

#include <gtest/gtest.h>
#include <nlohmann/json.hpp>

#include <algorithm>
#include <cstdio>
#include <filesystem>
#include <map>
#include <string>
#include <vector>

#include "test_fixtures.h"
#include "test_session.h"

namespace gg {
namespace {

using Json = nlohmann::json;
using gg::testing::FixtureRepo;
// Runs `git <args>` in the repo and returns stdout split into lines: the
// parity oracle for history answers.
using gg::testing::gitLines;
using gg::testing::initRequest;
using gg::testing::InteractiveSession;

Json req(std::int64_t id, const std::string& method, Json params) {
  return {{"jsonrpc", "2.0"}, {"id", id}, {"method", method}, {"params", std::move(params)}};
}

// Filters command output to full-sha lines: `git log -L`/patch-bearing
// commands intersperse diff text with the %H format lines.
std::vector<std::string> shaLinesOnly(std::vector<std::string> lines) {
  std::vector<std::string> shas;
  for (auto& line : lines) {
    if (line.size() != 40) continue;
    if (line.find_first_not_of("0123456789abcdef") != std::string::npos) continue;
    shas.push_back(std::move(line));
  }
  return shas;
}

// Commits with a distinct deterministic timestamp per tick, so time-based
// ordering (and its parity with git's) is well defined.
void commitTick(FixtureRepo& fixture, const std::string& message, int tick) {
  const std::string date = "@" + std::to_string(1700000000 + 60 * tick) + " +0000";
  fixture.commitAt(date, message);
}

std::string discoverRepo(InteractiveSession& session, const std::filesystem::path& root) {
  session.request(initRequest(1));
  Json discover = session.request(req(2, "repo/discover", {{"path", root.string()}}));
  return discover["result"]["repoId"];
}

// The rename chain from fixtures/make-fixtures.sh spec_renames.
void buildRenameChain(FixtureRepo& fixture) {
  fixture.writeFile("original.txt", "one\ntwo\nthree\nfour\nfive\n");
  fixture.run("git add original.txt");
  commitTick(fixture, "create original", 1);
  fixture.run("git mv original.txt renamed-once.txt");
  commitTick(fixture, "first rename", 2);
  fixture.writeFile("renamed-once.txt", "one\ntwo\ntwo-and-a-half\nthree\nfour\nfive\n");
  fixture.run("git add renamed-once.txt");
  commitTick(fixture, "edit after rename", 3);
  std::filesystem::create_directories(fixture.root() / "nested");
  fixture.run("git mv renamed-once.txt nested/renamed-twice.txt");
  commitTick(fixture, "second rename into dir", 4);
}

// Pages through log/commits and returns the concatenated sha sequence.
std::vector<std::string> pageAllCommits(InteractiveSession& session, const std::string& repoId,
                                        int limit, std::int64_t& id, int* pages = nullptr) {
  std::vector<std::string> shas;
  Json params = {{"repoId", repoId}, {"limit", limit}};
  for (;;) {
    Json page = session.request(req(++id, "log/commits", params));
    if (!page.contains("result")) {
      ADD_FAILURE() << "log/commits failed: " << page.dump();
      return shas;
    }
    if (pages) ++*pages;
    for (const auto& commit : page["result"]["commits"]) {
      shas.push_back(commit["sha"].get<std::string>());
    }
    if (!page["result"].contains("nextCursor")) break;
    params["cursor"] = page["result"]["nextCursor"];
  }
  return shas;
}

TEST(HistoryService, LogCommitsPagingMatchesRevList) {
  FixtureRepo fixture;
  for (int i = 1; i <= 6; ++i) commitTick(fixture, "commit " + std::to_string(i), i);

  InteractiveSession session;
  const std::string repoId = discoverRepo(session, fixture.root());
  std::int64_t id = 10;

  int pages = 0;
  auto shas = pageAllCommits(session, repoId, 3, id, &pages);
  EXPECT_EQ(pages, 3);  // 7 commits in pages of 3

  const auto expected = gitLines(fixture.root(), "rev-list --topo-order HEAD");
  EXPECT_EQ(shas, expected);

  // No duplicates across page boundaries.
  std::vector<std::string> sorted = shas;
  std::sort(sorted.begin(), sorted.end());
  EXPECT_EQ(std::unique(sorted.begin(), sorted.end()), sorted.end());

  // Shape of a page entry.
  Json page = session.request(req(++id, "log/commits", {{"repoId", repoId}, {"limit", 1}}));
  const Json& commit = page["result"]["commits"][0];
  EXPECT_EQ(commit["sha"].get<std::string>().size(), 40u);
  EXPECT_EQ(commit["parents"].size(), 1u);
  EXPECT_EQ(commit["author"]["name"], "Fixture");
  EXPECT_EQ(commit["author"]["email"], "fixture@example.invalid");
  EXPECT_EQ(commit["author"]["time"], 1700000000 + 60 * 6);
  EXPECT_EQ(commit["committer"]["name"], "Fixture");
  EXPECT_EQ(commit["summary"], "commit 6");
}

TEST(HistoryService, LogCommitsMergeTopologyMatchesRevList) {
  FixtureRepo fixture;
  commitTick(fixture, "base", 1);
  fixture.run("git checkout -q -b feature");
  commitTick(fixture, "feature work", 2);
  fixture.run("git checkout -q main");
  commitTick(fixture, "main work", 3);
  fixture.runAt("@1700000240 +0000", "git merge -q --no-ff --no-edit feature");

  InteractiveSession session;
  const std::string repoId = discoverRepo(session, fixture.root());
  std::int64_t id = 10;

  // Paged listing must be stable: identical to one oversized page.
  auto shas = pageAllCommits(session, repoId, 2, id);
  auto oneShot = pageAllCommits(session, repoId, 100, id);
  EXPECT_EQ(shas, oneShot);

  // Same commit set as git; exact sibling order may differ from
  // `--topo-order` (libgit2 breaks topological ties differently), so assert
  // the topological guarantee itself: every commit precedes its parents.
  auto expected = gitLines(fixture.root(), "rev-list --topo-order HEAD");
  auto sortedShas = shas;
  std::sort(sortedShas.begin(), sortedShas.end());
  std::sort(expected.begin(), expected.end());
  EXPECT_EQ(sortedShas, expected);

  Json page = session.request(req(++id, "log/commits", {{"repoId", repoId}, {"limit", 100}}));
  std::map<std::string, size_t> position;
  for (size_t i = 0; i < page["result"]["commits"].size(); ++i) {
    position[page["result"]["commits"][i]["sha"].get<std::string>()] = i;
  }
  for (const auto& commit : page["result"]["commits"]) {
    for (const auto& parent : commit["parents"]) {
      EXPECT_LT(position.at(commit["sha"].get<std::string>()),
                position.at(parent.get<std::string>()));
    }
  }

  // The merge commit reports both parents and comes first.
  EXPECT_EQ(page["result"]["commits"][0]["parents"].size(), 2u);
}

TEST(HistoryService, LogCommitsHonorsRefAndOversizedLimit) {
  FixtureRepo fixture;
  commitTick(fixture, "on main", 1);
  fixture.run("git branch side HEAD~1");

  InteractiveSession session;
  const std::string repoId = discoverRepo(session, fixture.root());

  Json fromSide = session.request(
      req(10, "log/commits", {{"repoId", repoId}, {"ref", "side"}, {"limit", 1000}}));
  const auto expected = gitLines(fixture.root(), "rev-list --topo-order side");
  ASSERT_EQ(fromSide["result"]["commits"].size(), expected.size());
  EXPECT_EQ(fromSide["result"]["commits"][0]["sha"], expected[0]);
  EXPECT_FALSE(fromSide["result"].contains("nextCursor"));

  Json badRef = session.request(
      req(11, "log/commits", {{"repoId", repoId}, {"ref", "no-such-ref"}, {"limit", 10}}));
  EXPECT_EQ(badRef["error"]["code"], -32001);

  Json badLimit = session.request(req(12, "log/commits", {{"repoId", repoId}}));
  EXPECT_EQ(badLimit["error"]["code"], -32602);
}

TEST(HistoryService, FileHistoryFollowsRenamesWithParity) {
  FixtureRepo fixture;
  buildRenameChain(fixture);

  InteractiveSession session;
  const std::string repoId = discoverRepo(session, fixture.root());

  Json history = session.request(
      req(10, "history/file",
          {{"repoId", repoId}, {"path", "nested/renamed-twice.txt"}, {"limit", 50}}));
  const Json& entries = history["result"]["entries"];
  ASSERT_EQ(entries.size(), 4u);
  EXPECT_FALSE(history["result"].contains("nextCursor"));

  const std::vector<std::string> summaries = {"second rename into dir", "edit after rename",
                                              "first rename", "create original"};
  const std::vector<std::string> paths = {"nested/renamed-twice.txt", "renamed-once.txt",
                                          "renamed-once.txt", "original.txt"};
  const std::vector<int> additions = {0, 1, 0, 5};
  for (size_t i = 0; i < 4; ++i) {
    EXPECT_EQ(entries[i]["summary"], summaries[i]) << i;
    EXPECT_EQ(entries[i]["path"], paths[i]) << i;
    EXPECT_EQ(entries[i]["additions"], additions[i]) << i;
    EXPECT_EQ(entries[i]["deletions"], 0) << i;
    EXPECT_EQ(entries[i]["author"]["name"], "Fixture");
    EXPECT_GT(entries[i]["author"]["time"].get<std::int64_t>(), 0);
  }

  // Parity: sha sequence must equal git's own rename-following listing.
  const auto expected =
      gitLines(fixture.root(), "log --follow --format=%H -- nested/renamed-twice.txt");
  ASSERT_EQ(entries.size(), expected.size());
  for (size_t i = 0; i < expected.size(); ++i) {
    EXPECT_EQ(entries[i]["sha"], expected[i]) << i;
  }
}

TEST(HistoryService, FileHistoryPagesAcrossRenameBoundaries) {
  FixtureRepo fixture;
  buildRenameChain(fixture);

  InteractiveSession session;
  const std::string repoId = discoverRepo(session, fixture.root());
  std::int64_t id = 10;

  // Page size 1 forces a cursor hand-off at every entry, including both
  // rename commits.
  std::vector<std::string> shas;
  Json params = {{"repoId", repoId}, {"path", "nested/renamed-twice.txt"}, {"limit", 1}};
  int pages = 0;
  for (;;) {
    Json page = session.request(req(++id, "history/file", params));
    ASSERT_TRUE(page.contains("result")) << page.dump();
    ++pages;
    for (const auto& entry : page["result"]["entries"]) {
      shas.push_back(entry["sha"].get<std::string>());
    }
    if (!page["result"].contains("nextCursor")) break;
    params["cursor"] = page["result"]["nextCursor"];
  }
  EXPECT_EQ(pages, 4);
  const auto expected =
      gitLines(fixture.root(), "log --follow --format=%H -- nested/renamed-twice.txt");
  EXPECT_EQ(shas, expected);
}

TEST(HistoryService, FileHistoryHandlesPathsWithSpaces) {
  FixtureRepo fixture;
  fixture.writeFile("dir with spaces/my file.txt", "hello\n");
  fixture.run("git add \"dir with spaces/my file.txt\"");
  commitTick(fixture, "add spaced file", 1);
  fixture.writeFile("dir with spaces/my file.txt", "hello\nworld\n");
  fixture.run("git add \"dir with spaces/my file.txt\"");
  commitTick(fixture, "edit spaced file", 2);

  InteractiveSession session;
  const std::string repoId = discoverRepo(session, fixture.root());

  Json history = session.request(
      req(10, "history/file",
          {{"repoId", repoId}, {"path", "dir with spaces/my file.txt"}, {"limit", 10}}));
  const Json& entries = history["result"]["entries"];
  ASSERT_EQ(entries.size(), 2u);
  EXPECT_EQ(entries[0]["summary"], "edit spaced file");
  EXPECT_EQ(entries[0]["path"], "dir with spaces/my file.txt");
  EXPECT_EQ(entries[0]["additions"], 1);
}

TEST(HistoryService, LineHistoryReportsCommitsTouchingRange) {
  FixtureRepo fixture;
  fixture.writeFile("lines.txt", "alpha\nbeta\ngamma\n");
  fixture.run("git add lines.txt");
  commitTick(fixture, "create lines", 1);
  fixture.writeFile("lines.txt", "alpha\nbeta CHANGED\ngamma\n");
  fixture.run("git add lines.txt");
  commitTick(fixture, "edit line two", 2);
  fixture.writeFile("lines.txt", "alpha\nbeta CHANGED\ngamma CHANGED\n");
  fixture.run("git add lines.txt");
  commitTick(fixture, "edit line three", 3);

  InteractiveSession session;
  const std::string repoId = discoverRepo(session, fixture.root());

  Json history = session.request(
      req(10, "history/line",
          {{"repoId", repoId}, {"path", "lines.txt"}, {"startLine", 2}, {"endLine", 2}}));
  const Json& entries = history["result"]["entries"];
  const auto expected =
      shaLinesOnly(gitLines(fixture.root(), "log -L2,2:lines.txt --format=%H"));
  ASSERT_EQ(entries.size(), expected.size());
  for (size_t i = 0; i < expected.size(); ++i) {
    EXPECT_EQ(entries[i]["sha"], expected[i]) << i;
    EXPECT_EQ(entries[i]["additions"], 0);
    EXPECT_EQ(entries[i]["deletions"], 0);
    EXPECT_EQ(entries[i]["path"], "lines.txt");
  }
  // The line-3-only edit must not appear.
  for (const auto& entry : entries) {
    EXPECT_NE(entry["summary"], "edit line three");
  }
  EXPECT_EQ(entries[0]["summary"], "edit line two");

  Json badRange = session.request(
      req(11, "history/line",
          {{"repoId", repoId}, {"path", "lines.txt"}, {"startLine", 0}, {"endLine", 2}}));
  EXPECT_EQ(badRange["error"]["code"], -32602);
  Json inverted = session.request(
      req(12, "history/line",
          {{"repoId", repoId}, {"path", "lines.txt"}, {"startLine", 3}, {"endLine", 2}}));
  EXPECT_EQ(inverted["error"]["code"], -32602);
}

TEST(HistoryService, SearchStreamsMatchesBeforeResultWithGrepParity) {
  FixtureRepo fixture;
  commitTick(fixture, "add needle one", 1);
  commitTick(fixture, "unrelated work", 2);
  commitTick(fixture, "NEEDLE two uppercase", 3);

  InteractiveSession session;
  const std::string repoId = discoverRepo(session, fixture.root());

  Json result = session.request(req(10, "search/commits",
                                    {{"repoId", repoId},
                                     {"streamId", "q1"},
                                     {"limit", 50},
                                     {"query", {{"text", "needle"}}}}));
  EXPECT_EQ(result["result"]["streamId"], "q1");
  EXPECT_EQ(result["result"]["total"], 2);
  EXPECT_EQ(result["result"]["truncated"], false);

  // Matches arrived as notifications before the result (request() banks every
  // frame read while awaiting the response).
  std::vector<std::string> matchShas;
  for (const auto& note : session.notifications) {
    if (note.value("method", "") != "search/matches") continue;
    EXPECT_EQ(note["params"]["streamId"], "q1");
    for (const auto& match : note["params"]["matches"]) {
      matchShas.push_back(match["sha"].get<std::string>());
      EXPECT_TRUE(match.contains("parents"));
      EXPECT_EQ(match["author"]["name"], "Fixture");
      EXPECT_FALSE(match["summary"].get<std::string>().empty());
    }
  }
  const auto expected = gitLines(fixture.root(), "log -i --grep=needle --format=%H");
  EXPECT_EQ(matchShas, expected);
}

TEST(HistoryService, SearchFiltersByAuthorShaAndCombination) {
  FixtureRepo fixture;
  commitTick(fixture, "needle by fixture", 1);
  {
    gg::testing::ScopedEnv name("GIT_AUTHOR_NAME", "Zed Zeta");
    gg::testing::ScopedEnv email("GIT_AUTHOR_EMAIL", "zed@other.dev");
    fixture.commitAt("@1700000120 +0000", "needle by zed");
  }

  InteractiveSession session;
  const std::string repoId = discoverRepo(session, fixture.root());
  const std::string headSha = gitLines(fixture.root(), "rev-parse HEAD")[0];

  // Author matches on name or email, case-insensitively.
  Json byAuthor = session.request(req(10, "search/commits",
                                      {{"repoId", repoId},
                                       {"streamId", "a"},
                                       {"limit", 50},
                                       {"query", {{"author", "ZED"}}}}));
  EXPECT_EQ(byAuthor["result"]["total"], 1);
  Json byEmail = session.request(req(11, "search/commits",
                                     {{"repoId", repoId},
                                      {"streamId", "b"},
                                      {"limit", 50},
                                      {"query", {{"author", "other.dev"}}}}));
  EXPECT_EQ(byEmail["result"]["total"], 1);

  // Unique sha prefix.
  Json bySha = session.request(req(12, "search/commits",
                                   {{"repoId", repoId},
                                    {"streamId", "c"},
                                    {"limit", 50},
                                    {"query", {{"sha", headSha.substr(0, 10)}}}}));
  EXPECT_EQ(bySha["result"]["total"], 1);
  bool sawHead = false;
  for (const auto& note : session.notifications) {
    if (note.value("method", "") == "search/matches" && note["params"]["streamId"] == "c") {
      sawHead = note["params"]["matches"][0]["sha"] == headSha;
    }
  }
  EXPECT_TRUE(sawHead);

  // Criteria AND together: needle + Fixture excludes Zed's needle commit.
  Json combined = session.request(req(13, "search/commits",
                                      {{"repoId", repoId},
                                       {"streamId", "d"},
                                       {"limit", 50},
                                       {"query", {{"text", "needle"}, {"author", "fixture"}}}}));
  EXPECT_EQ(combined["result"]["total"], 1);

  // Limit cuts the walk short and reports truncation.
  Json truncated = session.request(req(14, "search/commits",
                                       {{"repoId", repoId},
                                        {"streamId", "e"},
                                        {"limit", 1},
                                        {"query", {{"text", "needle"}}}}));
  EXPECT_EQ(truncated["result"]["total"], 1);
  EXPECT_EQ(truncated["result"]["truncated"], true);
}

TEST(HistoryService, SearchBatchesMatchesInHundreds) {
  FixtureRepo fixture;
  for (int i = 1; i <= 105; ++i) fixture.commit("needle " + std::to_string(i));

  InteractiveSession session;
  const std::string repoId = discoverRepo(session, fixture.root());

  Json result = session.request(req(10, "search/commits",
                                    {{"repoId", repoId},
                                     {"streamId", "big"},
                                     {"limit", 500},
                                     {"query", {{"text", "needle"}}}}));
  EXPECT_EQ(result["result"]["total"], 105);
  EXPECT_EQ(result["result"]["truncated"], false);

  std::vector<size_t> batchSizes;
  for (const auto& note : session.notifications) {
    if (note.value("method", "") == "search/matches" && note["params"]["streamId"] == "big") {
      batchSizes.push_back(note["params"]["matches"].size());
    }
  }
  ASSERT_EQ(batchSizes.size(), 2u);
  EXPECT_EQ(batchSizes[0], 100u);
  EXPECT_EQ(batchSizes[1], 5u);
}

TEST(HistoryService, RefsListBranchesRemotesAndTags) {
  FixtureRepo fixture;
  commitTick(fixture, "tagged work", 1);
  fixture.run("git branch feature");
  fixture.run("git tag v1");
  fixture.runAt("@1700000120 +0000", "git tag -a v2 -m \"annotated tag\"");
  fixture.run("git remote add origin .");
  fixture.run("git fetch -q origin");
  fixture.run("git branch -q --set-upstream-to=origin/main main");

  InteractiveSession session;
  const std::string repoId = discoverRepo(session, fixture.root());
  const std::string headSha = gitLines(fixture.root(), "rev-parse HEAD")[0];

  Json refs = session.request(req(10, "refs/list", {{"repoId", repoId}}));
  ASSERT_TRUE(refs.contains("result")) << refs.dump();

  const Json& branches = refs["result"]["branches"];
  ASSERT_EQ(branches.size(), 2u);
  bool sawMain = false, sawFeature = false;
  for (const auto& branch : branches) {
    if (branch["name"] == "main") {
      sawMain = true;
      EXPECT_EQ(branch["current"], true);
      EXPECT_EQ(branch["sha"], headSha);
      EXPECT_EQ(branch["upstream"], "origin/main");
    }
    if (branch["name"] == "feature") {
      sawFeature = true;
      EXPECT_EQ(branch["current"], false);
      EXPECT_FALSE(branch.contains("upstream"));
    }
  }
  EXPECT_TRUE(sawMain);
  EXPECT_TRUE(sawFeature);

  const Json& remotes = refs["result"]["remotes"];
  ASSERT_EQ(remotes.size(), 1u);
  EXPECT_EQ(remotes[0]["name"], "origin");
  bool sawRemoteMain = false;
  for (const auto& branch : remotes[0]["branches"]) {
    EXPECT_EQ(branch["sha"].get<std::string>().size(), 40u);
    if (branch["name"] == "main") sawRemoteMain = true;
  }
  EXPECT_TRUE(sawRemoteMain);

  const Json& tags = refs["result"]["tags"];
  ASSERT_EQ(tags.size(), 2u);
  for (const auto& tag : tags) {
    // Annotated tags peel to the tagged commit, not the tag object.
    EXPECT_EQ(tag["sha"], headSha) << tag.dump();
  }
  EXPECT_EQ(tags[0]["name"], "v1");
  EXPECT_EQ(tags[1]["name"], "v2");
}

TEST(HistoryService, StashListParsesBranchFromMessage) {
  FixtureRepo fixture;
  fixture.writeFile("work.txt", "stable\n");
  fixture.run("git add work.txt");
  commitTick(fixture, "initial work", 1);
  fixture.writeFile("work.txt", "stable\nwip one\n");
  fixture.run("git stash push -q -m \"first stash\"");
  fixture.writeFile("work.txt", "stable\nwip two\n");
  fixture.run("git stash push -q");

  InteractiveSession session;
  const std::string repoId = discoverRepo(session, fixture.root());

  Json stashes = session.request(req(10, "stash/list", {{"repoId", repoId}}));
  const Json& entries = stashes["result"]["entries"];
  ASSERT_EQ(entries.size(), 2u);

  // Newest first: stash@{0} is the message-less push ("WIP on main: ...").
  EXPECT_EQ(entries[0]["index"], 0);
  EXPECT_EQ(entries[0]["sha"].get<std::string>().size(), 40u);
  EXPECT_EQ(entries[0]["message"].get<std::string>().rfind("WIP on main:", 0), 0u);
  EXPECT_EQ(entries[0]["branch"], "main");

  EXPECT_EQ(entries[1]["index"], 1);
  EXPECT_EQ(entries[1]["message"], "On main: first stash");
  EXPECT_EQ(entries[1]["branch"], "main");
  EXPECT_NE(entries[0]["sha"], entries[1]["sha"]);
}

TEST(HistoryService, UnbornHeadRepoAnswersEmptyEverywhere) {
  // A freshly initialized repository: HEAD exists but points at no commit.
  struct UnbornRepo {
    std::filesystem::path root;
    UnbornRepo() {
      root = std::filesystem::temp_directory_path() /
             ("gg-unborn-" +
              std::to_string(::testing::UnitTest::GetInstance()->random_seed()));
      std::filesystem::create_directories(root);
      gg::testing::runGit(root, "git init -q -b main");
    }
    ~UnbornRepo() {
      std::error_code ec;
      std::filesystem::remove_all(root, ec);
    }
  } unborn;

  InteractiveSession session;
  const std::string repoId = discoverRepo(session, unborn.root);

  Json log = session.request(req(10, "log/commits", {{"repoId", repoId}, {"limit", 10}}));
  ASSERT_TRUE(log.contains("result")) << log.dump();
  EXPECT_TRUE(log["result"]["commits"].empty());
  EXPECT_FALSE(log["result"].contains("nextCursor"));

  Json file = session.request(
      req(11, "history/file", {{"repoId", repoId}, {"path", "a.txt"}, {"limit", 10}}));
  EXPECT_TRUE(file["result"]["entries"].empty());

  Json line = session.request(
      req(12, "history/line",
          {{"repoId", repoId}, {"path", "a.txt"}, {"startLine", 1}, {"endLine", 2}}));
  EXPECT_TRUE(line["result"]["entries"].empty());

  Json search = session.request(req(13, "search/commits",
                                    {{"repoId", repoId},
                                     {"streamId", "s"},
                                     {"limit", 10},
                                     {"query", {{"text", "x"}}}}));
  EXPECT_EQ(search["result"]["total"], 0);
  EXPECT_EQ(search["result"]["truncated"], false);

  Json refs = session.request(req(14, "refs/list", {{"repoId", repoId}}));
  EXPECT_TRUE(refs["result"]["branches"].empty());
  EXPECT_TRUE(refs["result"]["remotes"].empty());
  EXPECT_TRUE(refs["result"]["tags"].empty());

  Json stashes = session.request(req(15, "stash/list", {{"repoId", repoId}}));
  EXPECT_TRUE(stashes["result"]["entries"].empty());
}

}  // namespace
}  // namespace gg
