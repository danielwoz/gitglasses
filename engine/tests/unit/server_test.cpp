// End-to-end tests: drive the full server loop (framing + dispatcher +
// registry) over in-memory streams, exactly as a client process would over
// stdio. The session harness lives in test_session.h.

#include "server.h"

#include <gtest/gtest.h>
#include <nlohmann/json.hpp>

#include <vector>

#include "test_fixtures.h"
#include "test_session.h"
#include "util/result.h"

namespace gg {
namespace {

using Json = nlohmann::json;
using gg::testing::initRequest;
using gg::testing::InteractiveSession;
using gg::testing::responseFor;
using gg::testing::runSession;

TEST(Server, InitializeHandshake) {
  auto messages = runSession({initRequest()});
  Json response = responseFor(messages, 1);
  EXPECT_EQ(response["result"]["protocolVersion"], "0.1.0");
  EXPECT_TRUE(response["result"].contains("engineVersion"));
}

TEST(Server, InitializeRejectsProtocolMismatch) {
  auto messages = runSession({{{"jsonrpc", "2.0"},
                               {"id", 1},
                               {"method", "initialize"},
                               {"params", {{"protocolVersion", "99.0.0"}}}}});
  Json response = responseFor(messages, 1);
  EXPECT_EQ(response["error"]["code"], -32600);
}

TEST(Server, ExitsCleanlyOnStdinClose) {
  // No shutdown request: closing stdin alone must end the loop (exit code 0
  // asserted inside runSession).
  auto messages = runSession({initRequest()});
  EXPECT_FALSE(messages.empty());
}

// repo/list and repo/state are concurrent reads, so they are sent only once
// repo/discover has answered — as a client must, since the id it returns is
// what they address.
TEST(Server, DiscoverListAndState) {
  gg::testing::FixtureRepo fixture;

  InteractiveSession session;
  session.request(initRequest(1));
  Json discover = session.request({{"jsonrpc", "2.0"},
                                   {"id", 2},
                                   {"method", "repo/discover"},
                                   {"params", {{"path", fixture.root().string()}}}});
  EXPECT_EQ(discover["result"]["repoId"], "r1");
  EXPECT_EQ(discover["result"]["bare"], false);

  Json list = session.request({{"jsonrpc", "2.0"}, {"id", 3}, {"method", "repo/list"}});
  EXPECT_EQ(list["result"]["repos"].size(), 1u);

  Json state = session.request({{"jsonrpc", "2.0"},
                                {"id", 4},
                                {"method", "repo/state"},
                                {"params", {{"repoId", "r1"}}}});
  EXPECT_EQ(state["result"]["head"]["branch"], "main");
  EXPECT_EQ(state["result"]["head"]["oid"].get<std::string>().size(), 40u);
  EXPECT_EQ(state["result"]["head"]["unborn"], false);
}

TEST(Server, BlameFileStreamsHunksAndRespectsOverlay) {
  gg::testing::FixtureRepo fixture;
  fixture.writeFile("app.txt", "one\ntwo\n");
  fixture.run("git add app.txt");
  fixture.commit("add app");

  InteractiveSession session;
  session.request(initRequest(1));
  Json discover = session.request({{"jsonrpc", "2.0"},
                                   {"id", 2},
                                   {"method", "repo/discover"},
                                   {"params", {{"path", fixture.root().string()}}}});
  const std::string repoId = discover["result"]["repoId"];

  // Clean blame.
  Json clean = session.request(
      {{"jsonrpc", "2.0"},
       {"id", 3},
       {"method", "blame/file"},
       {"params", {{"repoId", repoId}, {"path", "app.txt"}, {"streamId", "s1"}}}});
  EXPECT_EQ(clean["result"]["totalLines"], 2);
  EXPECT_EQ(clean["result"]["commits"].size(), 1u);
  EXPECT_EQ(clean["result"]["fromCache"], false);

  bool sawStreamedHunk = false;
  for (const auto& m : session.notifications) {
    if (m.value("method", "") == "blame/hunks" && m["params"]["streamId"] == "s1") {
      ASSERT_FALSE(m["params"]["hunks"].empty());
      sawStreamedHunk = true;
      EXPECT_TRUE(m["params"]["hunks"][0].contains("sha"));
    }
  }
  EXPECT_TRUE(sawStreamedHunk);

  // Identical second request is served from cache.
  Json cached = session.request(
      {{"jsonrpc", "2.0"},
       {"id", 4},
       {"method", "blame/file"},
       {"params", {{"repoId", repoId}, {"path", "app.txt"}, {"streamId", "s2"}}}});
  EXPECT_EQ(cached["result"]["fromCache"], true);

  // Push unsaved contents: the extra line must attribute as uncommitted.
  session.notify({{"jsonrpc", "2.0"},
                  {"method", "doc/didChange"},
                  {"params",
                   {{"repoId", repoId},
                    {"path", "app.txt"},
                    {"contents", "one\ntwo\nunsaved\n"},
                    {"version", 7}}}});
  Json dirty = session.request(
      {{"jsonrpc", "2.0"},
       {"id", 5},
       {"method", "blame/file"},
       {"params", {{"repoId", repoId}, {"path", "app.txt"}, {"streamId", "s3"}}}});
  EXPECT_EQ(dirty["result"]["totalLines"], 3);
  const std::string uncommitted(40, '0');
  EXPECT_TRUE(dirty["result"]["commits"].contains(uncommitted));

  // Closing the doc reverts blame to on-disk contents.
  session.notify({{"jsonrpc", "2.0"},
                  {"method", "doc/didClose"},
                  {"params", {{"repoId", repoId}, {"path", "app.txt"}}}});
  Json closed = session.request(
      {{"jsonrpc", "2.0"},
       {"id", 6},
       {"method", "blame/file"},
       {"params", {{"repoId", repoId}, {"path", "app.txt"}, {"streamId", "s4"}}}});
  EXPECT_EQ(closed["result"]["totalLines"], 2);
  EXPECT_FALSE(closed["result"]["commits"].contains(uncommitted));
}

TEST(Server, CloseReleasesTheRepoAndItsWatch) {
  gg::testing::FixtureRepo fixture;

  InteractiveSession session;
  session.request(initRequest(1));
  Json discover = session.request({{"jsonrpc", "2.0"},
                                   {"id", 2},
                                   {"method", "repo/discover"},
                                   {"params", {{"path", fixture.root().string()}}}});
  const std::string repoId = discover["result"]["repoId"];

  Json closed = session.request({{"jsonrpc", "2.0"},
                                 {"id", 3},
                                 {"method", "repo/close"},
                                 {"params", {{"repoId", repoId}}}});
  ASSERT_TRUE(closed.contains("result")) << closed.dump();

  Json list = session.request({{"jsonrpc", "2.0"}, {"id", 4}, {"method", "repo/list"}});
  EXPECT_EQ(list["result"]["repos"].size(), 0u);

  // The id is gone, so requests addressing it fail rather than resurrect it.
  Json state = session.request({{"jsonrpc", "2.0"},
                                {"id", 5},
                                {"method", "repo/state"},
                                {"params", {{"repoId", repoId}}}});
  ASSERT_TRUE(state.contains("error")) << state.dump();
  EXPECT_EQ(state["error"]["code"], static_cast<int>(ErrorCode::RepoNotFound));

  // Closing twice is an error, not a crash.
  Json again = session.request({{"jsonrpc", "2.0"},
                                {"id", 6},
                                {"method", "repo/close"},
                                {"params", {{"repoId", repoId}}}});
  EXPECT_TRUE(again.contains("error")) << again.dump();

  // The path can be registered again afterwards.
  Json rediscover = session.request({{"jsonrpc", "2.0"},
                                     {"id", 7},
                                     {"method", "repo/discover"},
                                     {"params", {{"path", fixture.root().string()}}}});
  EXPECT_TRUE(rediscover.contains("result")) << rediscover.dump();
}

TEST(Server, WatcherPushesRepoDidChange) {
#ifdef GG_SINGLE_THREADED
  GTEST_SKIP() << "single-threaded build: the watcher is never started (capability watch:false)";
#else
  gg::testing::FixtureRepo fixture;

  InteractiveSession session;
  session.request(initRequest(1));
  Json discover = session.request({{"jsonrpc", "2.0"},
                                   {"id", 2},
                                   {"method", "repo/discover"},
                                   {"params", {{"path", fixture.root().string()}}}});
  const std::string repoId = discover["result"]["repoId"];

  // An external commit (as if made from a terminal) must be pushed to us.
  fixture.writeFile("pushed.txt", "contents\n");
  fixture.run("git add pushed.txt");
  fixture.commit("external commit");

  Json note = session.readNotificationUntil("repo/didChange", 5000);
  ASSERT_EQ(note.value("method", ""), "repo/didChange");
  EXPECT_EQ(note["params"]["repoId"], repoId);
  EXPECT_GE(note["params"]["generation"].get<std::uint64_t>(), 1u);
  bool sawRelevantCategory = false;
  for (const auto& category : note["params"]["changed"]) {
    if (category == "HEAD" || category == "refs" || category == "index") {
      sawRelevantCategory = true;
    }
  }
  EXPECT_TRUE(sawRelevantCategory) << note.dump();
#endif
}

TEST(Server, FileAtRevReturnsContentsAndErrors) {
  gg::testing::FixtureRepo fixture;

  // rev/fileAtRev runs concurrently, so discovery must complete before it is
  // sent; an interactive session awaits each response.
  InteractiveSession session;
  session.request(initRequest(1));
  Json discover = session.request({{"jsonrpc", "2.0"},
                                   {"id", 2},
                                   {"method", "repo/discover"},
                                   {"params", {{"path", fixture.root().string()}}}});
  const std::string repoId = discover["result"]["repoId"];

  Json contents = session.request(
      {{"jsonrpc", "2.0"},
       {"id", 3},
       {"method", "rev/fileAtRev"},
       {"params", {{"repoId", repoId}, {"path", "README.md"}, {"rev", "HEAD"}}}});
  EXPECT_EQ(contents["result"]["contents"], "fixture\n");

  Json badRev = session.request(
      {{"jsonrpc", "2.0"},
       {"id", 4},
       {"method", "rev/fileAtRev"},
       {"params", {{"repoId", repoId}, {"path", "README.md"}, {"rev", "no-such-rev"}}}});
  EXPECT_EQ(badRev["error"]["code"], -32001);
  EXPECT_FALSE(badRev["error"]["message"].get<std::string>().empty());

  Json badPath = session.request(
      {{"jsonrpc", "2.0"},
       {"id", 5},
       {"method", "rev/fileAtRev"},
       {"params", {{"repoId", repoId}, {"path", "no/such/file.txt"}, {"rev", "HEAD"}}}});
  EXPECT_EQ(badPath["error"]["code"], -32001);

  Json badRepo = session.request(
      {{"jsonrpc", "2.0"},
       {"id", 6},
       {"method", "rev/fileAtRev"},
       {"params", {{"repoId", "r99"}, {"path", "README.md"}, {"rev", "HEAD"}}}});
  EXPECT_EQ(badRepo["error"]["code"], -32000);
}

TEST(Server, DiscoverOutsideRepoReturnsError) {
  auto messages = runSession({
      initRequest(1),
      {{"jsonrpc", "2.0"},
       {"id", 2},
       {"method", "repo/discover"},
       {"params", {{"path", std::filesystem::temp_directory_path().string()}}}},
  });
  Json response = responseFor(messages, 2);
  EXPECT_EQ(response["error"]["code"], -32000);
}

}  // namespace
}  // namespace gg
