// End-to-end tests for graph/rows: golden lane layouts for canonical
// topologies (per docs/specs/commit-graph-lanes.md), determinism, paging,
// synthetic WIP/stash rows and refs decorations, driven through the full
// server loop the way the extension drives the engine.

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

constexpr const char* kWipSha = "0000000000000000000000000000000000000000";

Json req(std::int64_t id, const std::string& method, Json params) {
  return {{"jsonrpc", "2.0"}, {"id", id}, {"method", method}, {"params", std::move(params)}};
}

using gg::testing::gitLines;

std::string rev(const FixtureRepo& fixture, const std::string& spec) {
  // `^` never reaches a shell: cmd.exe treats carets as escape characters,
  // so parent specs resolve via rev-list --parents instead.
  const size_t caret = spec.find('^');
  if (caret != std::string::npos) {
    const std::string base = spec.substr(0, caret);
    const std::string indexText = spec.substr(caret + 1);
    const size_t parentIndex = indexText.empty() ? 1 : std::stoul(indexText);
    const auto lines = gitLines(fixture.root(), "rev-list --parents -n 1 " + base);
    EXPECT_FALSE(lines.empty()) << spec;
    if (lines.empty()) return "";
    std::istringstream fields(lines[0]);
    std::string sha;
    for (size_t i = 0; i <= parentIndex; ++i) fields >> sha;
    EXPECT_FALSE(sha.empty()) << spec;
    return sha;
  }
  const auto lines = gitLines(fixture.root(), "rev-parse " + spec);
  EXPECT_FALSE(lines.empty()) << spec;
  return lines.empty() ? "" : lines[0];
}

void commitTick(FixtureRepo& fixture, const std::string& message, int tick) {
  const std::string date = "@" + std::to_string(1700000000 + 60 * tick) + " +0000";
  fixture.commitAt(date, message);
}

void mergeTick(FixtureRepo& fixture, const std::string& mergeArgs, int tick) {
  // Refresh cached stat info first: on filesystems with coarse timestamps,
  // racy-stat protection can leave just-switched files marked dirty, and
  // merge then refuses to run.
  fixture.tryRun("git update-index -q --refresh");
  const std::string date = "@" + std::to_string(1700000000 + 60 * tick) + " +0000";
  fixture.runAt(date, "git merge -q " + mergeArgs);
}

// Builds an N-parent merge commit with plumbing (commit-tree + update-ref).
// Builtins only: the octopus merge strategy runs through git's shell-script
// machinery, which some minimal git environments cannot execute.
void octopusMergeTick(FixtureRepo& fixture, const std::vector<std::string>& extraHeads,
                      int tick) {
  const std::string date = "@" + std::to_string(1700000000 + 60 * tick) + " +0000";
  const auto tree = gitLines(fixture.root(), "log -1 --format=%T HEAD");
  ASSERT_FALSE(tree.empty());
  std::string parents = "-p HEAD";
  for (const auto& head : extraHeads) parents += " -p " + head;
  gg::testing::ScopedEnv author("GIT_AUTHOR_DATE", date);
  gg::testing::ScopedEnv committer("GIT_COMMITTER_DATE", date);
  const auto merged = gitLines(
      fixture.root(), "commit-tree " + tree[0] + " " + parents + " -m octopus-merge");
  ASSERT_FALSE(merged.empty());
  fixture.run("git update-ref refs/heads/main " + merged[0]);
  fixture.run("git reset -q --hard");
}

std::string discoverRepo(InteractiveSession& session, const std::filesystem::path& root) {
  session.request(initRequest(1));
  Json discover = session.request(req(2, "repo/discover", {{"path", root.string()}}));
  return discover["result"]["repoId"];
}

Json graphRows(InteractiveSession& session, std::int64_t id, const std::string& repoId,
               Json extra = Json::object()) {
  Json params = {{"repoId", repoId},
                 {"limit", 1000},
                 {"include", {{"stashes", false}, {"wip", false}}}};
  params.update(extra);
  Json response = session.request(req(id, "graph/rows", std::move(params)));
  EXPECT_TRUE(response.contains("result")) << response.dump();
  return response["result"];
}

Json edge(int from, int to, const char* kind) {
  return {{"fromLane", from}, {"toLane", to}, {"kind", kind}};
}

struct ExpectedRow {
  std::string sha;
  int lane;
  Json edges;
};

