// End-to-end tests for search/log, the git-log-backed commit search: content
// (pickaxe), path, commit-date window, case-insensitive message and author
// text, streaming, truncation, and refusal where git may not run. `git log`
// itself is the parity oracle.

#include <gtest/gtest.h>
#include <nlohmann/json.hpp>

#include <algorithm>
#include <filesystem>
#include <string>
#include <vector>

#include "services/search/search_methods.h"
#include "test_fixtures.h"
#include "test_session.h"
#include "util/result.h"

namespace gg {
namespace {

using Json = nlohmann::json;
using gg::testing::FixtureRepo;
using gg::testing::gitLines;
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

// The shas streamed for `streamId`, in arrival order.
std::vector<std::string> streamedShas(const InteractiveSession& session,
                                      const std::string& streamId) {
  std::vector<std::string> shas;
  for (const auto& note : session.notifications) {
    if (note.value("method", "") != "search/matches") continue;
    if (note["params"]["streamId"] != streamId) continue;
    for (const auto& match : note["params"]["matches"]) shas.push_back(match["sha"]);
  }
  return shas;
}

// A history where message text, authors, paths, code and dates all differ:
//   2026-01-10 Fixture  "add login form"     src/login.ts   gains validateUser
//   2026-03-05 Zed      "Refactor helpers"   src/util.ts    unrelated code
//   2026-06-20 Fixture  "fix LOGIN crash"    src/login.ts   drops validateUser
//   2026-09-01 Zed      "docs: login notes"  docs/login.md  mentions validateUser
void buildHistory(FixtureRepo& fixture) {
  fixture.writeFile("src/login.ts", "export function validateUser() {}\n");
  fixture.run("git add src/login.ts");
  fixture.commitAt("2026-01-10T12:00:00Z", "add login form");
  {
    gg::testing::ScopedEnv name("GIT_AUTHOR_NAME", "Zed Zeta");
    gg::testing::ScopedEnv email("GIT_AUTHOR_EMAIL", "zed@other.dev");
    fixture.writeFile("src/util.ts", "export const helper = 1;\n");
    fixture.run("git add src/util.ts");
    fixture.commitAt("2026-03-05T12:00:00Z", "Refactor helpers");
  }
  fixture.writeFile("src/login.ts", "export function checkUser() {}\n");
  fixture.run("git add src/login.ts");
  fixture.commitAt("2026-06-20T12:00:00Z", "fix LOGIN crash");
  {
    gg::testing::ScopedEnv name("GIT_AUTHOR_NAME", "Zed Zeta");
    gg::testing::ScopedEnv email("GIT_AUTHOR_EMAIL", "zed@other.dev");
    fixture.writeFile("docs/login.md", "Call validateUser before rendering.\n");
    fixture.run("git add docs/login.md");
    fixture.commitAt("2026-09-01T12:00:00Z", "docs: login notes");
  }
}

class SearchLogTest : public ::testing::Test {
 protected:
  void SetUp() override {
    buildHistory(fixture);
    repoId = discoverRepo(session, fixture.root());
  }

  // Runs one search/log and returns its result, asserting it succeeded.
  Json search(const std::string& streamId, Json query, int limit = 50) {
    Json response = session.request(
        req(++id, "search/log",
            {{"repoId", repoId}, {"streamId", streamId}, {"limit", limit}, {"query", query}}));
    EXPECT_TRUE(response.contains("result")) << response.dump();
    return response.value("result", Json::object());
  }

