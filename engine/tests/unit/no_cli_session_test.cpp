// Full-session behaviour with the git CLI disabled via GG_NO_GIT_CLI=1:
// initialize reports gitCli:false, blame/file works through the libgit2
// fallback, CLI-dependent methods fail with the typed MethodNotSupported
// error, and libgit2-backed reads keep working.

#include <gtest/gtest.h>
#include <nlohmann/json.hpp>

#include <cstdlib>
#include <string>
#include <utility>

#include "exec/parsers/incremental_blame.h"
#include "test_fixtures.h"
#include "test_session.h"

namespace gg {
namespace {

using Json = nlohmann::json;
using gg::testing::FixtureRepo;
using gg::testing::InteractiveSession;

Json req(std::int64_t id, const std::string& method, Json params) {
  return {{"jsonrpc", "2.0"}, {"id", id}, {"method", method}, {"params", std::move(params)}};
}

// The override is read when the server's ServiceContext is constructed (the
// probe is cached per context, not statically), so setting it before the
// InteractiveSession spawns the server thread is sufficient — and it must be
// cleared again for any other test sharing this process.
struct NoCliSessionTest : ::testing::Test {
  void SetUp() override { gg::testing::setEnvVar("GG_NO_GIT_CLI", "1"); }
  void TearDown() override { gg::testing::unsetEnvVar("GG_NO_GIT_CLI"); }
};

TEST_F(NoCliSessionTest, FullSessionWithoutGitCli) {
  // Fixture setup shells out to the real git via std::system; the engine-side
  // override does not affect it.
  FixtureRepo fixture;
  fixture.writeFile("src/app.txt", "one\ntwo\n");
  fixture.run("git add src/app.txt");
  fixture.commit("add app");
  fixture.writeFile("src/app.txt", "one\ntwo\nthree\n");  // dirty working tree

  InteractiveSession session;

  Json init = session.request(gg::testing::initRequest(1));
  ASSERT_TRUE(init.contains("result")) << init.dump();
  const Json caps = init["result"].value("capabilities", Json::object());
  EXPECT_EQ(caps.value("gitCli", true), false);
#ifdef GG_SINGLE_THREADED
  EXPECT_EQ(caps.value("watch", true), false);
  EXPECT_EQ(caps.value("threads", true), false);
#else
  EXPECT_EQ(caps.value("watch", false), true);
  EXPECT_EQ(caps.value("threads", false), true);
#endif

  Json discovered =
      session.request(req(2, "repo/discover", {{"path", fixture.root().string()}}));
  ASSERT_TRUE(discovered.contains("result")) << discovered.dump();
  const std::string repoId = discovered["result"].value("repoId", "");
  ASSERT_FALSE(repoId.empty());

  // blame/file works through the libgit2 fallback; the dirty third line
  // streams out attributed as uncommitted.
  Json blame = session.request(req(
      3, "blame/file", {{"repoId", repoId}, {"path", "src/app.txt"}, {"streamId", "no-cli"}}));
  ASSERT_TRUE(blame.contains("result")) << blame.dump();
  EXPECT_FALSE(blame["result"].value("commits", Json::object()).empty());
  EXPECT_EQ(blame["result"].value("totalLines", 0), 3);
  bool sawUncommitted = false;
  for (const auto& notification : session.notifications) {
    if (notification.value("method", "") != "blame/hunks") continue;
    for (const auto& hunk : notification["params"].value("hunks", Json::array())) {
      if (hunk.value("sha", "") == exec::kUncommittedSha) sawUncommitted = true;
    }
  }
  EXPECT_TRUE(sawUncommitted);

  // CLI-dependent methods are rejected with the typed capability error.
  Json commit = session.request(req(4, "mutate/commit", {{"repoId", repoId}, {"message", "x"}}));
  ASSERT_TRUE(commit.contains("error")) << commit.dump();
  EXPECT_EQ(commit["error"].value("code", 0), -32003);
  EXPECT_NE(commit["error"].value("message", "").find("requires the git CLI"),
            std::string::npos);

  Json lineHistory = session.request(req(
      5, "history/line",
      {{"repoId", repoId}, {"path", "src/app.txt"}, {"startLine", 1}, {"endLine", 2}}));
  ASSERT_TRUE(lineHistory.contains("error")) << lineHistory.dump();
  EXPECT_EQ(lineHistory["error"].value("code", 0), -32003);

  // libgit2-backed reads keep working.
  Json log = session.request(req(6, "log/commits", {{"repoId", repoId}, {"limit", 10}}));
  ASSERT_TRUE(log.contains("result")) << log.dump();
  EXPECT_EQ(log["result"].value("commits", Json::array()).size(), 2u);

  Json status = session.request(req(7, "status/summary", {{"repoId", repoId}}));
  ASSERT_TRUE(status.contains("result")) << status.dump();
}

}  // namespace
}  // namespace gg
