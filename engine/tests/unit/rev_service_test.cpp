// End-to-end tests for rev/fileAtRev: checkout filtering, binary detection
// and the payload cap, plus the reads an empty repository has to answer
// without leaking git's own error text.

#include <gtest/gtest.h>
#include <nlohmann/json.hpp>

#include <cstdint>
#include <filesystem>
#include <fstream>
#include <string>
#include <system_error>

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

std::string discoverRepo(InteractiveSession& session, const std::filesystem::path& root) {
  session.request(initRequest(1));
  Json discover = session.request(req(2, "repo/discover", {{"path", root.string()}}));
  return discover["result"]["repoId"];
}

TEST(RevService, ReturnsFilteredContents) {
  FixtureRepo fixture;
  // eol=crlf makes the checked-out bytes differ from the stored blob, which
  // is what a client diffing against an editor buffer sees.
  fixture.writeFile(".gitattributes", "*.txt text eol=crlf\n");
  fixture.writeFile("app.txt", "one\ntwo\n");
  fixture.run("git add .gitattributes app.txt");
  fixture.commit("add app");

  InteractiveSession session;
  const std::string repoId = discoverRepo(session, fixture.root());

  Json result = session.request(
      req(10, "rev/fileAtRev", {{"repoId", repoId}, {"path", "app.txt"}, {"rev", "HEAD"}}));
  ASSERT_TRUE(result.contains("result")) << result.dump();
  EXPECT_EQ(result["result"]["contents"], "one\r\ntwo\r\n");
  EXPECT_EQ(result["result"]["size"], 8);  // stored blob is still LF
  EXPECT_FALSE(result["result"]["truncated"].get<bool>());
  EXPECT_FALSE(result["result"]["binary"].get<bool>());
}

TEST(RevService, ReportsBinaryInsteadOfReplacementCharacters) {
  FixtureRepo fixture;
  fixture.writeFile("blob.bin", std::string("\x01\x02\x00\x03 binary", 11));
  fixture.run("git add blob.bin");
  fixture.commit("add binary");

  InteractiveSession session;
  const std::string repoId = discoverRepo(session, fixture.root());

  Json result = session.request(
      req(10, "rev/fileAtRev", {{"repoId", repoId}, {"path", "blob.bin"}, {"rev", "HEAD"}}));
  ASSERT_TRUE(result.contains("result")) << result.dump();
  EXPECT_TRUE(result["result"]["binary"].get<bool>());
  EXPECT_EQ(result["result"]["contents"], "");
  EXPECT_EQ(result["result"]["size"], 11);
  EXPECT_FALSE(result["result"]["truncated"].get<bool>());
}

TEST(RevService, TruncatesAtMaxBytesOnACharacterBoundary) {
  FixtureRepo fixture;
  // Four 3-byte characters: a byte cap of 10 lands mid-character.
  const std::string text = "一二三四";
  fixture.writeFile("wide.txt", text);
  fixture.run("git add wide.txt");
  fixture.commit("add wide");

  InteractiveSession session;
  const std::string repoId = discoverRepo(session, fixture.root());

  Json capped = session.request(req(10, "rev/fileAtRev",
                                    {{"repoId", repoId},
                                     {"path", "wide.txt"},
                                     {"rev", "HEAD"},
                                     {"maxBytes", 10}}));
  ASSERT_TRUE(capped.contains("result")) << capped.dump();
  EXPECT_TRUE(capped["result"]["truncated"].get<bool>());
  EXPECT_EQ(capped["result"]["size"], 12);
  EXPECT_EQ(capped["result"]["contents"], "一二三");

  Json whole = session.request(req(11, "rev/fileAtRev",
                                   {{"repoId", repoId},
                                    {"path", "wide.txt"},
                                    {"rev", "HEAD"},
                                    {"maxBytes", 12}}));
  EXPECT_FALSE(whole["result"]["truncated"].get<bool>());
  EXPECT_EQ(whole["result"]["contents"], text);
}

// An empty repository is a normal state, not a failure: git's "fatal: no such
// ref: HEAD" must never reach the client as a blame result.
TEST(RevService, BlameOnUnbornHeadIsEmptyNotAGitError) {
  struct EmptyRepo {
    std::filesystem::path root;
    EmptyRepo() {
      root = std::filesystem::temp_directory_path() / "gg-unborn-blame";
      std::filesystem::remove_all(root);
      std::filesystem::create_directories(root);
      gg::testing::runGit(root, "git init -q -b main");
    }
    ~EmptyRepo() {
      std::error_code ec;
      std::filesystem::remove_all(root, ec);
    }
  } empty;
  {
    std::ofstream file(empty.root / "fresh.txt", std::ios::binary);
    file << "new\n";
  }

  InteractiveSession session;
  const std::string repoId = discoverRepo(session, empty.root);

  Json blame = session.request(req(10, "blame/file",
                                   {{"repoId", repoId},
                                    {"path", "fresh.txt"},
                                    {"streamId", "unborn"}}));
  ASSERT_TRUE(blame.contains("result")) << blame.dump();
  EXPECT_EQ(blame["result"]["totalLines"], 0);
  EXPECT_TRUE(blame["result"]["commits"].empty());
  EXPECT_EQ(blame["result"]["streamId"], "unborn");
}

}  // namespace
}  // namespace gg