void expectLayout(const Json& rows, const std::vector<ExpectedRow>& expected) {
  ASSERT_EQ(rows.size(), expected.size()) << rows.dump(2);
  for (size_t i = 0; i < expected.size(); ++i) {
    EXPECT_EQ(rows[i]["sha"], expected[i].sha) << "row " << i;
    EXPECT_EQ(rows[i]["lane"], expected[i].lane) << "row " << i;
    EXPECT_EQ(rows[i]["laneEdges"], expected[i].edges)
        << "row " << i << ": " << rows[i]["laneEdges"].dump();
  }
}

TEST(GraphService, LinearLayoutGolden) {
  // main: initial -- c1 -- c2 (HEAD)
  //
  //   c2       lane 0
  //   c1       lane 0
  //   initial  lane 0
  FixtureRepo fixture;
  commitTick(fixture, "c1", 1);
  commitTick(fixture, "c2", 2);

  InteractiveSession session;
  const std::string repoId = discoverRepo(session, fixture.root());
  Json result = graphRows(session, 10, repoId);

  expectLayout(result["rows"], {{rev(fixture, "HEAD"), 0, Json::array()},
                                {rev(fixture, "HEAD~1"), 0, Json::array()},
                                {rev(fixture, "HEAD~2"), 0, Json::array()}});
  EXPECT_FALSE(result.contains("nextCursor"));
  EXPECT_GT(result["generation"].get<std::int64_t>(), 0);

  // Refs decorate the tip: HEAD flag first, then the branch.
  const Json& refs = result["rows"][0]["refs"];
  ASSERT_EQ(refs.size(), 2u) << refs.dump();
  EXPECT_EQ(refs[0], Json({{"name", "HEAD"}, {"kind", "head"}}));
  EXPECT_EQ(refs[1], Json({{"name", "main"}, {"kind", "branch"}}));
  for (const auto& row : result["rows"]) {
    EXPECT_EQ(row["kind"], "commit");
    EXPECT_EQ(row["author"]["name"], "Fixture");
    EXPECT_GT(row["time"].get<std::int64_t>(), 0);
  }
}

TEST(GraphService, SingleMergeLayoutGolden) {
  // initial -- base -- m1 ------ M (HEAD, main)
  //              \              /
  //               f1 (feature)-
  //
  //   M     lane 0   branchOut 0->1
  //   m1    lane 0   line 1
  //   f1    lane 1   line 0
  //   base  lane 0   mergeIn 1->0
  //   init  lane 0
  FixtureRepo fixture;
  commitTick(fixture, "base", 1);
  fixture.run("git checkout -q -b feature");
  commitTick(fixture, "f1", 2);
  fixture.run("git checkout -q main");
  commitTick(fixture, "m1", 3);
  mergeTick(fixture, "--no-ff --no-edit feature", 4);

  InteractiveSession session;
  const std::string repoId = discoverRepo(session, fixture.root());
  Json result = graphRows(session, 10, repoId);

  expectLayout(result["rows"],
               {{rev(fixture, "HEAD"), 0, Json::array({edge(0, 1, "branchOut")})},
                {rev(fixture, "HEAD^1"), 0, Json::array({edge(1, 1, "line")})},
                {rev(fixture, "HEAD^2"), 1, Json::array({edge(0, 0, "line")})},
                {rev(fixture, "HEAD~2"), 0, Json::array({edge(1, 0, "mergeIn")})},
                {rev(fixture, "HEAD~3"), 0, Json::array()}});
  EXPECT_EQ(result["rows"][0]["parents"].size(), 2u);
}

TEST(GraphService, CrissCrossLayoutGolden) {
  // initial -- base -- A -- CA (crossA)      CA = merge(A, B)
  //              \       \ /
  //               \       X
  //                \     / \ .
  //                 -- B -- CB (crossB, HEAD) CB = merge(B, A)
  //
  //   CB    lane 0   branchOut 0->1
  //   CA    lane 2   branchOut 2->0, line 1
  //   B     lane 0   line 1, line 2
  //   A     lane 1   mergeIn 2->1, line 0
  //   base  lane 0   mergeIn 1->0
  //   init  lane 0
  FixtureRepo fixture;
  commitTick(fixture, "base", 1);
  fixture.run("git checkout -q -b sideA");
  commitTick(fixture, "A", 2);
  fixture.run("git checkout -q main");
  fixture.run("git checkout -q -b sideB");
  commitTick(fixture, "B", 3);
  fixture.run("git checkout -q -b crossA sideA");
  mergeTick(fixture, "--no-ff --no-edit sideB", 4);
  fixture.run("git checkout -q -b crossB sideB");
  mergeTick(fixture, "--no-ff --no-edit sideA", 5);

  InteractiveSession session;
  const std::string repoId = discoverRepo(session, fixture.root());
  Json result = graphRows(session, 10, repoId);

  expectLayout(result["rows"],
               {{rev(fixture, "crossB"), 0, Json::array({edge(0, 1, "branchOut")})},
                {rev(fixture, "crossA"), 2,
                 Json::array({edge(2, 0, "branchOut"), edge(1, 1, "line")})},
                {rev(fixture, "sideB"), 0, Json::array({edge(1, 1, "line"), edge(2, 2, "line")})},
                {rev(fixture, "sideA"), 1,
                 Json::array({edge(2, 1, "mergeIn"), edge(0, 0, "line")})},
                {rev(fixture, "main"), 0, Json::array({edge(1, 0, "mergeIn")})},
                {rev(fixture, "main~1"), 0, Json::array()}});
}

