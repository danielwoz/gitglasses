// What merge-like operations report when they stop: conflicts only when the
// index has them, otherwise git's own reason, with the operation left in
// progress named so it can be continued or aborted (mutate/sequencer).

#include <gtest/gtest.h>
#include <nlohmann/json.hpp>

#include <filesystem>
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

std::string trimmed(std::string text) {
  while (!text.empty() && (text.back() == '\n' || text.back() == '\r')) text.pop_back();
  return text;
}

// The commit `spec` names, or empty when it names none.
std::string rev(const std::filesystem::path& root, const std::string& spec) {
  return trimmed(gg::testing::gitCapture(root, "rev-parse --verify -q " + spec, /*quiet=*/true));
}

void commitFile(FixtureRepo& fixture, const std::string& file, const std::string& contents,
                const std::string& message) {
  fixture.writeFile(file, contents);
  fixture.run("git add " + file);
  fixture.commit(message);
}

std::string discover(InteractiveSession& session, const std::filesystem::path& root) {
  session.request(initRequest(1));
  const Json found = session.request(req(2, "repo/discover", {{"path", root.string()}}));
  return found["result"].value("repoId", "");
}

// Two branches that merge cleanly, with signing switched on and a gpg that
// always fails.
struct FailingSigner {
  FixtureRepo fixture;
  FailingSigner() {
    fixture.run("git switch -q -c side");
    commitFile(fixture, "side.txt", "side\n", "side work");
    fixture.run("git switch -q main");
    commitFile(fixture, "main.txt", "main\n", "main work");
    fixture.run("git config commit.gpgsign true");
    fixture.run("git config gpg.program false");
  }
};

TEST(StoppedOperation, ASigningFailureIsNotReportedAsConflicts) {
  FailingSigner repo;
  InteractiveSession session;
  const std::string repoId = discover(session, repo.fixture.root());
  const Json merge = session.request(
      req(3, "mutate/merge", {{"repoId", repoId}, {"ref", "side"}, {"noFf", true}}));
  ASSERT_TRUE(merge.contains("error")) << merge.dump();
  EXPECT_EQ(merge["error"]["code"], static_cast<int>(ErrorCode::GitError));
  EXPECT_NE(merge["error"]["message"].get<std::string>().find("gpg failed to sign"),
            std::string::npos)
      << merge.dump();
  EXPECT_EQ(merge["error"]["data"]["kind"], "signing") << merge.dump();
  EXPECT_EQ(merge["error"]["data"]["operation"], "merge") << merge.dump();

  // The merge is left in progress and can be abandoned.
  const Json abort =
      session.request(req(4, "mutate/sequencer", {{"repoId", repoId}, {"action", "abort"}}));
  ASSERT_TRUE(abort.contains("result")) << abort.dump();
  EXPECT_EQ(abort["result"]["operation"], "merge");
  EXPECT_TRUE(abort["result"]["completed"].get<bool>());
  EXPECT_FALSE(std::filesystem::exists(repo.fixture.root() / ".git" / "MERGE_HEAD"));
}

TEST(StoppedOperation, ACherryPickThatBecomesEmptyCanBeSkipped) {
  FixtureRepo fixture;
  fixture.run("git switch -q -c side");
  commitFile(fixture, "same.txt", "same\n", "on side");
  const std::string picked = rev(fixture.root(), "HEAD");
  fixture.run("git switch -q main");
  commitFile(fixture, "same.txt", "same\n", "already on main");

  InteractiveSession session;
  const std::string repoId = discover(session, fixture.root());
  const Json pick = session.request(
      req(3, "mutate/cherryPick", {{"repoId", repoId}, {"shas", Json::array({picked})}}));
  ASSERT_TRUE(pick.contains("error")) << pick.dump();
  EXPECT_EQ(pick["error"]["data"]["kind"], "emptyCommit") << pick.dump();
  EXPECT_EQ(pick["error"]["data"]["operation"], "cherry-pick") << pick.dump();

  const Json skip =
      session.request(req(4, "mutate/sequencer", {{"repoId", repoId}, {"action", "skip"}}));
  ASSERT_TRUE(skip.contains("result")) << skip.dump();
  EXPECT_TRUE(skip["result"]["completed"].get<bool>());
  EXPECT_FALSE(std::filesystem::exists(fixture.root() / ".git" / "CHERRY_PICK_HEAD"));
}

