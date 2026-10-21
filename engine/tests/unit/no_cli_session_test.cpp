// Full-session behaviour with the git CLI disabled via GG_NO_GIT_CLI=1:
// initialize reports gitCli:false, blame/file works through the libgit2
// fallback, CLI-dependent methods fail with the typed MethodNotSupported
// error, libgit2-backed reads keep working, and staging refuses the paths
// only git can clean.

#include <gtest/gtest.h>
#include <nlohmann/json.hpp>

#include <cstdlib>
#include <filesystem>
#include <fstream>
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

  Json details = session.request(req(8, "commit/details", {{"repoId", repoId}, {"sha", "HEAD"}}));
  ASSERT_TRUE(details.contains("result")) << details.dump();
  EXPECT_EQ(details["result"].value("subject", ""), "add app");
  EXPECT_EQ(details["result"]["stats"].value("files", 0), 1);
}

// Without the CLI nothing can run a clean filter or working-tree-encoding,
// so staging such a path is refused with its own code instead of storing raw
// working-tree bytes. Other paths still stage through libgit2.
TEST_F(NoCliSessionTest, StagingRefusesFilteredPathsWithoutGitCli) {
  FixtureRepo fixture;
  fixture.run("git config filter.scrub.clean \"sed -e s/SECRET/REDACTED/\"");
  fixture.run("git config filter.scrub.smudge cat");
  fixture.writeFile(".gitattributes",
                    "*.env filter=scrub\n*.txt working-tree-encoding=UTF-16LE-BOM\n");
  fixture.writeFile("app.env", "token=SECRET\n");
  fixture.writeFile("plain.md", "one\n");
  fixture.writeFile("gone.md", "doomed\n");
  fixture.run("git add .gitattributes app.env plain.md gone.md");
  fixture.commit("seed");
  fixture.writeFile("app.env", "token=SECRET\nport=2\n");
  fixture.writeFile("notes.txt", std::string("\xff\xfeh\0i\0\n\0", 8));
  fixture.writeFile("plain.md", "one\ntwo\n");
  std::filesystem::remove(fixture.root() / "gone.md");
  const std::string indexBefore = gg::testing::gitCapture(fixture.root(), "ls-files -s");

  InteractiveSession session;
  session.request(gg::testing::initRequest(1));
  Json discovered = session.request(req(2, "repo/discover", {{"path", fixture.root().string()}}));
  const std::string repoId = discovered["result"].value("repoId", "");
  ASSERT_FALSE(repoId.empty()) << discovered.dump();

  for (const char* path : {"app.env", "notes.txt"}) {
    Json stage = session.request(
        req(3, "stage/files",
            {{"repoId", repoId}, {"paths", {"plain.md", path}}, {"action", "stage"}}));
    ASSERT_TRUE(stage.contains("error")) << stage.dump();
    EXPECT_EQ(stage["error"].value("code", 0), -32010) << stage.dump();
    EXPECT_NE(stage["error"].value("message", "").find(path), std::string::npos);
  }
  // Refused before anything was written.
  EXPECT_EQ(gg::testing::gitCapture(fixture.root(), "ls-files -s"), indexBefore);

  // Hunks of the filtered file would be raw bytes against a cleaned blob.
  Json hunks = session.request(
      req(4, "diff/fileHunks", {{"repoId", repoId}, {"path", "app.env"}, {"staged", false}}));
  ASSERT_TRUE(hunks.contains("error")) << hunks.dump();
  EXPECT_EQ(hunks["error"].value("code", 0), -32010);
  Json stageHunk = session.request(
      req(5, "stage/hunks",
          {{"repoId", repoId},
           {"path", "app.env"},
           {"action", "stage"},
           {"hunks",
            Json::array({{{"oldStart", 1}, {"oldLines", 1}, {"newStart", 1}, {"newLines", 2}}})}}));
  ASSERT_TRUE(stageHunk.contains("error")) << stageHunk.dump();
  EXPECT_EQ(stageHunk["error"].value("code", 0), -32010);

  // Unfiltered paths stage through libgit2, a missing one as a removal.
  Json plain = session.request(
      req(6, "stage/files",
          {{"repoId", repoId}, {"paths", {"plain.md", "gone.md"}}, {"action", "stage"}}));
  ASSERT_TRUE(plain.contains("result")) << plain.dump();
  EXPECT_EQ(gg::testing::gitCapture(fixture.root(), "diff --cached --name-status"),
            "D\tgone.md\nM\tplain.md\n");
}