TEST(GraphService, OctopusLayoutGolden) {
  // initial -- base -- m1 -- M (HEAD, main)   M = merge(m1, c1, c2)
  //              \          //
  //               +-- c1 --/ (b1)
  //                \      /
  //                 c2 --- (b2)
  //
  //   M     lane 0   branchOut 0->1, branchOut 0->2
  //   m1    lane 0   line 1, line 2
  //   c2    lane 2   line 0, line 1
  //   c1    lane 1   line 0, line 2
  //   base  lane 0   mergeIn 1->0, mergeIn 2->0
  //   init  lane 0
  FixtureRepo fixture;
  commitTick(fixture, "base", 1);
  fixture.run("git checkout -q -b b1");
  commitTick(fixture, "c1", 2);
  fixture.run("git checkout -q main");
  fixture.run("git checkout -q -b b2");
  commitTick(fixture, "c2", 3);
  fixture.run("git checkout -q main");
  commitTick(fixture, "m1", 4);
  octopusMergeTick(fixture, {"b1", "b2"}, 5);

  InteractiveSession session;
  const std::string repoId = discoverRepo(session, fixture.root());
  Json result = graphRows(session, 10, repoId);

  ASSERT_EQ(result["rows"][0]["parents"].size(), 3u) << "octopus merge expected";
  expectLayout(
      result["rows"],
      {{rev(fixture, "HEAD"), 0, Json::array({edge(0, 1, "branchOut"), edge(0, 2, "branchOut")})},
       {rev(fixture, "HEAD^1"), 0, Json::array({edge(1, 1, "line"), edge(2, 2, "line")})},
       {rev(fixture, "b2"), 2, Json::array({edge(0, 0, "line"), edge(1, 1, "line")})},
       {rev(fixture, "b1"), 1, Json::array({edge(0, 0, "line"), edge(2, 2, "line")})},
       {rev(fixture, "HEAD~2"), 0, Json::array({edge(1, 0, "mergeIn"), edge(2, 0, "mergeIn")})},
       {rev(fixture, "HEAD~3"), 0, Json::array()}});
}

TEST(GraphService, ConcurrentBranchesLayoutGolden) {
  // initial -- m1 -- m2 (HEAD, main)
  //        \ .
  //         f1 (feature)
  //
  //   m2    lane 0            (t4)
  //   f1    lane 1   line 0   (t3)
  //   m1    lane 0   line 1   (t2)
  //   init  lane 0   mergeIn 1->0
  FixtureRepo fixture;
  fixture.run("git branch feature");
  fixture.run("git checkout -q feature");
  commitTick(fixture, "f1", 3);
  fixture.run("git checkout -q main");
  commitTick(fixture, "m1", 2);
  commitTick(fixture, "m2", 4);

  InteractiveSession session;
  const std::string repoId = discoverRepo(session, fixture.root());
  Json result = graphRows(session, 10, repoId);

  expectLayout(result["rows"],
               {{rev(fixture, "main"), 0, Json::array()},
                {rev(fixture, "feature"), 1, Json::array({edge(0, 0, "line")})},
                {rev(fixture, "main~1"), 0, Json::array({edge(1, 1, "line")})},
                {rev(fixture, "main~2"), 0, Json::array({edge(1, 0, "mergeIn")})}});
}

