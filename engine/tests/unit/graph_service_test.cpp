// End-to-end tests for graph/rows: golden lane layouts for canonical
// topologies (per docs/specs/commit-graph-lanes.md), determinism, paging,
// synthetic WIP/stash rows and refs decorations, driven through the full
// server loop the way the extension drives the engine.

#include <gtest/gtest.h>
#include <nlohmann/json.hpp>

#include <algorithm>
#include <chrono>
#include <cstdio>
#include <filesystem>
#include <set>
#include <sstream>
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
  //   c2       lane 0   lineOut
  //   c1       lane 0   lineIn, lineOut
  //   initial  lane 0   lineIn
  FixtureRepo fixture;
  commitTick(fixture, "c1", 1);
  commitTick(fixture, "c2", 2);

  InteractiveSession session;
  const std::string repoId = discoverRepo(session, fixture.root());
  Json result = graphRows(session, 10, repoId);

  expectLayout(result["rows"], {{rev(fixture, "HEAD"), 0, Json::array({edge(0, 0, "lineOut")})},
                                {rev(fixture, "HEAD~1"), 0,
                                 Json::array({edge(0, 0, "lineIn"), edge(0, 0, "lineOut")})},
                                {rev(fixture, "HEAD~2"), 0, Json::array({edge(0, 0, "lineIn")})}});
  EXPECT_FALSE(result.contains("nextCursor"));
  EXPECT_GT(result["refsFingerprint"].get<std::int64_t>(), 0);

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
  // The merged branch comes right below the merge, as in git log --graph.
  // Once m1 also leads to base, f1's lane moves into lane 0 (line 1->0).
  //
  //   M     lane 0   lineOut, branchOut 0->1
  //   f1    lane 1   lineIn, lineOut, line 0
  //   m1    lane 0   lineIn, lineOut, line 1->0
  //   base  lane 0   lineIn, lineOut
  //   init  lane 0   lineIn
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

  expectLayout(
      result["rows"],
      {{rev(fixture, "HEAD"), 0, Json::array({edge(0, 0, "lineOut"), edge(0, 1, "branchOut")})},
       {rev(fixture, "HEAD^2"), 1,
        Json::array({edge(1, 1, "lineIn"), edge(1, 1, "lineOut"), edge(0, 0, "line")})},
       {rev(fixture, "HEAD^1"), 0,
        Json::array({edge(0, 0, "lineIn"), edge(0, 0, "lineOut"), edge(1, 0, "line")})},
       {rev(fixture, "HEAD~2"), 0, Json::array({edge(0, 0, "lineIn"), edge(0, 0, "lineOut")})},
       {rev(fixture, "HEAD~3"), 0, Json::array({edge(0, 0, "lineIn")})}});
  EXPECT_EQ(result["rows"][0]["parents"].size(), 2u);
}

TEST(GraphService, CrissCrossLayoutGolden) {
  // initial -- base -- A -- CA (crossA)      CA = merge(A, B)
  //              \       \ /
  //               \       X
  //                \     / \ .
  //                 -- B -- CB (crossB, HEAD) CB = merge(B, A)
  //
  // CA's first parent A already has a lane to its left, so CA's lane joins
  // it at once; lane 0 passes straight through CA's row.
  //
  //   CB    lane 0   lineOut, branchOut 0->1
  //   CA    lane 2   branchOut 2->1, branchOut 2->0, line 0, line 1
  //   B     lane 0   lineIn, lineOut, line 1
  //   A     lane 1   lineIn, branchOut 1->0, line 0
  //   base  lane 0   lineIn, lineOut
  //   init  lane 0   lineIn
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

  expectLayout(
      result["rows"],
      {{rev(fixture, "crossB"), 0, Json::array({edge(0, 0, "lineOut"), edge(0, 1, "branchOut")})},
       {rev(fixture, "crossA"), 2,
        Json::array({edge(2, 1, "branchOut"), edge(2, 0, "branchOut"), edge(0, 0, "line"),
                     edge(1, 1, "line")})},
       {rev(fixture, "sideB"), 0,
        Json::array({edge(0, 0, "lineIn"), edge(0, 0, "lineOut"), edge(1, 1, "line")})},
       {rev(fixture, "sideA"), 1,
        Json::array({edge(1, 1, "lineIn"), edge(1, 0, "branchOut"), edge(0, 0, "line")})},
       {rev(fixture, "main"), 0, Json::array({edge(0, 0, "lineIn"), edge(0, 0, "lineOut")})},
       {rev(fixture, "main~1"), 0, Json::array({edge(0, 0, "lineIn")})}});
}

