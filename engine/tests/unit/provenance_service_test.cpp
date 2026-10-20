// End-to-end tests for commit/provenance, notes/read and
// notes/addFetchRefspec, driven through the full server loop against real
// repositories built with the git CLI.

#include <gtest/gtest.h>
#include <nlohmann/json.hpp>

#include <cstdint>
#include <filesystem>
#include <string>
#include <utility>

#include "services/notes/notes_methods.h"
#include "test_fixtures.h"
#include "test_session.h"

namespace gg {
namespace {

using Json = nlohmann::json;
using gg::testing::FixtureRepo;
using gg::testing::initRequest;
using gg::testing::InteractiveSession;
using gg::testing::ScopedEnv;

constexpr const char* kDate = "@1700000000 +0000";

constexpr const char* kCursorNote =
    "src/a.txt\n"
    "  s_c9883b05a2487d::t_9f8e7d6c5b4a32 1-2\n"
    "---\n"
    "{\n"
    "  \"schema_version\": \"authorship/3.0.0\",\n"
    "  \"base_commit_sha\": \"7734793b756b3921c88db5375a8c156e9532447b\",\n"
    "  \"prompts\": {},\n"
    "  \"sessions\": {\n"
    "    \"s_c9883b05a2487d\": {\n"
    "      \"agent_id\": {\"tool\": \"cursor\", \"id\": \"6ef2299e\", \"model\": \"gpt-5\"},\n"
    "      \"human_author\": \"fixture@example.invalid\"\n"
    "    }\n"
    "  }\n"
    "}\n";

Json req(std::int64_t id, const std::string& method, Json params) {
  return {{"jsonrpc", "2.0"}, {"id", id}, {"method", method}, {"params", std::move(params)}};
}

std::string rev(const FixtureRepo& fixture, const std::string& spec) {
  std::string sha = gg::testing::gitCapture(fixture.root(), "rev-parse " + spec);
  while (!sha.empty() && (sha.back() == '\n' || sha.back() == '\r')) sha.pop_back();
  return sha;
}

void commitMessage(FixtureRepo& fixture, const std::string& message) {
  fixture.writeFile(".git/GG_TEST_MSG", message);
  fixture.runAt(kDate, "git commit -q --allow-empty -F .git/GG_TEST_MSG");
}

void addNote(FixtureRepo& fixture, const std::string& ref, const std::string& sha,
             const std::string& text) {
  fixture.writeFile(".git/GG_TEST_NOTE", text);
  fixture.run("git notes --ref=" + ref + " add -f -F .git/GG_TEST_NOTE " + sha);
}

std::string discoverRepo(InteractiveSession& session, const std::filesystem::path& root) {
  session.request(initRequest(1));
  Json discover = session.request(req(2, "repo/discover", {{"path", root.string()}}));
  return discover["result"]["repoId"];
}

Json provenanceOf(InteractiveSession& session, std::int64_t id, const std::string& repoId,
                  const Json& shas) {
  Json response =
      session.request(req(id, "commit/provenance", {{"repoId", repoId}, {"shas", shas}}));
  EXPECT_TRUE(response.contains("result")) << response.dump();
  return response.value("result", Json::object()).value("commits", Json::object());
}

TEST(ProvenanceService, ReportsTrailersIdentitiesAndCommitsThatDeclareNothing) {
  FixtureRepo fixture;
  const std::string plain = rev(fixture, "HEAD");
  commitMessage(fixture,
                "Teach the parser frames\n"
                "\n"
                "Co-authored-by: Jane <jane@example.invalid>\n"
                "Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>\n");
  const std::string trailer = rev(fixture, "HEAD");
  {
    ScopedEnv name("GIT_AUTHOR_NAME", "Copilot");
    ScopedEnv email("GIT_AUTHOR_EMAIL", "198982749+Copilot@users.noreply.github.com");
    commitMessage(fixture,
                  "Fix the flaky test\n"
                  "\n"
                  "Agent-Logs-Url: https://github.com/o/r/tasks/1\n");
  }
  const std::string agent = rev(fixture, "HEAD");

  InteractiveSession session;
  const std::string repoId = discoverRepo(session, fixture.root());
  const std::string missing(40, 'e');
  Json commits = provenanceOf(session, 10, repoId, {plain, trailer, agent, missing, plain});

  ASSERT_EQ(commits.size(), 3u) << "unknown shas are left out: " << commits.dump();
  EXPECT_EQ(commits[plain], Json({{"declared", "unknown"}, {"declarations", Json::array()}}));

  EXPECT_EQ(commits[trailer]["declared"], "agent");
  EXPECT_EQ(commits[trailer]["declarations"],
            Json::array({{{"source", "trailer"},
                          {"kind", "agent"},
                          {"name", "Claude"},
                          {"model", "Opus 4.7"},
                          {"via", "Co-Authored-By"},
                          {"value", "Claude Opus 4.7 <noreply@anthropic.com>"}}}));

  EXPECT_EQ(commits[agent]["declared"], "agent");
  ASSERT_EQ(commits[agent]["declarations"].size(), 1u) << commits[agent].dump();
  const Json& declaration = commits[agent]["declarations"][0];
  EXPECT_EQ(declaration["source"], "identity");
  EXPECT_EQ(declaration["name"], "GitHub Copilot");
  EXPECT_EQ(declaration["via"], "author");
  EXPECT_EQ(declaration["url"], "https://github.com/o/r/tasks/1");
}

TEST(ProvenanceService, ReadsGitAiNotesFirstAndFollowsTheNotesRef) {
  FixtureRepo fixture;
  commitMessage(fixture, "Add a.txt\n\nCo-authored-by: Cursor <cursoragent@cursor.com>\n");
  const std::string sha = rev(fixture, "HEAD");

  InteractiveSession session;
  const std::string repoId = discoverRepo(session, fixture.root());
  // Before refs/notes/ai exists, the trailer is all there is.
  Json before = provenanceOf(session, 10, repoId, {sha});
  ASSERT_EQ(before[sha]["declarations"].size(), 1u);
  EXPECT_FALSE(before[sha].contains("note"));

  addNote(fixture, "ai", sha, kCursorNote);
  Json after = provenanceOf(session, 11, repoId, {sha});
  EXPECT_EQ(after[sha]["note"], Json({{"read", true}, {"schemaVersion", "authorship/3.0.0"}}));
  ASSERT_EQ(after[sha]["declarations"].size(), 2u) << after.dump();
  EXPECT_EQ(after[sha]["declarations"][0], Json({{"source", "notes"},
                                                 {"kind", "agent"},
                                                 {"name", "Cursor"},
                                                 {"model", "gpt-5"},
                                                 {"via", "refs/notes/ai"},
                                                 {"value", "6ef2299e"}}));
  EXPECT_EQ(after[sha]["declarations"][1]["source"], "trailer");

  // Rewriting the note moves the ref, and the new note is read.
  std::string future = kCursorNote;
  future.replace(future.find("authorship/3.0.0"), 16, "authorship/4.0.0");
  addNote(fixture, "ai", sha, future);
  Json rewritten = provenanceOf(session, 12, repoId, {sha});
  EXPECT_EQ(rewritten[sha]["note"], Json({{"read", false}, {"schemaVersion", "authorship/4.0.0"}}));
  ASSERT_EQ(rewritten[sha]["declarations"].size(), 1u);
  EXPECT_EQ(rewritten[sha]["declarations"][0]["source"], "trailer");
}

TEST(ProvenanceService, RejectsWhatIsNotAListOfFullShas) {
  FixtureRepo fixture;
  InteractiveSession session;
  const std::string repoId = discoverRepo(session, fixture.root());
  const auto code = [&](std::int64_t id, Json shas) {
    Json response =
        session.request(req(id, "commit/provenance", {{"repoId", repoId}, {"shas", shas}}));
    return response.contains("error") ? response["error"].value("code", 0) : 0;
  };
  const int invalid = static_cast<int>(ErrorCode::InvalidParams);
  EXPECT_EQ(code(10, Json::array()), invalid);
  EXPECT_EQ(code(11, {"HEAD"}), invalid);
  EXPECT_EQ(code(12, {rev(fixture, "HEAD").substr(0, 12)}), invalid);
  EXPECT_EQ(code(13, {std::string(40, 'A')}), invalid);
  Json tooMany = Json::array();
  for (int i = 0; i < 1001; ++i) tooMany.push_back(std::string(40, 'a'));
  EXPECT_EQ(code(14, tooMany), invalid);
}

TEST(NotesService, ReadsNotesFromTheRefAsked) {
  FixtureRepo fixture;
  const std::string first = rev(fixture, "HEAD");
  commitMessage(fixture, "second\n");
  const std::string second = rev(fixture, "HEAD");
  addNote(fixture, "ai", second, kCursorNote);
  addNote(fixture, "review", first, "Looked at in review.\n");

  InteractiveSession session;
  const std::string repoId = discoverRepo(session, fixture.root());

  Json ai = session.request(req(10, "notes/read", {{"repoId", repoId}, {"shas", {first, second}}}));
  ASSERT_TRUE(ai.contains("result")) << ai.dump();
  EXPECT_EQ(ai["result"], Json({{"ref", "refs/notes/ai"},
                                {"exists", true},
                                {"notes", {{second, kCursorNote}}},
                                {"omitted", Json::array()}}));

  Json review = session.request(
      req(11, "notes/read",
          {{"repoId", repoId}, {"shas", {first, second}}, {"ref", "refs/notes/review"}}));
  EXPECT_EQ(review["result"]["notes"], Json({{first, "Looked at in review.\n"}}));

  Json none = session.request(
      req(12, "notes/read", {{"repoId", repoId}, {"shas", {first}}, {"ref", "refs/notes/x"}}));
  EXPECT_EQ(none["result"], Json({{"ref", "refs/notes/x"},
                                  {"exists", false},
                                  {"notes", Json::object()},
                                  {"omitted", Json::array()}}));
}

TEST(NotesService, OmitsNotesTooLongToReturn) {
  FixtureRepo fixture;
  const std::string sha = rev(fixture, "HEAD");
  addNote(fixture, "ai", sha, std::string(services::kMaxNotesReadBytes + 1, 'x'));

  InteractiveSession session;
  const std::string repoId = discoverRepo(session, fixture.root());
  Json response = session.request(req(10, "notes/read", {{"repoId", repoId}, {"shas", {sha}}}));
  ASSERT_TRUE(response.contains("result")) << response.dump().substr(0, 200);
  EXPECT_EQ(response["result"]["notes"], Json::object());
  EXPECT_EQ(response["result"]["omitted"], Json::array({sha}));
}

TEST(NotesService, RejectsRefsOutsideRefsNotes) {
  FixtureRepo fixture;
  const std::string sha = rev(fixture, "HEAD");
  InteractiveSession session;
  const std::string repoId = discoverRepo(session, fixture.root());
  std::int64_t id = 10;
  for (const char* ref : {"refs/heads/main", "refs/notes/", "refs/notes/a..b", "ai"}) {
    Json response = session.request(
        req(id++, "notes/read", {{"repoId", repoId}, {"shas", {sha}}, {"ref", ref}}));
    ASSERT_TRUE(response.contains("error")) << ref << ": " << response.dump();
    EXPECT_EQ(response["error"]["code"], static_cast<int>(ErrorCode::InvalidParams)) << ref;
  }
}

TEST(NotesService, AddsTheFetchRefspecOnce) {
  FixtureRepo fixture;
  fixture.run("git remote add origin https://example.invalid/repo.git");
  InteractiveSession session;
  const std::string repoId = discoverRepo(session, fixture.root());

  Json added =
      session.request(req(10, "notes/addFetchRefspec", {{"repoId", repoId}, {"remote", "origin"}}));
  ASSERT_TRUE(added.contains("result")) << added.dump();
  EXPECT_EQ(added["result"], Json({{"added", true}}));
  EXPECT_EQ(gg::testing::gitLines(fixture.root(), "config --get-all remote.origin.fetch"),
            (std::vector<std::string>{"+refs/heads/*:refs/remotes/origin/*",
                                      "+refs/notes/ai:refs/notes/ai"}));

  Json again =
      session.request(req(11, "notes/addFetchRefspec", {{"repoId", repoId}, {"remote", "origin"}}));
  EXPECT_EQ(again["result"], Json({{"added", false}}));
  EXPECT_EQ(gg::testing::gitLines(fixture.root(), "config --get-all remote.origin.fetch").size(),
            2u);

  // A wildcard that maps every notes ref onto itself already covers it.
  fixture.run("git remote add mirror https://example.invalid/mirror.git");
  fixture.run("git config --add remote.mirror.fetch \"+refs/notes/*:refs/notes/*\"");
  Json covered =
      session.request(req(12, "notes/addFetchRefspec", {{"repoId", repoId}, {"remote", "mirror"}}));
  EXPECT_EQ(covered["result"], Json({{"added", false}}));

  Json unknown = session.request(
      req(13, "notes/addFetchRefspec", {{"repoId", repoId}, {"remote", "upstream"}}));
  ASSERT_TRUE(unknown.contains("error")) << unknown.dump();
  EXPECT_EQ(unknown["error"]["code"], static_cast<int>(ErrorCode::InvalidParams));
}

}  // namespace
}  // namespace gg