TEST(GraphService, DeterministicAndPagingStable) {
  FixtureRepo fixture;
  commitTick(fixture, "base", 1);
  fixture.run("git checkout -q -b feature");
  commitTick(fixture, "f1", 2);
  fixture.run("git checkout -q main");
  commitTick(fixture, "m1", 3);
  mergeTick(fixture, "--no-ff --no-edit feature", 4);

  InteractiveSession session;
  const std::string repoId = discoverRepo(session, fixture.root());

  // Two identical requests produce byte-identical results.
  Json first = graphRows(session, 10, repoId);
  Json second = graphRows(session, 11, repoId);
  EXPECT_EQ(first.dump(), second.dump());

  // Paging with limit 2 concatenates to exactly the unpaged row list, with a
  // stable generation across pages.
  Json paged = Json::array();
  Json params = {{"limit", 2}};
  std::int64_t id = 20;
  int pages = 0;
  for (;;) {
    Json page = graphRows(session, ++id, repoId, params);
    ++pages;
    EXPECT_EQ(page["generation"], first["generation"]);
    for (const auto& row : page["rows"]) paged.push_back(row);
    if (!page.contains("nextCursor")) break;
    params["cursor"] = page["nextCursor"];
  }
  EXPECT_EQ(pages, 3);  // 5 rows in pages of 2
  EXPECT_EQ(paged.dump(), first["rows"].dump());
}

TEST(GraphService, WipRowSynthesizedWhenDirty) {
  FixtureRepo fixture;
  commitTick(fixture, "c1", 1);

  InteractiveSession session;
  const std::string repoId = discoverRepo(session, fixture.root());

  // Clean tree: no WIP row even when requested.
  Json clean = graphRows(session, 10, repoId, {{"include", {{"stashes", false}, {"wip", true}}}});
  EXPECT_EQ(clean["rows"][0]["kind"], "commit");

  fixture.writeFile("README.md", "fixture\ndirty\n");
  Json dirty = graphRows(session, 11, repoId, {{"include", {{"stashes", false}, {"wip", true}}}});
  const Json& wip = dirty["rows"][0];
  EXPECT_EQ(wip["kind"], "wip");
  EXPECT_EQ(wip["sha"], kWipSha);
  EXPECT_EQ(wip["lane"], 0);
  ASSERT_EQ(wip["parents"].size(), 1u);
  EXPECT_EQ(wip["parents"][0], rev(fixture, "HEAD"));
  EXPECT_EQ(wip["summary"], "Uncommitted changes");
  // HEAD continues in the WIP row's lane.
  EXPECT_EQ(dirty["rows"][1]["sha"], rev(fixture, "HEAD"));
  EXPECT_EQ(dirty["rows"][1]["lane"], 0);

  // Not requested: no WIP row despite the dirty tree.
  Json without = graphRows(session, 12, repoId);
  EXPECT_EQ(without["rows"][0]["kind"], "commit");
}

// Dirtiness stops at the first changed entry and does not descend into
// untracked directories, so an untracked directory must still count.
TEST(GraphService, UntrackedDirectoryAloneMakesTheTreeDirty) {
  FixtureRepo fixture;
  commitTick(fixture, "c1", 1);

  InteractiveSession session;
  const std::string repoId = discoverRepo(session, fixture.root());
  Json clean = graphRows(session, 10, repoId, {{"include", {{"stashes", false}, {"wip", true}}}});
  EXPECT_EQ(clean["rows"][0]["kind"], "commit");

  std::filesystem::create_directories(fixture.root() / "untracked" / "nested");
  fixture.writeFile("untracked/nested/file.txt", "content\n");

  Json dirty = graphRows(session, 11, repoId, {{"include", {{"stashes", false}, {"wip", true}}}});
  EXPECT_EQ(dirty["rows"][0]["kind"], "wip");
}

// The cached plan is keyed on the ref fingerprint, so a new commit must be
// visible on the next request rather than served from the previous walk.
TEST(GraphService, CachedPlanIsInvalidatedWhenRefsMove) {
  FixtureRepo fixture;
  commitTick(fixture, "c1", 1);

  InteractiveSession session;
  const std::string repoId = discoverRepo(session, fixture.root());
  Json before = graphRows(session, 10, repoId);
  const size_t rowsBefore = before["rows"].size();
  // A repeated request for the unchanged repo is served from the cache and
  // must be byte-identical.
  EXPECT_EQ(graphRows(session, 11, repoId).dump(), before.dump());

  commitTick(fixture, "c2", 2);
  Json after = graphRows(session, 12, repoId);
  EXPECT_NE(after["generation"], before["generation"]);
  ASSERT_EQ(after["rows"].size(), rowsBefore + 1);
  EXPECT_EQ(after["rows"][0]["sha"], rev(fixture, "HEAD"));
}