TEST(GraphService, OctopusLayoutGolden) {
  // initial -- base -- m1 -- M (HEAD, main)   M = merge(m1, c1, c2)
  //              \          //
  //               +-- c1 --/ (b1)
  //                \      /
  //                 c2 --- (b2)
  //
  // The last parent's branch comes first, then the next one, then the
  // first-parent line; lines leading to base fold leftwards as they meet.
  //
  //   M     lane 0   lineOut, branchOut 0->1, branchOut 0->2
  //   c2    lane 2   lineIn, lineOut, line 0, line 1
  //   c1    lane 1   lineIn, lineOut, line 0, line 2->1
  //   m1    lane 0   lineIn, lineOut, line 1->0
  //   base  lane 0   lineIn, lineOut
  //   init  lane 0   lineIn
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
      {{rev(fixture, "HEAD"), 0,
        Json::array({edge(0, 0, "lineOut"), edge(0, 1, "branchOut"), edge(0, 2, "branchOut")})},
       {rev(fixture, "b2"), 2,
        Json::array(
            {edge(2, 2, "lineIn"), edge(2, 2, "lineOut"), edge(0, 0, "line"), edge(1, 1, "line")})},
       {rev(fixture, "b1"), 1,
        Json::array(
            {edge(1, 1, "lineIn"), edge(1, 1, "lineOut"), edge(0, 0, "line"), edge(2, 1, "line")})},
       {rev(fixture, "HEAD^1"), 0,
        Json::array({edge(0, 0, "lineIn"), edge(0, 0, "lineOut"), edge(1, 0, "line")})},
       {rev(fixture, "HEAD~2"), 0, Json::array({edge(0, 0, "lineIn"), edge(0, 0, "lineOut")})},
       {rev(fixture, "HEAD~3"), 0, Json::array({edge(0, 0, "lineIn")})}});
}