TEST(StoppedOperation, ContinuingWaitsForConflictsToBeResolved) {
  FixtureRepo fixture;
  commitFile(fixture, "c.txt", "base\n", "base");
  fixture.run("git switch -q -c left");
  commitFile(fixture, "c.txt", "left\n", "left");
  fixture.run("git switch -q main");
  commitFile(fixture, "c.txt", "right\n", "right");

  InteractiveSession session;
  const std::string repoId = discover(session, fixture.root());
  const Json merge = session.request(req(3, "mutate/merge", {{"repoId", repoId}, {"ref", "left"}}));
  ASSERT_TRUE(merge["result"]["conflicts"].get<bool>()) << merge.dump();

  const Json early =
      session.request(req(4, "mutate/sequencer", {{"repoId", repoId}, {"action", "continue"}}));
  ASSERT_TRUE(early.contains("result")) << early.dump();
  EXPECT_TRUE(early["result"]["conflicts"].get<bool>());
  EXPECT_FALSE(early["result"]["completed"].get<bool>());

  fixture.writeFile("c.txt", "resolved\n");
  fixture.run("git add c.txt");
  const Json done =
      session.request(req(5, "mutate/sequencer", {{"repoId", repoId}, {"action", "continue"}}));
  ASSERT_TRUE(done.contains("result")) << done.dump();
  EXPECT_TRUE(done["result"]["completed"].get<bool>());
  EXPECT_FALSE(rev(fixture.root(), "HEAD^2").empty()) << "the merge commit was not made";

  const Json idle =
      session.request(req(6, "mutate/sequencer", {{"repoId", repoId}, {"action", "abort"}}));
  ASSERT_TRUE(idle.contains("error")) << idle.dump();
  const Json skipMerge =
      session.request(req(7, "mutate/sequencer", {{"repoId", repoId}, {"action", "jump"}}));
  EXPECT_EQ(skipMerge["error"]["code"], static_cast<int>(ErrorCode::InvalidParams));
}

TEST(StoppedOperation, ARebaseStoppedBySigningIsNotReportedAsConflicts) {
  FailingSigner repo;
  InteractiveSession session;
  const std::string repoId = discover(session, repo.fixture.root());
  const Json start =
      session.request(req(3, "rebase/start",
                          {{"repoId", repoId},
                           {"upstream", "side"},
                           {"plan", Json::array({{{"action", "pick"},
                                                  {"sha", rev(repo.fixture.root(), "main")},
                                                  {"summary", "main work"}}})}}));
  ASSERT_TRUE(start.contains("error")) << start.dump();
  EXPECT_EQ(start["error"]["data"]["operation"], "rebase") << start.dump();
  EXPECT_EQ(start["error"]["data"]["kind"], "signing") << start.dump();
  const Json abort =
      session.request(req(4, "mutate/sequencer", {{"repoId", repoId}, {"action", "abort"}}));
  ASSERT_TRUE(abort.contains("result")) << abort.dump();
  EXPECT_EQ(abort["result"]["operation"], "rebase");
}

// git explains some failures on stdout only; the error carries that text
// instead of an empty message.
TEST(StoppedOperation, AFailureExplainedOnStdoutKeepsTheExplanation) {
  FixtureRepo fixture;
  InteractiveSession session;
  const std::string repoId = discover(session, fixture.root());
  const Json commit =
      session.request(req(3, "mutate/commit", {{"repoId", repoId}, {"message", "nothing"}}));
  ASSERT_TRUE(commit.contains("error")) << commit.dump();
  EXPECT_NE(commit["error"]["message"].get<std::string>().find("nothing to commit"),
            std::string::npos)
      << commit.dump();
}

}  // namespace
}  // namespace gg