TEST(GraphService, StashRowPrecedesItsBaseCommit) {
  FixtureRepo fixture;
  fixture.writeFile("work.txt", "stable\n");
  fixture.run("git add work.txt");
  commitTick(fixture, "c1", 1);
  fixture.writeFile("work.txt", "stable\nwip\n");
  fixture.run("git stash push -q");
  const std::string stashSha = rev(fixture, "refs/stash");

  InteractiveSession session;
  const std::string repoId = discoverRepo(session, fixture.root());

  Json result = graphRows(session, 10, repoId, {{"include", {{"stashes", true}, {"wip", false}}}});
  const Json& rows = result["rows"];
  ASSERT_EQ(rows.size(), 3u) << rows.dump();
  EXPECT_EQ(rows[0]["kind"], "stash");
  EXPECT_EQ(rows[0]["sha"], stashSha);
  EXPECT_EQ(rows[0]["lane"], 0);
  ASSERT_EQ(rows[0]["parents"].size(), 1u);
  EXPECT_EQ(rows[0]["parents"][0], rev(fixture, "HEAD"));
  ASSERT_EQ(rows[0]["refs"].size(), 1u);
  EXPECT_EQ(rows[0]["refs"][0], Json({{"name", "stash@{0}"}, {"kind", "stash"}}));
  EXPECT_EQ(rows[0]["summary"].get<std::string>().rfind("WIP on main", 0), 0u);
  // The stash row sits immediately before the commit it was stashed on.
  EXPECT_EQ(rows[1]["sha"], rev(fixture, "HEAD"));
  EXPECT_EQ(rows[1]["kind"], "commit");

  // Not requested: commits only.
  Json without = graphRows(session, 11, repoId);
  ASSERT_EQ(without["rows"].size(), 2u);
  EXPECT_EQ(without["rows"][0]["kind"], "commit");

  // Paging with limit 1 splits between the stash row and its base commit;
  // the cursor still resumes exactly.
  Json paged = Json::array();
  Json params = {{"limit", 1}, {"include", {{"stashes", true}, {"wip", false}}}};
  std::int64_t id = 20;
  for (;;) {
    Json page = graphRows(session, ++id, repoId, params);
    for (const auto& row : page["rows"]) paged.push_back(row);
    if (!page.contains("nextCursor")) break;
    params["cursor"] = page["nextCursor"];
  }
  EXPECT_EQ(paged.dump(), rows.dump());
}

TEST(GraphService, UpstreamAheadBehindAndRemoteDecorations) {
  FixtureRepo fixture;
  commitTick(fixture, "c1", 1);
  commitTick(fixture, "c2", 2);
  fixture.run("git clone --bare -q . upstream.git");
  fixture.run("git remote add origin upstream.git");
  fixture.run("git fetch -q origin");
  fixture.run("git branch -q --set-upstream-to=origin/main main");
  fixture.run("git reset -q --hard HEAD~1");
  commitTick(fixture, "c3", 3);

  InteractiveSession session;
  const std::string repoId = discoverRepo(session, fixture.root());
  Json result = graphRows(session, 10, repoId);

  const std::string localTip = rev(fixture, "main");
  const std::string remoteTip = rev(fixture, "origin/main");
  bool sawBranch = false, sawRemote = false;
  for (const auto& row : result["rows"]) {
    for (const auto& ref : row["refs"]) {
      if (ref["kind"] == "branch" && ref["name"] == "main") {
        sawBranch = true;
        EXPECT_EQ(row["sha"], localTip);
        ASSERT_TRUE(ref.contains("upstream")) << ref.dump();
        EXPECT_EQ(ref["upstream"]["name"], "origin/main");
        EXPECT_EQ(ref["upstream"]["ahead"], 1);
        EXPECT_EQ(ref["upstream"]["behind"], 1);
      }
      if (ref["kind"] == "remote" && ref["name"] == "origin/main") {
        sawRemote = true;
        EXPECT_EQ(row["sha"], remoteTip);
      }
    }
  }
  EXPECT_TRUE(sawBranch);
  EXPECT_TRUE(sawRemote);  // remote tips are walked even when not local-reachable
}

TEST(GraphService, UnbornHeadAndBadParams) {
  struct UnbornRepo {
    std::filesystem::path root;
    UnbornRepo() {
      root = std::filesystem::temp_directory_path() /
             ("gg-graph-unborn-" +
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

  Json result = graphRows(session, 10, repoId);
  EXPECT_TRUE(result["rows"].empty());
  EXPECT_FALSE(result.contains("nextCursor"));
  EXPECT_TRUE(result.contains("generation"));

  Json noLimit = session.request(req(11, "graph/rows", {{"repoId", repoId}}));
  EXPECT_EQ(noLimit["error"]["code"], -32602);
  Json badCursor = session.request(
      req(12, "graph/rows", {{"repoId", repoId}, {"limit", 10}, {"cursor", "!!!not-base64!!!"}}));
  EXPECT_EQ(badCursor["error"]["code"], -32602);
}

}  // namespace
}  // namespace gg