TEST(GraphService, ConcurrentBranchesLayoutGolden) {
  // initial -- m1 -- m2 (HEAD, main)
  //        \ .
  //         f1 (feature)
  //
  // Topological order keeps main's commits together even though f1 is newer
  // than m1; f1's lane joins main's lane, which already leads to their
  // shared parent.
  //
  //   m2    lane 0   lineOut                     (t4)
  //   m1    lane 0   lineIn, lineOut             (t2)
  //   f1    lane 1   branchOut 1->0, line 0      (t3)
  //   init  lane 0   lineIn
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

  expectLayout(
      result["rows"],
      {{rev(fixture, "main"), 0, Json::array({edge(0, 0, "lineOut")})},
       {rev(fixture, "main~1"), 0, Json::array({edge(0, 0, "lineIn"), edge(0, 0, "lineOut")})},
       {rev(fixture, "feature"), 1, Json::array({edge(1, 0, "branchOut"), edge(0, 0, "line")})},
       {rev(fixture, "main~2"), 0, Json::array({edge(0, 0, "lineIn")})}});
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
  // stable refs fingerprint across pages.
  Json paged = Json::array();
  Json params = {{"limit", 2}};
  std::int64_t id = 20;
  int pages = 0;
  for (;;) {
    Json page = graphRows(session, ++id, repoId, params);
    ++pages;
    EXPECT_EQ(page["refsFingerprint"], first["refsFingerprint"]);
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
  EXPECT_NE(after["refsFingerprint"], before["refsFingerprint"]);
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
      root = gg::testing::makeTempDir("gg-graph-unborn-");
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
  EXPECT_TRUE(result.contains("refsFingerprint"));

  // An omitted limit falls back to the default page size.
  Json noLimit = session.request(req(11, "graph/rows", {{"repoId", repoId}}));
  EXPECT_TRUE(noLimit["result"]["rows"].empty());
  Json badCursor = session.request(
      req(12, "graph/rows", {{"repoId", repoId}, {"limit", 10}, {"cursor", "!!!not-base64!!!"}}));
  EXPECT_EQ(badCursor["error"]["code"], -32602);
}

// Lanes a row's edges reach at its top and at its bottom edge.
std::set<int> lanesAtTop(const Json& row) {
  std::set<int> lanes;
  for (const auto& e : row["laneEdges"]) {
    const std::string kind = e["kind"];
    if (kind == "lineIn" || kind == "mergeIn" || kind == "line")
      lanes.insert(e["fromLane"].get<int>());
  }
  return lanes;
}

std::set<int> lanesAtBottom(const Json& row) {
  std::set<int> lanes;
  for (const auto& e : row["laneEdges"]) {
    const std::string kind = e["kind"];
    if (kind == "lineOut" || kind == "branchOut" || kind == "line")
      lanes.insert(e["toLane"].get<int>());
  }
  return lanes;
}

// Every line that leaves a row at the bottom enters the next row at the top
// in the same lane, and nothing dangles at either end of the graph: the
// painter draws an unbroken graph from the edges alone.
void expectContinuous(const Json& rows) {
  ASSERT_FALSE(rows.empty());
  EXPECT_TRUE(lanesAtTop(rows[0]).empty()) << rows[0].dump();
  for (size_t i = 0; i + 1 < rows.size(); ++i) {
    EXPECT_EQ(lanesAtBottom(rows[i]), lanesAtTop(rows[i + 1]))
        << "between rows " << i << " and " << i + 1 << ":\n"
        << rows[i].dump() << "\n"
        << rows[i + 1].dump();
  }
  EXPECT_TRUE(lanesAtBottom(rows.back()).empty()) << rows.back().dump();
  for (const auto& row : rows) {
    // A row's top edges all end in its dot or pass through; its own lane
    // is never also a pass-through.
    for (const auto& e : row["laneEdges"]) {
      if (e["kind"] == "line") EXPECT_NE(e["fromLane"], row["lane"]) << row.dump();
    }
  }
}

// Builds criss-cross merges, an octopus merge, branches forked from older
// commits, a stash and a dirty working tree in one repository.
void buildTangledHistory(FixtureRepo& fixture) {
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
  fixture.run("git checkout -q main");
  fixture.run("git checkout -q -b b1");
  commitTick(fixture, "c1", 6);
  fixture.run("git checkout -q main");
  fixture.run("git checkout -q -b b2");
  commitTick(fixture, "c2", 7);
  fixture.run("git checkout -q main");
  commitTick(fixture, "m1", 8);
  octopusMergeTick(fixture, {"b1", "b2"}, 9);
  fixture.run("git branch stale main~1");
  commitTick(fixture, "m2", 10);
  fixture.run("git checkout -q -b late stale");
  commitTick(fixture, "late1", 11);
  fixture.run("git checkout -q main");
  fixture.writeFile("README.md", "fixture\nstashed\n");
  fixture.run("git stash push -q");
  fixture.writeFile("README.md", "fixture\ndirty\n");
}

TEST(GraphService, EdgesFormAnUnbrokenGraph) {
  FixtureRepo fixture;
  buildTangledHistory(fixture);

  InteractiveSession session;
  const std::string repoId = discoverRepo(session, fixture.root());
  const Json withSynthetic = {{"include", {{"stashes", true}, {"wip", true}}}};
  Json result = graphRows(session, 10, repoId, withSynthetic);
  const Json& rows = result["rows"];
  ASSERT_EQ(rows[0]["kind"], "wip");
  expectContinuous(rows);

  // Commits only: the same holds without the synthetic rows.
  expectContinuous(graphRows(session, 11, repoId)["rows"]);
}

// Commits come out in the order `git rev-list --topo-order` gives them.
TEST(GraphService, OrderMatchesGitTopoOrder) {
  FixtureRepo fixture;
  buildTangledHistory(fixture);

  InteractiveSession session;
  const std::string repoId = discoverRepo(session, fixture.root());
  Json result = graphRows(session, 10, repoId);
  std::vector<std::string> shas;
  for (const auto& row : result["rows"]) shas.push_back(row["sha"]);
  EXPECT_EQ(shas, gitLines(fixture.root(), "rev-list --topo-order --branches HEAD"));
}

// Topic branches developed side by side and merged one after another, the
// usual shape of an integration-heavy repository. Each topic is shown right
// below its merge and its lane joins the one leading to the common base, so
// the graph stays a few lanes wide however many topics there are.
TEST(GraphService, MergedTopicsReuseLanes) {
  constexpr int kTopics = 12;
  FixtureRepo fixture;
  commitTick(fixture, "base", 1);
  int tick = 2;
  for (int round = 0; round < 2; ++round) {
    for (int t = 0; t < kTopics; ++t) {
      const std::string branch = "topic" + std::to_string(t);
      fixture.run(round == 0 ? "git checkout -q -b " + branch + " main"
                             : "git checkout -q " + branch);
      commitTick(fixture, branch + " work " + std::to_string(round), tick++);
    }
  }
  fixture.run("git checkout -q main");
  for (int t = 0; t < kTopics; ++t) {
    mergeTick(fixture, "--no-ff --no-edit topic" + std::to_string(t), tick++);
  }

  InteractiveSession session;
  const std::string repoId = discoverRepo(session, fixture.root());
  Json rows = graphRows(session, 10, repoId)["rows"];
  expectContinuous(rows);
  int widest = 0;
  for (const auto& row : rows) {
    widest = std::max(widest, row["lane"].get<int>() + 1);
    for (const auto& e : row["laneEdges"]) {
      widest = std::max({widest, e["fromLane"].get<int>() + 1, e["toLane"].get<int>() + 1});
    }
  }
  EXPECT_LE(widest, 3) << rows.dump();
}

bool hasWipRow(InteractiveSession& session, std::int64_t id, const std::string& repoId) {
  Json rows = graphRows(session, id, repoId, {{"include", {{"stashes", false}, {"wip", true}}}});
  return !rows["rows"].empty() && rows["rows"][0]["kind"] == "wip";
}

// The WIP row follows git's verdict for files behind a clean filter: a new
// mtime alone (a touch, a checkout, a racy timestamp) is not a change.
TEST(GraphService, WipRowIgnoresTouchedFilteredFile) {
  FixtureRepo fixture;
  fixture.run("git config filter.scrub.clean \"sed -e s/SECRET/REDACTED/\"");
  fixture.run("git config filter.scrub.smudge cat");
  fixture.writeFile(".gitattributes", "*.env filter=scrub\n");
  fixture.writeFile("app.env", "token=SECRET\n");
  fixture.run("git add .gitattributes app.env");
  commitTick(fixture, "seed", 1);
  const auto file = fixture.root() / "app.env";
  std::filesystem::last_write_time(
      file, std::filesystem::last_write_time(file) + std::chrono::seconds(5));

  InteractiveSession session;
  const std::string repoId = discoverRepo(session, fixture.root());
  EXPECT_FALSE(hasWipRow(session, 10, repoId));

  fixture.writeFile("app.env", "token=SECRET\nport=2\n");
  EXPECT_TRUE(hasWipRow(session, 11, repoId));
}

// A new executable bit is a change git commits, whatever the content.
TEST(GraphService, WipRowKeepsModeChangeOfFilteredFile) {
#ifdef _WIN32
  GTEST_SKIP() << "Windows checkouts have no executable bit (core.fileMode=false)";
#endif
  FixtureRepo fixture;
  fixture.run("git config filter.scrub.clean \"sed -e s/SECRET/REDACTED/\"");
  fixture.run("git config filter.scrub.smudge cat");
  fixture.writeFile(".gitattributes", "*.env filter=scrub\n");
  fixture.writeFile("app.env", "token=SECRET\n");
  fixture.run("git add .gitattributes app.env");
  commitTick(fixture, "seed", 1);
  std::filesystem::permissions(fixture.root() / "app.env", std::filesystem::perms::owner_exec,
                               std::filesystem::perm_options::add);

  InteractiveSession session;
  const std::string repoId = discoverRepo(session, fixture.root());
  EXPECT_TRUE(hasWipRow(session, 10, repoId));
}

// Out-of-cone files of a sparse checkout are absent by design.
TEST(GraphService, WipRowIgnoresSparseCheckoutExclusions) {
  FixtureRepo fixture;
  fixture.writeFile("keep/k.txt", "keep\n");
  fixture.writeFile("other/f1.txt", "one\n");
  fixture.run("git add keep other");
  commitTick(fixture, "seed", 1);
  fixture.run("git sparse-checkout set --cone keep");

  InteractiveSession session;
  const std::string repoId = discoverRepo(session, fixture.root());
  EXPECT_FALSE(hasWipRow(session, 10, repoId));

  fixture.writeFile("keep/k.txt", "keep\nedited\n");
  EXPECT_TRUE(hasWipRow(session, 11, repoId));
}

// Edits inside a submodule are the submodule's to commit; the parent only
// changes when the submodule's commit does.
TEST(GraphService, WipRowIgnoresSubmoduleLocalEdits) {
  FixtureRepo library;
  library.writeFile("lib.txt", "one\n");
  library.run("git add lib.txt");
  commitTick(library, "lib one", 1);

  FixtureRepo fixture;
  fixture.run("git -c protocol.file.allow=always submodule --quiet add \"" +
              library.root().generic_string() + "\" sub");
  commitTick(fixture, "add submodule", 2);
  fixture.writeFile("sub/lib.txt", "one\nlocal\n");

  InteractiveSession session;
  const std::string repoId = discoverRepo(session, fixture.root());
  EXPECT_FALSE(hasWipRow(session, 10, repoId));

  gg::testing::runGit(fixture.root() / "sub",
                      "git -c user.name=F -c user.email=f@example.invalid commit -q -a -m local");
  EXPECT_TRUE(hasWipRow(session, 11, repoId));
}

}  // namespace
}  // namespace gg
