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
  FILE* pipe = popen(("cd '" + root.string() + "' && git " + args).c_str(), "r");
  EXPECT_NE(pipe, nullptr);
  if (!pipe) return "";
  std::string output;
  char buf[512];
  while (fgets(buf, sizeof(buf), pipe)) output += buf;
  pclose(pipe);
  return output;
}

std::string rev(const std::filesystem::path& root, const std::string& spec) {
  std::string sha = gitOut(root, "rev-parse " + spec + " 2>/dev/null");
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
  fixture.run("GIT_AUTHOR_DATE='" + date + "' GIT_COMMITTER_DATE='" + date +
              "' git commit -q --allow-empty -m '" + message + "'");
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

TEST(RebaseService, StartOmittedShaIsDropped) {
  FixtureRepo fixture;
  const Seeded shas = seedDistinct(fixture);
  InteractiveSession session;
  const std::string repoId = discoverRepo(session, fixture.root());

  // The plan is authoritative: c2 is simply absent.
  Json start = session.request(req(10, "rebase/start",
                                   {{"repoId", repoId},
                                    {"upstream", shas.base},
                                    {"plan", Json::array({entry("pick", shas.c1, "c1"),
                                                          entry("pick", shas.c3, "c3")})}}));
  ASSERT_TRUE(start.contains("result")) << start.dump();
  EXPECT_TRUE(start["result"]["completed"].get<bool>());
  EXPECT_EQ(subjects(fixture.root(), shas.base), "c1\nc3\n");
  EXPECT_FALSE(std::filesystem::exists(fixture.root() / "b.txt"));
}

TEST(RebaseService, ConflictReportsAndAbortRestoresHead) {
  FixtureRepo fixture;
  const Seeded shas = seedConflicting(fixture);
  InteractiveSession session;
  const std::string repoId = discoverRepo(session, fixture.root());

  // Dropping c2 makes c3 (two -> three) apply onto "one": conflict.
  Json start = session.request(req(10, "rebase/start",
                                   {{"repoId", repoId},
                                    {"upstream", shas.base},
                                    {"plan", Json::array({entry("pick", shas.c1, "c1"),
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

TEST(RebaseService, ConflictResolveAndContinueCompletes) {
  FixtureRepo fixture;
  const Seeded shas = seedConflicting(fixture);
  InteractiveSession session;
  const std::string repoId = discoverRepo(session, fixture.root());

  Json start = session.request(req(10, "rebase/start",
                                   {{"repoId", repoId},
                                    {"upstream", shas.base},
                                    {"plan", Json::array({entry("pick", shas.c1, "c1"),
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

}  // namespace
}  // namespace gg