  FixtureRepo fixture;
  InteractiveSession session;
  std::string repoId;
  std::int64_t id = 10;
};

TEST_F(SearchLogTest, PickaxeFindsCommitsThatAddOrRemoveTheCode) {
  Json result = search("s", {{"content", "validateUser"}});
  EXPECT_EQ(result["streamId"], "s");
  const auto expected = gitLines(fixture.root(), "log -SvalidateUser --format=%H");
  ASSERT_EQ(expected.size(), 3u);
  EXPECT_EQ(result["total"], 3);
  EXPECT_EQ(result["truncated"], false);
  EXPECT_EQ(streamedShas(session, "s"), expected);

  // The pickaxe is exact: the same code in another case matches nothing.
  EXPECT_EQ(search("case", {{"content", "VALIDATEUSER"}})["total"], 0);
}

TEST_F(SearchLogTest, RegexContentMatchesChangedLines) {
  Json result = search("g", {{"content", "function [a-z]+User"}, {"contentMode", "regex"}});
  const auto expected = gitLines(fixture.root(), "log -Gfunction.[a-z]+User --format=%H");
  ASSERT_EQ(expected.size(), 2u);
  EXPECT_EQ(result["total"], 2);
  EXPECT_EQ(streamedShas(session, "g"), expected);
}

TEST_F(SearchLogTest, PathLimitsToCommitsTouchingIt) {
  Json result = search("p", {{"path", "src/login.ts"}});
  EXPECT_EQ(result["total"], 2);
  EXPECT_EQ(streamedShas(session, "p"),
            gitLines(fixture.root(), "log --format=%H -- src/login.ts"));

  // Pathspecs keep git's glob rules.
  EXPECT_EQ(search("glob", {{"path", "src/*.ts"}})["total"], 3);
}

TEST_F(SearchLogTest, MessageAndAuthorIgnoreCaseAndCombineWithContent) {
  EXPECT_EQ(search("t", {{"text", "login"}})["total"], 3);
  EXPECT_EQ(search("a", {{"author", "ZED"}})["total"], 2);
  EXPECT_EQ(search("e", {{"author", "other.dev"}})["total"], 2);
  // Criteria AND together: Zed's login-related commit that touches validateUser.
  Json combined = search("c", {{"text", "LOGIN"}, {"author", "zed"}, {"content", "validateUser"}});
  EXPECT_EQ(combined["total"], 1);
  EXPECT_EQ(streamedShas(session, "c"), gitLines(fixture.root(), "log -1 --format=%H"));
}

TEST_F(SearchLogTest, RegexCharactersInTextAreLiteral) {
  EXPECT_EQ(search("dot", {{"text", "docs."}})["total"], 0);
  EXPECT_EQ(search("colon", {{"text", "docs:"}})["total"], 1);
  EXPECT_EQ(search("star", {{"text", "fix*"}})["total"], 0);
}

TEST_F(SearchLogTest, DateWindowUsesCommitDates) {
  Json window = search("w", {{"since", "2026-03-01"}, {"until", "2026-07-01"}});
  EXPECT_EQ(window["total"], 2);
  const auto all = gitLines(fixture.root(), "log --format=%H");
  // Newest first: "fix LOGIN crash" then "Refactor helpers".
  EXPECT_EQ(streamedShas(session, "w"), (std::vector<std::string>{all[1], all[2]}));

  // A bare date is the start of that day, so a commit made at noon on the
  // `until` day is excluded and one made at noon on the `since` day included.
  // Only the fixture's initial commit, from New Year's Day, is older.
  EXPECT_EQ(search("u", {{"until", "2026-01-10"}})["total"], 1);
  EXPECT_EQ(search("s2", {{"since", "2026-09-01"}})["total"], 1);
  EXPECT_EQ(search("tz", {{"since", "2026-09-01T13:00:00+02:00"}})["total"], 1);
  EXPECT_EQ(search("tz2", {{"since", "2026-09-01T13:00:00Z"}})["total"], 0);
}

TEST_F(SearchLogTest, LimitReportsTruncation) {
  Json result = search("l", Json::object(), 2);
  EXPECT_EQ(result["total"], 2);
  EXPECT_EQ(result["truncated"], true);
  EXPECT_EQ(streamedShas(session, "l").size(), 2u);
  Json exact = search("x", {{"author", "zed"}}, 2);
  EXPECT_EQ(exact["total"], 2);
  EXPECT_EQ(exact["truncated"], false);
}

TEST_F(SearchLogTest, RejectsMalformedCriteriaAndReportsGitErrors) {
  for (const Json& query : {Json{{"since", "last month"}}, Json{{"until", "2026-13"}},
                            Json{{"contentMode", "fuzzy"}, {"content", "x"}}, Json{{"text", ""}}}) {
    Json response = session.request(
        req(++id, "search/log", {{"repoId", repoId}, {"streamId", "bad"}, {"query", query}}));
    ASSERT_TRUE(response.contains("error")) << query.dump();
    EXPECT_EQ(response["error"]["code"], -32602) << query.dump();
  }
  // An invalid regex is git's to reject; its message comes back.
  Json response = session.request(req(++id, "search/log",
                                      {{"repoId", repoId},
                                       {"streamId", "re"},
                                       {"query", {{"content", "("}, {"contentMode", "regex"}}}}));
  ASSERT_TRUE(response.contains("error")) << response.dump();
  EXPECT_NE(response["error"]["message"].get<std::string>().find("git log failed"),
            std::string::npos);
}

TEST(SearchLog, PartialCloneContentSearchExplainsInsteadOfFetching) {
  FixtureRepo origin;
  buildHistory(origin);
  origin.run("git config uploadpack.allowFilter true");
  const auto parent = gg::testing::makeTempDir("gg-search-partial-");
  const auto clone = parent / "clone";
  gg::testing::runGit(parent, "git clone -q --no-local --filter=blob:none \"" +
                                  origin.root().string() + "\" clone");

  InteractiveSession session;
  const std::string repoId = discoverRepo(session, clone);
  Json content = session.request(
      req(10, "search/log",
          {{"repoId", repoId}, {"streamId", "c"}, {"query", {{"content", "validateUser"}}}}));
  ASSERT_TRUE(content.contains("error")) << content.dump();
  EXPECT_NE(content["error"]["message"].get<std::string>().find("partial clone"), std::string::npos)
      << content.dump();
  // Nothing was downloaded: the old blob is still missing.
  const auto missing = gitLines(clone, "rev-list --objects --missing=print --all");
  EXPECT_TRUE(std::any_of(missing.begin(), missing.end(),
                          [](const std::string& line) { return line.rfind('?', 0) == 0; }));

  // Criteria that read no file contents still work.
  Json text = session.request(req(
      11, "search/log",
      {{"repoId", repoId}, {"streamId", "t"}, {"query", {{"text", "login"}, {"path", "src"}}}}));
  ASSERT_TRUE(text.contains("result")) << text.dump();
  EXPECT_EQ(text["result"]["total"], 2);
  std::error_code ec;
  std::filesystem::remove_all(parent, ec);
}

TEST(SearchLog, EmptyRepositoryHasNoMatches) {
  const auto root = gg::testing::makeTempDir("gg-search-empty-");
  gg::testing::runGit(root, "git init -q -b main");
  InteractiveSession session;
  const std::string repoId = discoverRepo(session, root);
  Json response = session.request(
      req(10, "search/log", {{"repoId", repoId}, {"streamId", "e"}, {"query", {{"text", "x"}}}}));
  ASSERT_TRUE(response.contains("result")) << response.dump();
  EXPECT_EQ(response["result"]["total"], 0);
  EXPECT_EQ(response["result"]["truncated"], false);
  std::error_code ec;
  std::filesystem::remove_all(root, ec);
}

TEST(SearchLog, RefusedWhereGitMayNotRun) {
  FixtureRepo fixture;
  {
    gg::testing::ScopedRestrictedMode restricted;
    InteractiveSession session;
    const std::string repoId = discoverRepo(session, fixture.root());
    Json response = session.request(
        req(10, "search/log", {{"repoId", repoId}, {"streamId", "r"}, {"query", {{"text", "x"}}}}));
    ASSERT_TRUE(response.contains("error")) << response.dump();
    EXPECT_EQ(response["error"]["code"], static_cast<int>(ErrorCode::Restricted));
  }
  gg::testing::setEnvVar("GG_NO_GIT_CLI", "1");
  {
    InteractiveSession session;
    const std::string repoId = discoverRepo(session, fixture.root());
    Json response = session.request(
        req(10, "search/log", {{"repoId", repoId}, {"streamId", "n"}, {"query", {{"text", "x"}}}}));
    ASSERT_TRUE(response.contains("error")) << response.dump();
    EXPECT_EQ(response["error"]["code"], static_cast<int>(ErrorCode::MethodNotSupported));
  }
  gg::testing::unsetEnvVar("GG_NO_GIT_CLI");
}

TEST(SearchLog, CaseInsensitiveLiteralPattern) {
  EXPECT_EQ(services::caseInsensitiveLiteralPattern("Ab1"), "[aA][bB]1");
  EXPECT_EQ(services::caseInsensitiveLiteralPattern("a.b*[c]^$\\"),
            "[aA]\\.[bB]\\*\\[[cC]]\\^\\$\\\\");
  // Non-ASCII bytes pass through untouched.
  EXPECT_EQ(services::caseInsensitiveLiteralPattern("\xc3\xa9"), "\xc3\xa9");
}

}  // namespace
}  // namespace gg
