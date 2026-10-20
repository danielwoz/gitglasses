// Publishing a branch, pulling a branch that diverged, and what merge-like
// operations report when they stop: conflicts only when the index has them,
// otherwise git's own reason, with the operation left in progress named so
// it can be continued or aborted (mutate/sequencer).

#include <gtest/gtest.h>
#include <nlohmann/json.hpp>

#include <chrono>
#include <filesystem>
#include <fstream>
#include <memory>
#include <string>
#include <thread>

#include "exec/git_runner.h"
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

std::string config(const std::filesystem::path& root, const std::string& key) {
  return trimmed(gg::testing::gitCapture(root, "config --local " + key, /*quiet=*/true));
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

// A repository with a bare remote of each listed name, and a new branch
// `topic` with one commit that no remote has.
FixtureRepo& withRemotes(FixtureRepo& fixture, const std::vector<std::string>& names) {
  for (const auto& name : names) {
    fixture.run("git init -q --bare " + name + ".git");
    fixture.run("git remote add " + name + " " + name + ".git");
  }
  fixture.run("git switch -q -c topic");
  commitFile(fixture, "topic.txt", "topic\n", "topic work");
  return fixture;
}

bool hasBranch(const std::filesystem::path& bare, const std::string& branch) {
  return !rev(bare, "refs/heads/" + branch).empty();
}

// --- Publishing ------------------------------------------------------------------

TEST(Publish, GoesToTheOnlyRemoteWhateverItIsCalled) {
  FixtureRepo fixture;
  withRemotes(fixture, {"upstream"});
  InteractiveSession session;
  const std::string repoId = discover(session, fixture.root());

  const Json push =
      session.request(req(3, "mutate/push", {{"repoId", repoId}, {"setUpstream", true}}));
  ASSERT_TRUE(push.contains("result")) << push.dump();
  EXPECT_EQ(push["result"]["remote"], "upstream");
  EXPECT_TRUE(hasBranch(fixture.root() / "upstream.git", "topic"));
  EXPECT_EQ(config(fixture.root(), "branch.topic.remote"), "upstream");
}

TEST(Publish, FollowsPushDefaultInAForkWorkflow) {
  FixtureRepo fixture;
  withRemotes(fixture, {"origin", "mine"});
  fixture.run("git config remote.pushDefault mine");
  InteractiveSession session;
  const std::string repoId = discover(session, fixture.root());

  const Json push =
      session.request(req(3, "mutate/push", {{"repoId", repoId}, {"setUpstream", true}}));
  ASSERT_TRUE(push.contains("result")) << push.dump();
  EXPECT_EQ(push["result"]["remote"], "mine");
  EXPECT_TRUE(hasBranch(fixture.root() / "mine.git", "topic"));
  EXPECT_FALSE(hasBranch(fixture.root() / "origin.git", "topic"));
}

TEST(Publish, BranchPushRemoteWinsOverPushDefault) {
  FixtureRepo fixture;
  withRemotes(fixture, {"origin", "mine", "theirs"});
  fixture.run("git config remote.pushDefault mine");
  fixture.run("git config branch.topic.pushRemote theirs");
  InteractiveSession session;
  const std::string repoId = discover(session, fixture.root());

  const Json push =
      session.request(req(3, "mutate/push", {{"repoId", repoId}, {"setUpstream", true}}));
  ASSERT_TRUE(push.contains("result")) << push.dump();
  EXPECT_EQ(push["result"]["remote"], "theirs");
  EXPECT_TRUE(hasBranch(fixture.root() / "theirs.git", "topic"));
}

// Several remotes and nothing configured: origin is not picked just for its
// name; the caller is asked to choose, and can.
TEST(Publish, SeveralRemotesWithoutADefaultAskForAChoice) {
  FixtureRepo fixture;
  withRemotes(fixture, {"origin", "mine"});
  InteractiveSession session;
  const std::string repoId = discover(session, fixture.root());

  const Json ambiguous =
      session.request(req(3, "mutate/push", {{"repoId", repoId}, {"setUpstream", true}}));
  ASSERT_TRUE(ambiguous.contains("error")) << ambiguous.dump();
  EXPECT_EQ(ambiguous["error"]["code"], static_cast<int>(ErrorCode::GitError));
  EXPECT_EQ(ambiguous["error"]["data"]["kind"], "noRemote");
  EXPECT_EQ(ambiguous["error"]["data"]["remotes"], Json::array({"mine", "origin"}));
  EXPECT_FALSE(hasBranch(fixture.root() / "origin.git", "topic"));

  const Json chosen = session.request(
      req(4, "mutate/push", {{"repoId", repoId}, {"setUpstream", true}, {"remote", "mine"}}));
  ASSERT_TRUE(chosen.contains("result")) << chosen.dump();
  EXPECT_TRUE(hasBranch(fixture.root() / "mine.git", "topic"));

  const Json optionLike = session.request(
      req(5, "mutate/push", {{"repoId", repoId}, {"setUpstream", true}, {"remote", "--mirror"}}));
  EXPECT_EQ(optionLike["error"]["code"], static_cast<int>(ErrorCode::InvalidParams));
}

TEST(Publish, NoRemoteAtAllSaysSo) {
  FixtureRepo fixture;
  withRemotes(fixture, {});
  InteractiveSession session;
  const std::string repoId = discover(session, fixture.root());
  const Json push =
      session.request(req(3, "mutate/push", {{"repoId", repoId}, {"setUpstream", true}}));
  ASSERT_TRUE(push.contains("error")) << push.dump();
  EXPECT_EQ(push["error"]["data"]["kind"], "noRemote");
  EXPECT_EQ(push["error"]["data"]["remotes"], Json::array());
}

// PuTTY's plink never runs SSH_ASKPASS; a failure through it says so.
TEST(Publish, AFailureThroughPlinkSaysSo) {
  FixtureRepo fixture;
  withRemotes(fixture, {});
  fixture.run("git remote add origin \"fakehost:/nowhere.git\"");
  fixture.run("git config core.sshCommand \"" + (fixture.root() / "PLINK.EXE").string() + "\"");
  InteractiveSession session;
  const std::string repoId = discover(session, fixture.root());
  const Json fetch = session.request(req(3, "mutate/fetch", {{"repoId", repoId}}));
  ASSERT_TRUE(fetch.contains("error")) << fetch.dump();
  EXPECT_EQ(fetch["error"]["data"]["sshProgram"], "plink") << fetch.dump();

  fixture.run("git config --unset core.sshCommand");
  const Json plain = session.request(req(4, "mutate/fetch", {{"repoId", repoId}}));
  ASSERT_TRUE(plain.contains("error")) << plain.dump();
  EXPECT_FALSE(plain["error"].contains("data") && plain["error"]["data"].contains("sshProgram"))
      << plain.dump();
}

// --- Pulling a diverged branch -------------------------------------------------------

// main has one commit the remote lacks and the remote one main lacks.
struct DivergedClone {
  FixtureRepo fixture;
  std::filesystem::path other;

  explicit DivergedClone(bool conflicting = false) {
    commitFile(fixture, "shared.txt", "base\n", "base");
    fixture.run("git clone --bare -q . origin.git");
    fixture.run("git remote add origin origin.git");
    fixture.run("git fetch -q origin");
    fixture.run("git branch -q --set-upstream-to=origin/main");
    fixture.run("git clone -q origin.git other");
    other = fixture.root() / "other";
    gg::testing::runGit(other, "git config user.name Other");
    gg::testing::runGit(other, "git config user.email other@example.invalid");
    std::ofstream(other / (conflicting ? "shared.txt" : "theirs.txt"), std::ios::binary)
        << "theirs\n";
    gg::testing::runGit(other, "git add -A");
    gg::testing::runGit(other, "git commit -q -m theirs");
    gg::testing::runGit(other, "git push -q origin main");
    // Keeps the remote and its other clone out of the status the tests read.
    std::ofstream(fixture.root() / ".git" / "info" / "exclude", std::ios::app)
        << "other/\norigin.git/\n";
    commitFile(fixture, conflicting ? "shared.txt" : "ours.txt", "ours\n", "ours");
  }
};

TEST(PullStrategy, DivergedWithoutAConfiguredStrategyAsksForOne) {
  DivergedClone repo;
  InteractiveSession session;
  const std::string repoId = discover(session, repo.fixture.root());
  const Json pull = session.request(req(3, "mutate/pull", {{"repoId", repoId}}));
  ASSERT_TRUE(pull.contains("error")) << pull.dump();
  EXPECT_EQ(pull["error"]["data"]["kind"], "divergent") << pull.dump();
}

TEST(PullStrategy, MergeRebaseAndFastForwardOnly) {
  {
    DivergedClone repo;
    InteractiveSession session;
    const std::string repoId = discover(session, repo.fixture.root());
    const Json merge = session.request(
        req(3, "mutate/pull", {{"repoId", repoId}, {"strategy", "merge"}, {"autoStash", true}}));
    ASSERT_TRUE(merge.contains("result")) << merge.dump();
    EXPECT_FALSE(merge["result"]["conflicts"].get<bool>());
    EXPECT_FALSE(rev(repo.fixture.root(), "HEAD^2").empty()) << "expected a merge commit";
    EXPECT_EQ(config(repo.fixture.root(), "pull.rebase"), "") << "nothing remembered";
  }
  {
    DivergedClone repo;
    InteractiveSession session;
    const std::string repoId = discover(session, repo.fixture.root());
    const Json rebase =
        session.request(req(3, "mutate/pull", {{"repoId", repoId}, {"strategy", "rebase"}}));
    ASSERT_TRUE(rebase.contains("result")) << rebase.dump();
    EXPECT_TRUE(rev(repo.fixture.root(), "HEAD^2").empty()) << "a rebase makes no merge commit";
    EXPECT_EQ(rev(repo.fixture.root(), "HEAD~1"), rev(repo.fixture.root(), "origin/main"));
  }
  {
    DivergedClone repo;
    InteractiveSession session;
    const std::string repoId = discover(session, repo.fixture.root());
    const Json ffOnly =
        session.request(req(3, "mutate/pull", {{"repoId", repoId}, {"strategy", "ff-only"}}));
    ASSERT_TRUE(ffOnly.contains("error")) << ffOnly.dump();
    EXPECT_EQ(ffOnly["error"]["data"]["kind"], "divergent") << ffOnly.dump();
  }
}

TEST(PullStrategy, RememberedStrategyIsUsedByLaterPulls) {
  DivergedClone repo;
  repo.fixture.run("git config pull.ff only");
  InteractiveSession session;
  const std::string repoId = discover(session, repo.fixture.root());
  const Json merge = session.request(
      req(3, "mutate/pull", {{"repoId", repoId}, {"strategy", "merge"}, {"remember", true}}));
  ASSERT_TRUE(merge.contains("result")) << merge.dump();
  EXPECT_EQ(config(repo.fixture.root(), "pull.rebase"), "false");
  EXPECT_EQ(config(repo.fixture.root(), "pull.ff"), "true");

  const Json bad =
      session.request(req(4, "mutate/pull", {{"repoId", repoId}, {"strategy", "octopus"}}));
  EXPECT_EQ(bad["error"]["code"], static_cast<int>(ErrorCode::InvalidParams));
  const Json orphanRemember =
      session.request(req(5, "mutate/pull", {{"repoId", repoId}, {"remember", true}}));
  EXPECT_EQ(orphanRemember["error"]["code"], static_cast<int>(ErrorCode::InvalidParams));
}

// A merge that conflicts reports conflicts, as merge does; git prints its
// CONFLICT lines on stdout, so the old stderr-only error said nothing useful.
TEST(PullStrategy, AConflictingPullReportsConflicts) {
  DivergedClone repo(/*conflicting=*/true);
  InteractiveSession session;
  const std::string repoId = discover(session, repo.fixture.root());
  const Json pull =
      session.request(req(3, "mutate/pull", {{"repoId", repoId}, {"strategy", "merge"}}));
  ASSERT_TRUE(pull.contains("result")) << pull.dump();
  EXPECT_TRUE(pull["result"]["conflicts"].get<bool>());
  EXPECT_TRUE(std::filesystem::exists(repo.fixture.root() / ".git" / "MERGE_HEAD"));
}

// --- Stops that are not conflicts ------------------------------------------------------

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

// `left` and `main` both change c.txt; returns the sha of the commit on
// `left`, with `main` checked out.
std::string conflictingBranches(FixtureRepo& fixture) {
  commitFile(fixture, "c.txt", "base\n", "base");
  fixture.run("git switch -q -c left");
  commitFile(fixture, "c.txt", "left\n", "left");
  const std::string left = rev(fixture.root(), "HEAD");
  fixture.run("git switch -q main");
  commitFile(fixture, "c.txt", "right\n", "right");
  return left;
}

// The result describes the repository after git ran: an abandoned
// conflicted merge has no conflicts left.
TEST(StoppedOperation, AbortingAConflictedMergeLeavesNoConflicts) {
  FixtureRepo fixture;
  conflictingBranches(fixture);
  InteractiveSession session;
  const std::string repoId = discover(session, fixture.root());
  const Json merge = session.request(req(3, "mutate/merge", {{"repoId", repoId}, {"ref", "left"}}));
  ASSERT_TRUE(merge["result"]["conflicts"].get<bool>()) << merge.dump();

  const Json abort =
      session.request(req(4, "mutate/sequencer", {{"repoId", repoId}, {"action", "abort"}}));
  ASSERT_TRUE(abort.contains("result")) << abort.dump();
  EXPECT_EQ(abort["result"]["operation"], "merge");
  EXPECT_FALSE(abort["result"]["conflicts"].get<bool>()) << abort.dump();
  EXPECT_TRUE(abort["result"]["completed"].get<bool>()) << abort.dump();
  EXPECT_FALSE(std::filesystem::exists(fixture.root() / ".git" / "MERGE_HEAD"));
}

TEST(StoppedOperation, SkippingAConflictedCherryPickLeavesNoConflicts) {
  FixtureRepo fixture;
  const std::string left = conflictingBranches(fixture);
  InteractiveSession session;
  const std::string repoId = discover(session, fixture.root());
  const Json pick = session.request(
      req(3, "mutate/cherryPick", {{"repoId", repoId}, {"shas", Json::array({left})}}));
  ASSERT_TRUE(pick["result"]["conflicts"].get<bool>()) << pick.dump();

  const Json skip =
      session.request(req(4, "mutate/sequencer", {{"repoId", repoId}, {"action", "skip"}}));
  ASSERT_TRUE(skip.contains("result")) << skip.dump();
  EXPECT_EQ(skip["result"]["operation"], "cherry-pick");
  EXPECT_FALSE(skip["result"]["conflicts"].get<bool>()) << skip.dump();
  EXPECT_TRUE(skip["result"]["completed"].get<bool>()) << skip.dump();
  EXPECT_FALSE(std::filesystem::exists(fixture.root() / ".git" / "CHERRY_PICK_HEAD"));
}

// Continuing a rebase whose next step conflicts too is a new set of
// conflicts to resolve, not a failure.
TEST(StoppedOperation, ContinuingIntoAnotherConflictingStepReportsConflicts) {
  FixtureRepo fixture;
  commitFile(fixture, "c.txt", "base\n", "base");
  fixture.run("git switch -q -c topic");
  commitFile(fixture, "c.txt", "one\n", "t1");
  commitFile(fixture, "c.txt", "two\n", "t2");
  const std::string t1 = rev(fixture.root(), "HEAD~1");
  const std::string t2 = rev(fixture.root(), "HEAD");
  fixture.run("git switch -q main");
  commitFile(fixture, "c.txt", "main\n", "main");
  fixture.run("git switch -q topic");

  InteractiveSession session;
  const std::string repoId = discover(session, fixture.root());
  const Json start = session.request(
      req(3, "rebase/start",
          {{"repoId", repoId},
           {"upstream", "main"},
           {"plan", Json::array({{{"action", "pick"}, {"sha", t1}, {"summary", "t1"}},
                                 {{"action", "pick"}, {"sha", t2}, {"summary", "t2"}}})}}));
  ASSERT_TRUE(start.contains("result")) << start.dump();
  ASSERT_TRUE(start["result"]["conflicts"].get<bool>()) << start.dump();

  fixture.writeFile("c.txt", "first resolution\n");
  fixture.run("git add c.txt");
  const Json next =
      session.request(req(4, "mutate/sequencer", {{"repoId", repoId}, {"action", "continue"}}));
  ASSERT_TRUE(next.contains("result")) << next.dump();
  EXPECT_EQ(next["result"]["operation"], "rebase");
  EXPECT_TRUE(next["result"]["conflicts"].get<bool>()) << next.dump();
  EXPECT_FALSE(next["result"]["completed"].get<bool>()) << next.dump();

  fixture.writeFile("c.txt", "second resolution\n");
  fixture.run("git add c.txt");
  const Json done =
      session.request(req(5, "mutate/sequencer", {{"repoId", repoId}, {"action", "continue"}}));
  ASSERT_TRUE(done.contains("result")) << done.dump();
  EXPECT_TRUE(done["result"]["completed"].get<bool>()) << done.dump();
  EXPECT_FALSE(done["result"]["conflicts"].get<bool>()) << done.dump();
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

#ifndef _WIN32
// A cancelled git gets SIGTERM first, so it removes its lock files: the
// repository is usable right after a cancelled commit.
TEST(Cancellation, ACancelledCommitLeavesNoIndexLock) {
  FixtureRepo fixture;
  fixture.writeFile(".git/hooks/pre-commit", "#!/bin/sh\nsleep 30\n");
  std::filesystem::permissions(fixture.root() / ".git" / "hooks" / "pre-commit",
                               std::filesystem::perms::owner_all);
  fixture.writeFile("README.md", "changed\n");
  const std::filesystem::path lock = fixture.root() / ".git" / "index.lock";

  // `commit -a` holds the index lock while its hooks run.
  CancelSource source;
  std::thread canceller([&] {
    const auto giveUp = std::chrono::steady_clock::now() + std::chrono::seconds(10);
    while (!std::filesystem::exists(lock) && std::chrono::steady_clock::now() < giveUp) {
      std::this_thread::sleep_for(std::chrono::milliseconds(10));
    }
    source.cancel();
  });
  bool cancelled = false;
  try {
    (void)exec::runGit(fixture.root().string(), {"commit", "-a", "-q", "-m", "slow"}, {},
                       source.token(), [](std::string) {});
  } catch (const CancelledError&) {
    cancelled = true;
  }
  canceller.join();
  EXPECT_TRUE(cancelled);
  EXPECT_FALSE(std::filesystem::exists(lock)) << "the cancelled commit left its lock behind";
}

// When the client goes away the engine stops the git it runs instead of
// waiting for a fetch that may take minutes.
TEST(EngineExit, ClosingStdinStopsAHungFetchPromptly) {
  FixtureRepo fixture;
  fixture.run("git clone --bare -q . upstream.git");
  fixture.writeFile("slow-upload-pack", "#!/bin/sh\nsleep 60\nexec git-upload-pack \"$@\"\n");
  std::filesystem::permissions(fixture.root() / "slow-upload-pack",
                               std::filesystem::perms::owner_all);
  fixture.run("git remote add origin upstream.git");
  fixture.run("git config remote.origin.uploadpack \"" +
              (fixture.root() / "slow-upload-pack").string() + "\"");

  auto session = std::make_unique<InteractiveSession>();
  const std::string repoId = discover(*session, fixture.root());
  session->notify(req(3, "mutate/fetch", {{"repoId", repoId}}));
  std::this_thread::sleep_for(std::chrono::milliseconds(300));
  const auto closed = std::chrono::steady_clock::now();
  session.reset();
  const auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(
      std::chrono::steady_clock::now() - closed);
  EXPECT_LT(elapsed.count(), 10000) << "the engine waited for the fetch to finish";
}
#endif

}  // namespace
}  // namespace gg