// Deleting a file stores no content, so no filter is involved: the deletion
// of a Git LFS or git-crypt file stages without the CLI.
TEST_F(NoCliSessionTest, StagingDeletionOfFilteredFileWithoutGitCli) {
  FixtureRepo fixture;
  fixture.run("git config filter.crypt.clean cat");
  fixture.run("git config filter.crypt.smudge cat");
  fixture.writeFile(".gitattributes", "*.bin filter=crypt -text\n");
  fixture.writeFile("big.bin", "payload\n");
  fixture.writeFile("kept.bin", "payload\n");
  fixture.run("git add .gitattributes big.bin kept.bin");
  fixture.commit("seed");
  std::filesystem::remove(fixture.root() / "big.bin");
  fixture.writeFile("kept.bin", "payload\nmore\n");

  InteractiveSession session;
  session.request(gg::testing::initRequest(1));
  Json discovered = session.request(req(2, "repo/discover", {{"path", fixture.root().string()}}));
  const std::string repoId = discovered["result"].value("repoId", "");
  ASSERT_FALSE(repoId.empty()) << discovered.dump();

  Json stage = session.request(
      req(3, "stage/files", {{"repoId", repoId}, {"paths", {"big.bin"}}, {"action", "stage"}}));
  ASSERT_TRUE(stage.contains("result")) << stage.dump();
  EXPECT_EQ(gg::testing::gitCapture(fixture.root(), "diff --cached --name-status"), "D\tbig.bin\n");

  // A filtered file that is present still needs the CLI.
  Json kept = session.request(
      req(4, "stage/files", {{"repoId", repoId}, {"paths", {"kept.bin"}}, {"action", "stage"}}));
  ASSERT_TRUE(kept.contains("error")) << kept.dump();
  EXPECT_EQ(kept["error"].value("code", 0), -32010) << kept.dump();
}

TEST_F(NoCliSessionTest, StagingWithoutGitCliKeepsSparseAndNonAsciiPathsRight) {
  FixtureRepo fixture;
  fixture.writeFile("keep/k.txt", "keep\n");
  fixture.writeFile("other/f1.txt", "one\n");
  const std::filesystem::path accented =
      fixture.root() / std::filesystem::path(u8"keep/caf\u00e9.txt");
  std::ofstream(accented, std::ios::binary) << "one\n";
  fixture.run("git add -A");
  fixture.commit("seed");
  fixture.run("git sparse-checkout set --cone keep");
  std::ofstream(accented, std::ios::binary | std::ios::trunc) << "one\ntwo\n";

  InteractiveSession session;
  session.request(gg::testing::initRequest(1));
  Json discovered = session.request(req(2, "repo/discover", {{"path", fixture.root().string()}}));
  const std::string repoId = discovered["result"].value("repoId", "");
  ASSERT_FALSE(repoId.empty()) << discovered.dump();

  // The out-of-cone file is missing from disk; staging it would record a
  // deletion git never makes.
  Json sparse = session.request(req(
      3, "stage/files", {{"repoId", repoId}, {"paths", {"other/f1.txt"}}, {"action", "stage"}}));
  ASSERT_TRUE(sparse.contains("error")) << sparse.dump();
  EXPECT_EQ(gg::testing::gitCapture(fixture.root(), "diff --cached --name-status"), "");

  const std::string name = "keep/caf\xc3\xa9.txt";
  Json stage = session.request(
      req(4, "stage/files", {{"repoId", repoId}, {"paths", {name}}, {"action", "stage"}}));
  ASSERT_TRUE(stage.contains("result")) << stage.dump();
  EXPECT_EQ(gg::testing::gitCapture(fixture.root(),
                                    "-c core.quotePath=false diff --cached --name-status"),
            "M\t" + name + "\n");
}

}  // namespace
}  // namespace gg
