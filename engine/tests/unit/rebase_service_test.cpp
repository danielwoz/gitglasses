// End-to-end tests for rebase/preview|start|continue|abort. rebase/start
// drives a real `git rebase -i` whose sequence/message editors are this test
// binary's shim modes (see test_main.cpp).

#include <gtest/gtest.h>
#include <nlohmann/json.hpp>

#include <cstdio>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <string>

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

std::string rev(const std::filesystem::path& root, const std::string& spec) {
  std::string sha = gg::testing::gitCapture(root, "rev-parse " + spec, /*quiet=*/true);
  while (!sha.empty() && sha.back() == '\n') sha.pop_back();
  return sha;
}

std::string slurp(const std::filesystem::path& file) {
  std::ifstream in(file, std::ios::binary);
  std::ostringstream buffer;
  buffer << in.rdbuf();
  return buffer.str();
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

// Subjects of base..HEAD, oldest first (the same order rebase plans use).
std::string subjects(const std::filesystem::path& root, const std::string& base) {
  return gitOut(root, "log --reverse --format=%s " + base + "..HEAD");
}

struct Seeded {
  std::string base, c1, c2, c3;
};

// Three commits touching distinct files: any reorder is conflict-free.
Seeded seedDistinct(FixtureRepo& fixture) {
  Seeded shas;
  shas.base = rev(fixture.root(), "HEAD");
  fixture.writeFile("a.txt", "A\n");
  fixture.run("git add a.txt");
  commitTick(fixture, "c1", 1);
  shas.c1 = rev(fixture.root(), "HEAD");
  fixture.writeFile("b.txt", "B\n");
  fixture.run("git add b.txt");
  commitTick(fixture, "c2", 2);
  shas.c2 = rev(fixture.root(), "HEAD");
  fixture.writeFile("c.txt", "C\n");
  fixture.run("git add c.txt");
  commitTick(fixture, "c3", 3);
  shas.c3 = rev(fixture.root(), "HEAD");
  return shas;
}

// Three commits rewriting the same line: dropping/reordering conflicts.
Seeded seedConflicting(FixtureRepo& fixture) {
  Seeded shas;
  shas.base = rev(fixture.root(), "HEAD");
  const char* contents[] = {"one\n", "two\n", "three\n"};
  std::string* out[] = {&shas.c1, &shas.c2, &shas.c3};
  for (int i = 0; i < 3; ++i) {
    fixture.writeFile("f.txt", contents[i]);
    fixture.run("git add f.txt");
    commitTick(fixture, "c" + std::to_string(i + 1), i + 1);
    *out[i] = rev(fixture.root(), "HEAD");
  }
  return shas;
}

Json entry(const std::string& action, const std::string& sha, const std::string& summary,
           const std::string& message = "") {
  Json value = {{"action", action}, {"sha", sha}, {"summary", summary}};
  if (!message.empty()) value["message"] = message;
  return value;
}

TEST(RebaseService, PreviewListsUpstreamToHeadOldestFirst) {
  FixtureRepo fixture;
  const Seeded shas = seedDistinct(fixture);
  InteractiveSession session;
  const std::string repoId = discoverRepo(session, fixture.root());

  Json preview = session.request(
      req(10, "rebase/preview", {{"repoId", repoId}, {"upstream", shas.base}}));
  ASSERT_TRUE(preview.contains("result")) << preview.dump();
  const Json& entries = preview["result"]["entries"];
  ASSERT_EQ(entries.size(), 3u) << preview.dump();
  EXPECT_EQ(entries[0], Json({{"sha", shas.c1}, {"summary", "c1"}}));
  EXPECT_EQ(entries[1], Json({{"sha", shas.c2}, {"summary", "c2"}}));
  EXPECT_EQ(entries[2], Json({{"sha", shas.c3}, {"summary", "c3"}}));

  Json empty = session.request(
      req(11, "rebase/preview", {{"repoId", repoId}, {"upstream", "HEAD"}}));
  EXPECT_TRUE(empty["result"]["entries"].empty());

  Json bad = session.request(
      req(12, "rebase/preview", {{"repoId", repoId}, {"upstream", "no-such-ref"}}));
  EXPECT_EQ(bad["error"]["code"], -32001);
}

TEST(RebaseService, StartReordersCommits) {
  FixtureRepo fixture;
  const Seeded shas = seedDistinct(fixture);
  InteractiveSession session;
  const std::string repoId = discoverRepo(session, fixture.root());

  Json start = session.request(req(10, "rebase/start",
                                   {{"repoId", repoId},
                                    {"upstream", shas.base},
                                    {"plan", Json::array({entry("pick", shas.c2, "c2"),
                                                          entry("pick", shas.c1, "c1"),
                                                          entry("pick", shas.c3, "c3")})}}));
  ASSERT_TRUE(start.contains("result")) << start.dump();
  EXPECT_TRUE(start["result"]["completed"].get<bool>());
  EXPECT_FALSE(start["result"]["conflicts"].get<bool>());
  EXPECT_EQ(subjects(fixture.root(), shas.base), "c2\nc1\nc3\n");
  EXPECT_TRUE(std::filesystem::exists(fixture.root() / "a.txt"));
  EXPECT_TRUE(std::filesystem::exists(fixture.root() / "b.txt"));
  EXPECT_TRUE(std::filesystem::exists(fixture.root() / "c.txt"));
}

TEST(RebaseService, StartSquashCombinesWithMessage) {
  FixtureRepo fixture;
  const Seeded shas = seedDistinct(fixture);
  InteractiveSession session;
  const std::string repoId = discoverRepo(session, fixture.root());

  Json start = session.request(
      req(10, "rebase/start",
          {{"repoId", repoId},
           {"upstream", shas.base},
           {"plan", Json::array({entry("pick", shas.c1, "c1"),
                                 entry("squash", shas.c2, "c2", "c1 and c2 combined"),
                                 entry("pick", shas.c3, "c3")})}}));
  ASSERT_TRUE(start.contains("result")) << start.dump();
  EXPECT_TRUE(start["result"]["completed"].get<bool>());
  EXPECT_EQ(subjects(fixture.root(), shas.base), "c1 and c2 combined\nc3\n");
  EXPECT_TRUE(std::filesystem::exists(fixture.root() / "a.txt"));
  EXPECT_TRUE(std::filesystem::exists(fixture.root() / "b.txt"));
}

TEST(RebaseService, StartRewordChangesMessage) {
  FixtureRepo fixture;
  const Seeded shas = seedDistinct(fixture);
  InteractiveSession session;
  const std::string repoId = discoverRepo(session, fixture.root());

  Json start = session.request(
      req(10, "rebase/start",
          {{"repoId", repoId},
           {"upstream", shas.base},
           {"plan", Json::array({entry("reword", shas.c1, "c1", "c1 reworded"),
                                 entry("pick", shas.c2, "c2"),
                                 entry("pick", shas.c3, "c3")})}}));
  ASSERT_TRUE(start.contains("result")) << start.dump();
  EXPECT_TRUE(start["result"]["completed"].get<bool>());
  EXPECT_EQ(subjects(fixture.root(), shas.base), "c1 reworded\nc2\nc3\n");
  EXPECT_EQ(slurp(fixture.root() / "a.txt"), "A\n");  // contents untouched
}

TEST(RebaseService, StartFixupKeepsFirstMessage) {
  FixtureRepo fixture;
  const Seeded shas = seedDistinct(fixture);
  InteractiveSession session;
  const std::string repoId = discoverRepo(session, fixture.root());

  Json start = session.request(req(10, "rebase/start",
                                   {{"repoId", repoId},
                                    {"upstream", shas.base},
                                    {"plan", Json::array({entry("pick", shas.c1, "c1"),
                                                          entry("fixup", shas.c2, "c2"),
                                                          entry("pick", shas.c3, "c3")})}}));
  ASSERT_TRUE(start.contains("result")) << start.dump();
  EXPECT_TRUE(start["result"]["completed"].get<bool>());
  EXPECT_EQ(subjects(fixture.root(), shas.base), "c1\nc3\n");
  EXPECT_TRUE(std::filesystem::exists(fixture.root() / "b.txt"));  // c2's change kept
}

TEST(RebaseService, StartDropRemovesCommit) {
  FixtureRepo fixture;
  const Seeded shas = seedDistinct(fixture);
  InteractiveSession session;
  const std::string repoId = discoverRepo(session, fixture.root());

  Json start = session.request(req(10, "rebase/start",
                                   {{"repoId", repoId},
                                    {"upstream", shas.base},
                                    {"plan", Json::array({entry("pick", shas.c1, "c1"),
                                                          entry("drop", shas.c2, "c2"),
                                                          entry("pick", shas.c3, "c3")})}}));
  ASSERT_TRUE(start.contains("result")) << start.dump();
  EXPECT_TRUE(start["result"]["completed"].get<bool>());
  EXPECT_EQ(subjects(fixture.root(), shas.base), "c1\nc3\n");
  EXPECT_FALSE(std::filesystem::exists(fixture.root() / "b.txt"));
  EXPECT_TRUE(std::filesystem::exists(fixture.root() / "a.txt"));
  EXPECT_TRUE(std::filesystem::exists(fixture.root() / "c.txt"));
}

// A plan made before a commit landed on the branch does not list it; replaying
// it anyway would silently drop that commit.
TEST(RebaseService, StartRefusesAPlanThatPredatesANewCommit) {
  FixtureRepo fixture;
  const Seeded shas = seedDistinct(fixture);
  InteractiveSession session;
  const std::string repoId = discoverRepo(session, fixture.root());

  Json preview =
      session.request(req(10, "rebase/preview", {{"repoId", repoId}, {"upstream", shas.base}}));
  ASSERT_TRUE(preview.contains("result")) << preview.dump();
  EXPECT_EQ(preview["result"]["headSha"], shas.c3);
  EXPECT_EQ(preview["result"]["upstreamSha"], shas.base);

  fixture.writeFile("d.txt", "D\n");
  fixture.run("git add d.txt");
  commitTick(fixture, "c4 committed after the plan", 4);
  const std::string c4 = rev(fixture.root(), "HEAD");
  const Json plan = Json::array({entry("reword", shas.c1, "c1", "c1 reworded"),
                                 entry("pick", shas.c2, "c2"), entry("pick", shas.c3, "c3")});

  // Without the preview's shas the sequence editor still notices.
  Json start = session.request(
      req(11, "rebase/start", {{"repoId", repoId}, {"upstream", shas.base}, {"plan", plan}}));
  ASSERT_TRUE(start.contains("error")) << start.dump();
  EXPECT_EQ(start["error"]["code"], -32001);
  const std::string message = start["error"]["message"];
  EXPECT_NE(message.find("c4 committed after the plan"), std::string::npos) << message;
  EXPECT_NE(message.find("Reload the plan"), std::string::npos) << message;
  EXPECT_EQ(rev(fixture.root(), "HEAD"), c4);
  EXPECT_FALSE(std::filesystem::exists(fixture.root() / ".git/rebase-merge"));

  // With them the engine refuses before running git at all.
  Json guarded = session.request(req(12, "rebase/start",
                                     {{"repoId", repoId},
                                      {"upstream", shas.base},
                                      {"plan", plan},
                                      {"expectedHead", shas.c3},
                                      {"expectedUpstream", shas.base}}));
  ASSERT_TRUE(guarded.contains("error")) << guarded.dump();
  EXPECT_NE(guarded["error"]["message"].get<std::string>().find("the branch moved"),
            std::string::npos)
      << guarded.dump();
  EXPECT_EQ(subjects(fixture.root(), shas.base), "c1\nc2\nc3\nc4 committed after the plan\n");
}

TEST(RebaseService, StartRefusesWhenTheUpstreamMoved) {
  FixtureRepo fixture;
  const Seeded shas = seedDistinct(fixture);
  fixture.run("git branch target " + shas.base);
  InteractiveSession session;
  const std::string repoId = discoverRepo(session, fixture.root());

  Json start = session.request(
      req(10, "rebase/start",
          {{"repoId", repoId},
           {"upstream", "target"},
           {"plan", Json::array({entry("pick", shas.c1, "c1"), entry("pick", shas.c2, "c2"),
                                 entry("pick", shas.c3, "c3")})},
           {"expectedHead", shas.c3},
           {"expectedUpstream", shas.c1}}));
  ASSERT_TRUE(start.contains("error")) << start.dump();
  EXPECT_NE(start["error"]["message"].get<std::string>().find("'target' moved"), std::string::npos)
      << start.dump();
  EXPECT_EQ(rev(fixture.root(), "HEAD"), shas.c3);
}

TEST(RebaseService, StartRefusesWhileARebaseIsInProgress) {
  FixtureRepo fixture;
  const Seeded shas = seedConflicting(fixture);
  InteractiveSession session;
  const std::string repoId = discoverRepo(session, fixture.root());
  const Json plan = Json::array(
      {entry("pick", shas.c1, "c1"), entry("drop", shas.c2, "c2"), entry("pick", shas.c3, "c3")});

  Json first = session.request(
      req(10, "rebase/start", {{"repoId", repoId}, {"upstream", shas.base}, {"plan", plan}}));
  ASSERT_TRUE(first["result"]["conflicts"].get<bool>()) << first.dump();

  Json second = session.request(
      req(11, "rebase/start", {{"repoId", repoId}, {"upstream", shas.base}, {"plan", plan}}));
  ASSERT_TRUE(second.contains("error")) << second.dump();
  EXPECT_NE(second["error"]["message"].get<std::string>().find("already in progress"),
            std::string::npos)
      << second.dump();
  session.request(req(12, "rebase/abort", {{"repoId", repoId}}));
}

// Messages belong to commits: a squash that keeps git's message must not use
// up the message written for a later reword.
TEST(RebaseService, SquashWithoutMessageThenRewordKeepsEachMessageOnItsCommit) {
  FixtureRepo fixture;
  const Seeded shas = seedDistinct(fixture);
  InteractiveSession session;
  const std::string repoId = discoverRepo(session, fixture.root());

  Json start = session.request(
      req(10, "rebase/start",
          {{"repoId", repoId},
           {"upstream", shas.base},
           {"plan", Json::array({entry("pick", shas.c1, "c1"), entry("squash", shas.c2, "c2"),
                                 entry("reword", shas.c3, "c3", "c3 reworded")})}}));
  ASSERT_TRUE(start.contains("result")) << start.dump();
  EXPECT_TRUE(start["result"]["completed"].get<bool>());
  // git's combined message keeps both subjects; c3 carries its new one.
  EXPECT_EQ(gitOut(fixture.root(), "log -1 --format=%B HEAD~1"), "c1\n\nc2\n\n");
  EXPECT_EQ(gitOut(fixture.root(), "log -1 --format=%s HEAD"), "c3 reworded\n");
  EXPECT_EQ(gitOut(fixture.root(), "show --format= --name-only HEAD"), "c.txt\n");
}

// After a stop, continue still applies the plan's later messages.
TEST(RebaseService, RewordAfterAConflictStillGetsItsMessage) {
  FixtureRepo fixture;
  const Seeded shas = seedConflicting(fixture);
  fixture.writeFile("g.txt", "G\n");
  fixture.run("git add g.txt");
  commitTick(fixture, "c4", 4);
  const std::string c4 = rev(fixture.root(), "HEAD");
  InteractiveSession session;
  const std::string repoId = discoverRepo(session, fixture.root());

  Json start = session.request(req(
      10, "rebase/start",
      {{"repoId", repoId},
       {"upstream", shas.base},
       {"plan",
        Json::array({entry("pick", shas.c1, "c1"), entry("drop", shas.c2, "c2"),
                     entry("pick", shas.c3, "c3"), entry("reword", c4, "c4", "c4 reworded")})}}));
  ASSERT_TRUE(start["result"]["conflicts"].get<bool>()) << start.dump();

  fixture.writeFile("f.txt", "three\n");
  fixture.run("git add f.txt");
  Json cont = session.request(req(11, "rebase/continue", {{"repoId", repoId}}));
  ASSERT_TRUE(cont.contains("result")) << cont.dump();
  EXPECT_TRUE(cont["result"]["completed"].get<bool>()) << cont.dump();
  EXPECT_EQ(subjects(fixture.root(), shas.base), "c1\nc3\nc4 reworded\n");
}

// git strips message lines that start with its comment character; a message
// whose subject is an issue reference must survive.
TEST(RebaseService, RewordMessageStartingWithHashIsKept) {
  FixtureRepo fixture;
  const Seeded shas = seedDistinct(fixture);
  InteractiveSession session;
  const std::string repoId = discoverRepo(session, fixture.root());

  Json start = session.request(
      req(10, "rebase/start",
          {{"repoId", repoId},
           {"upstream", shas.base},
           {"plan", Json::array({entry("reword", shas.c1, "c1", "#123 fix the parser\n\n#body"),
                                 entry("pick", shas.c2, "c2"), entry("pick", shas.c3, "c3")})}}));
  ASSERT_TRUE(start.contains("result")) << start.dump();
  EXPECT_TRUE(start["result"]["completed"].get<bool>());
  EXPECT_EQ(gitOut(fixture.root(), "log -1 --format=%B HEAD~2"),
            "#123 fix the parser\n\n#body\n\n");
}

TEST(RebaseService, ConflictReportsAndAbortRestoresHead) {
  FixtureRepo fixture;
  const Seeded shas = seedConflicting(fixture);
  InteractiveSession session;
  const std::string repoId = discoverRepo(session, fixture.root());

  // Dropping c2 makes c3 (two -> three) apply onto "one": conflict.
  Json start = session.request(
      req(10, "rebase/start",
          {{"repoId", repoId},
           {"upstream", shas.base},
           {"plan", Json::array({entry("pick", shas.c1, "c1"), entry("drop", shas.c2, "c2"),
                                 entry("pick", shas.c3, "c3")})}}));
  ASSERT_TRUE(start.contains("result")) << start.dump();
  EXPECT_FALSE(start["result"]["completed"].get<bool>());
  EXPECT_TRUE(start["result"]["conflicts"].get<bool>());
  EXPECT_TRUE(std::filesystem::exists(fixture.root() / ".git/rebase-merge"));
  Json summary = session.request(req(11, "status/summary", {{"repoId", repoId}}));
  EXPECT_EQ(summary["result"]["conflicted"], Json::array({"f.txt"}));

  Json abort = session.request(req(12, "rebase/abort", {{"repoId", repoId}}));
  ASSERT_TRUE(abort.contains("result")) << abort.dump();
  EXPECT_EQ(rev(fixture.root(), "HEAD"), shas.c3);  // original tip restored
  EXPECT_FALSE(std::filesystem::exists(fixture.root() / ".git/rebase-merge"));
  EXPECT_EQ(slurp(fixture.root() / "f.txt"), "three\n");
}

// A paused rebase leaves HEAD detached, so HEAD alone cannot tell a client
// what the repository is doing; repo/state carries the sequencer state.
TEST(RebaseService, RepoStateReportsThePausedRebase) {
  FixtureRepo fixture;
  const Seeded shas = seedConflicting(fixture);
  InteractiveSession session;
  const std::string repoId = discoverRepo(session, fixture.root());

  Json idle = session.request(req(10, "repo/state", {{"repoId", repoId}}));
  EXPECT_EQ(idle["result"]["sequencer"]["operation"], "none");
  EXPECT_FALSE(idle["result"]["sequencer"]["conflicted"].get<bool>());

  Json start = session.request(
      req(11, "rebase/start",
          {{"repoId", repoId},
           {"upstream", shas.base},
           {"plan", Json::array({entry("pick", shas.c1, "c1"), entry("drop", shas.c2, "c2"),
                                 entry("pick", shas.c3, "c3")})}}));
  ASSERT_TRUE(start["result"]["conflicts"].get<bool>()) << start.dump();

  Json state = session.request(req(12, "repo/state", {{"repoId", repoId}}));
  ASSERT_TRUE(state.contains("result")) << state.dump();
  const Json& sequencer = state["result"]["sequencer"];
  EXPECT_TRUE(state["result"]["head"]["detached"].get<bool>());
  EXPECT_EQ(sequencer["operation"], "rebase");
  EXPECT_TRUE(sequencer["conflicted"].get<bool>());
  // git counts the explicit drop of c2, which runs last, as a step too.
  EXPECT_EQ(sequencer["step"], 2);
  EXPECT_EQ(sequencer["total"], 3);

  session.request(req(13, "rebase/abort", {{"repoId", repoId}}));
  Json after = session.request(req(14, "repo/state", {{"repoId", repoId}}));
  EXPECT_EQ(after["result"]["sequencer"]["operation"], "none");
  EXPECT_FALSE(after["result"]["sequencer"]["conflicted"].get<bool>());
}

TEST(RebaseService, ConflictResolveAndContinueCompletes) {
  FixtureRepo fixture;
  const Seeded shas = seedConflicting(fixture);
  InteractiveSession session;
  const std::string repoId = discoverRepo(session, fixture.root());

  Json start = session.request(
      req(10, "rebase/start",
          {{"repoId", repoId},
           {"upstream", shas.base},
           {"plan", Json::array({entry("pick", shas.c1, "c1"), entry("drop", shas.c2, "c2"),
                                 entry("pick", shas.c3, "c3")})}}));
  ASSERT_TRUE(start.contains("result")) << start.dump();
  EXPECT_TRUE(start["result"]["conflicts"].get<bool>());

  // Unresolved continue is still a conflicted stop, not an error.
  Json premature = session.request(req(11, "rebase/continue", {{"repoId", repoId}}));
  ASSERT_TRUE(premature.contains("result")) << premature.dump();
  EXPECT_FALSE(premature["result"]["completed"].get<bool>());
  EXPECT_TRUE(premature["result"]["conflicts"].get<bool>());

  fixture.writeFile("f.txt", "three\n");
  fixture.run("git add f.txt");
  Json cont = session.request(req(12, "rebase/continue", {{"repoId", repoId}}));
  ASSERT_TRUE(cont.contains("result")) << cont.dump();
  EXPECT_TRUE(cont["result"]["completed"].get<bool>());
  EXPECT_FALSE(cont["result"]["conflicts"].get<bool>());
  EXPECT_EQ(subjects(fixture.root(), shas.base), "c1\nc3\n");
  EXPECT_EQ(slurp(fixture.root() / "f.txt"), "three\n");
  EXPECT_FALSE(std::filesystem::exists(fixture.root() / ".git/rebase-merge"));
}

TEST(RebaseService, ContinueOrAbortWithoutRebaseFails) {
  FixtureRepo fixture;
  InteractiveSession session;
  const std::string repoId = discoverRepo(session, fixture.root());

  Json cont = session.request(req(10, "rebase/continue", {{"repoId", repoId}}));
  EXPECT_EQ(cont["error"]["code"], -32001);
  Json abort = session.request(req(11, "rebase/abort", {{"repoId", repoId}}));
  EXPECT_EQ(abort["error"]["code"], -32001);
}

TEST(RebaseService, MalformedPlansFailSafely) {
  FixtureRepo fixture;
  const Seeded shas = seedDistinct(fixture);
  InteractiveSession session;
  const std::string repoId = discoverRepo(session, fixture.root());

  // Unknown action never reaches git.
  Json badAction = session.request(
      req(10, "rebase/start",
          {{"repoId", repoId},
           {"upstream", shas.base},
           {"plan", Json::array({entry("explode", shas.c1, "c1")})}}));
  EXPECT_EQ(badAction["error"]["code"], -32602);

  // A sha git did not offer makes the sequence editor abort before any
  // commit is touched.
  Json unknownSha = session.request(
      req(11, "rebase/start",
          {{"repoId", repoId},
           {"upstream", shas.base},
           {"plan",
            Json::array({entry("pick", "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef", "x")})}}));
  EXPECT_EQ(unknownSha["error"]["code"], -32001);
  EXPECT_EQ(rev(fixture.root(), "HEAD"), shas.c3);  // repo untouched
  EXPECT_FALSE(std::filesystem::exists(fixture.root() / ".git/rebase-merge"));

  Json noPlan = session.request(
      req(12, "rebase/start", {{"repoId", repoId}, {"upstream", shas.base}}));
  EXPECT_EQ(noPlan["error"]["code"], -32602);
}

// The plan as rebase/preview returns it, every commit picked.
Json previewPlan(InteractiveSession& session, std::int64_t id, const std::string& repoId,
                 const std::string& upstream) {
  Json preview =
      session.request(req(id, "rebase/preview", {{"repoId", repoId}, {"upstream", upstream}}));
  Json plan = Json::array();
  for (const auto& e : preview["result"]["entries"]) {
    plan.push_back(entry("pick", e["sha"], e["summary"]));
  }
  return plan;
}

TEST(RebaseService, EmptyPlanIsRejected) {
  FixtureRepo fixture;
  const Seeded shas = seedDistinct(fixture);
  InteractiveSession session;
  const std::string repoId = discoverRepo(session, fixture.root());

  Json start = session.request(req(
      10, "rebase/start", {{"repoId", repoId}, {"upstream", shas.base}, {"plan", Json::array()}}));
  EXPECT_EQ(start["error"]["code"], -32602) << start.dump();
  EXPECT_EQ(rev(fixture.root(), "HEAD"), shas.c3);
}

// git leaves merges out of the todo; the preview must list exactly what git
// will replay, or starting the plan fails.
TEST(RebaseService, PreviewLeavesOutMergesAndCommitsAlreadyUpstream) {
  FixtureRepo fixture;
  const std::string base = rev(fixture.root(), "HEAD");
  fixture.run("git branch upstream");
  fixture.run("git checkout -q -b feature");
  fixture.writeFile("feat.txt", "feat\n");
  fixture.run("git add feat.txt");
  commitTick(fixture, "feat 1", 1);
  fixture.run("git checkout -q main");
  fixture.writeFile("main.txt", "main\n");
  fixture.run("git add main.txt");
  commitTick(fixture, "main 1", 2);
  fixture.runAt("@1700000180 +0000", "git merge -q --no-ff --no-edit feature");
  fixture.writeFile("shared.txt", "shared\n");
  fixture.run("git add shared.txt");
  commitTick(fixture, "already upstream", 4);
  fixture.writeFile("main2.txt", "main 2\n");
  fixture.run("git add main2.txt");
  commitTick(fixture, "main 2", 5);
  // The upstream gains the same change as "already upstream".
  fixture.run("git checkout -q upstream");
  fixture.writeFile("shared.txt", "shared\n");
  fixture.run("git add shared.txt");
  commitTick(fixture, "shared upstream", 6);
  fixture.run("git checkout -q main");

  InteractiveSession session;
  const std::string repoId = discoverRepo(session, fixture.root());
  Json preview =
      session.request(req(10, "rebase/preview", {{"repoId", repoId}, {"upstream", "upstream"}}));
  ASSERT_TRUE(preview.contains("result")) << preview.dump();
  std::string listed;
  for (const auto& e : preview["result"]["entries"])
    listed += e["summary"].get<std::string>() + ",";
  EXPECT_EQ(listed, "main 1,feat 1,main 2,");
  EXPECT_EQ(preview["result"]["mergeCount"], 1);
  EXPECT_NE(preview["result"]["upstreamSha"].get<std::string>(), base);

  Json start = session.request(req(11, "rebase/start",
                                   {{"repoId", repoId},
                                    {"upstream", "upstream"},
                                    {"plan", previewPlan(session, 12, repoId, "upstream")}}));
  ASSERT_TRUE(start.contains("result")) << start.dump();
  EXPECT_TRUE(start["result"]["completed"].get<bool>());
  EXPECT_EQ(subjects(fixture.root(), "upstream"), "main 1\nfeat 1\nmain 2\n");
  for (const char* file : {"feat.txt", "main.txt", "main2.txt", "shared.txt"}) {
    EXPECT_TRUE(std::filesystem::exists(fixture.root() / file)) << file;
  }
}

// Stacked branches inside the range follow their commits, abbreviated todo
// commands are read, and dropped commits satisfy git's missing-commit check.
TEST(RebaseService, StartWorksWithCommonRebaseConfig) {
  FixtureRepo fixture;
  const Seeded shas = seedDistinct(fixture);
  fixture.run("git branch stack-mid " + shas.c2);
  fixture.run("git config rebase.updateRefs true");
  fixture.run("git config rebase.abbreviateCommands true");
  fixture.run("git config rebase.missingCommitsCheck error");
  InteractiveSession session;
  const std::string repoId = discoverRepo(session, fixture.root());

  Json start = session.request(
      req(10, "rebase/start",
          {{"repoId", repoId},
           {"upstream", shas.base},
           {"plan", Json::array({entry("reword", shas.c1, "c1", "c1 reworded"),
                                 entry("drop", shas.c2, "c2"), entry("pick", shas.c3, "c3")})}}));
  ASSERT_TRUE(start.contains("result")) << start.dump();
  EXPECT_TRUE(start["result"]["completed"].get<bool>()) << start.dump();
  EXPECT_EQ(subjects(fixture.root(), shas.base), "c1 reworded\nc3\n");
  // stack-mid pointed at the dropped c2, so it now points at the commit
  // before it.
  EXPECT_EQ(rev(fixture.root(), "stack-mid"), rev(fixture.root(), "HEAD~1"));
}

TEST(RebaseService, StartKeepsThePlanOrderUnderAutosquash) {
  FixtureRepo fixture;
  const Seeded shas = seedDistinct(fixture);
  fixture.writeFile("a.txt", "A2\n");
  fixture.run("git add a.txt");
  commitTick(fixture, "fixup! c1", 4);
  fixture.run("git config rebase.autoSquash true");
  InteractiveSession session;
  const std::string repoId = discoverRepo(session, fixture.root());

  Json start = session.request(req(10, "rebase/start",
                                   {{"repoId", repoId},
                                    {"upstream", shas.base},
                                    {"plan", previewPlan(session, 11, repoId, shas.base)}}));
  ASSERT_TRUE(start.contains("result")) << start.dump();
  EXPECT_TRUE(start["result"]["completed"].get<bool>()) << start.dump();
  EXPECT_EQ(subjects(fixture.root(), shas.base), "c1\nc2\nc3\nfixup! c1\n");
}

TEST(RebaseService, AutoStashRebasesOverUncommittedChanges) {
  FixtureRepo fixture;
  const Seeded shas = seedDistinct(fixture);
  fixture.writeFile("README.md", "uncommitted\n");
  InteractiveSession session;
  const std::string repoId = discoverRepo(session, fixture.root());
  const Json plan = Json::array({entry("reword", shas.c1, "c1", "c1 reworded"),
                                 entry("pick", shas.c2, "c2"), entry("pick", shas.c3, "c3")});

  // Without it, git's whole explanation comes back.
  Json refused = session.request(
      req(10, "rebase/start", {{"repoId", repoId}, {"upstream", shas.base}, {"plan", plan}}));
  ASSERT_TRUE(refused.contains("error")) << refused.dump();
  const std::string message = refused["error"]["message"];
  EXPECT_NE(message.find("You have unstaged changes"), std::string::npos) << message;
  EXPECT_NE(message.find("commit or stash them"), std::string::npos) << message;

  Json start = session.request(
      req(11, "rebase/start",
          {{"repoId", repoId}, {"upstream", shas.base}, {"plan", plan}, {"autoStash", true}}));
  ASSERT_TRUE(start.contains("result")) << start.dump();
  EXPECT_TRUE(start["result"]["completed"].get<bool>());
  EXPECT_FALSE(start["result"].contains("autoStashKept")) << start.dump();
  EXPECT_EQ(subjects(fixture.root(), shas.base), "c1 reworded\nc2\nc3\n");
  EXPECT_EQ(slurp(fixture.root() / "README.md"), "uncommitted\n");
  EXPECT_EQ(gitOut(fixture.root(), "stash list"), "");
}

// When the rebased branch changes a file the stashed changes also touch, git
// cannot re-apply them: it finishes the rebase, leaves the conflict in the
// working tree and keeps the changes as stash@{0}. That is not a plain
// completion.
TEST(RebaseService, AutoStashThatCannotBeRestoredIsReported) {
  FixtureRepo fixture;
  fixture.run("git branch upstream");
  const Seeded shas = seedDistinct(fixture);
  fixture.run("git checkout -q upstream");
  fixture.writeFile("README.md", "upstream change\n");
  fixture.run("git add README.md");
  commitTick(fixture, "upstream edit", 4);
  fixture.run("git checkout -q -");
  fixture.writeFile("README.md", "my uncommitted edit\n");
  InteractiveSession session;
  const std::string repoId = discoverRepo(session, fixture.root());

  Json start = session.request(
      req(10, "rebase/start",
          {{"repoId", repoId},
           {"upstream", "upstream"},
           {"plan", Json::array({entry("pick", shas.c1, "c1"), entry("pick", shas.c2, "c2"),
                                 entry("pick", shas.c3, "c3")})},
           {"autoStash", true}}));
  ASSERT_TRUE(start.contains("result")) << start.dump();
  EXPECT_TRUE(start["result"]["completed"].get<bool>());
  EXPECT_FALSE(start["result"]["conflicts"].get<bool>());
  EXPECT_EQ(start["result"].value("autoStashKept", false), true) << start.dump();
  EXPECT_EQ(subjects(fixture.root(), "upstream"), "c1\nc2\nc3\n");
  EXPECT_EQ(gitOut(fixture.root(), "stash list --format=%gs"), "autostash\n");
  EXPECT_EQ(gitOut(fixture.root(), "diff --name-only --diff-filter=U"), "README.md\n");
}

// The same holds for a rebase that finishes on rebase/continue.
TEST(RebaseService, AutoStashThatCannotBeRestoredAfterContinueIsReported) {
  FixtureRepo fixture;
  const Seeded shas = seedConflicting(fixture);
  fixture.writeFile("README.md", "my uncommitted edit\n");
  InteractiveSession session;
  const std::string repoId = discoverRepo(session, fixture.root());

  Json start = session.request(
      req(10, "rebase/start",
          {{"repoId", repoId},
           {"upstream", shas.base},
           {"plan", Json::array({entry("pick", shas.c1, "c1"), entry("drop", shas.c2, "c2"),
                                 entry("pick", shas.c3, "c3")})},
           {"autoStash", true}}));
  ASSERT_TRUE(start["result"]["conflicts"].get<bool>()) << start.dump();
  EXPECT_FALSE(start["result"].contains("autoStashKept")) << start.dump();

  // The resolution also commits a change to the file the stash holds.
  fixture.writeFile("f.txt", "three\n");
  fixture.writeFile("README.md", "resolved differently\n");
  fixture.run("git add f.txt README.md");
  Json cont = session.request(req(11, "rebase/continue", {{"repoId", repoId}}));
  ASSERT_TRUE(cont.contains("result")) << cont.dump();
  EXPECT_TRUE(cont["result"]["completed"].get<bool>());
  EXPECT_EQ(cont["result"].value("autoStashKept", false), true) << cont.dump();
  EXPECT_EQ(gitOut(fixture.root(), "stash list --format=%gs"), "autostash\n");
}

TEST(RebaseService, SkipDropsTheConflictedCommit) {
  FixtureRepo fixture;
  const Seeded shas = seedConflicting(fixture);
  InteractiveSession session;
  const std::string repoId = discoverRepo(session, fixture.root());

  Json start = session.request(
      req(10, "rebase/start",
          {{"repoId", repoId},
           {"upstream", shas.base},
           {"plan", Json::array({entry("pick", shas.c1, "c1"), entry("drop", shas.c2, "c2"),
                                 entry("pick", shas.c3, "c3")})}}));
  ASSERT_TRUE(start["result"]["conflicts"].get<bool>()) << start.dump();

  Json skip = session.request(req(11, "rebase/skip", {{"repoId", repoId}}));
  ASSERT_TRUE(skip.contains("result")) << skip.dump();
  EXPECT_TRUE(skip["result"]["completed"].get<bool>());
  EXPECT_EQ(subjects(fixture.root(), shas.base), "c1\n");
  EXPECT_EQ(slurp(fixture.root() / "f.txt"), "one\n");
}

TEST(RebaseService, EditStopsForAmendingThenContinues) {
  FixtureRepo fixture;
  const Seeded shas = seedDistinct(fixture);
  InteractiveSession session;
  const std::string repoId = discoverRepo(session, fixture.root());

  Json start = session.request(
      req(10, "rebase/start",
          {{"repoId", repoId},
           {"upstream", shas.base},
           {"plan", Json::array({entry("pick", shas.c1, "c1"), entry("edit", shas.c2, "c2"),
                                 entry("reword", shas.c3, "c3", "c3 reworded")})}}));
  ASSERT_TRUE(start.contains("result")) << start.dump();
  EXPECT_FALSE(start["result"]["completed"].get<bool>());
  EXPECT_FALSE(start["result"]["conflicts"].get<bool>());
  EXPECT_TRUE(std::filesystem::exists(fixture.root() / ".git/rebase-merge"));

  fixture.writeFile("b.txt", "B amended\n");
  fixture.run("git add b.txt");
  fixture.run("git commit -q --amend --no-edit");
  Json cont = session.request(req(11, "rebase/continue", {{"repoId", repoId}}));
  ASSERT_TRUE(cont.contains("result")) << cont.dump();
  EXPECT_TRUE(cont["result"]["completed"].get<bool>());
  EXPECT_EQ(subjects(fixture.root(), shas.base), "c1\nc2\nc3 reworded\n");
  EXPECT_EQ(gitOut(fixture.root(), "show HEAD~1:b.txt"), "B amended\n");
}

}  // namespace
}  // namespace gg
