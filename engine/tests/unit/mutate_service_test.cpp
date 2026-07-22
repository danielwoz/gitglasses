// End-to-end tests for mutate/*, stash/* and worktree/*, driven through the
// full server loop. Git's own CLI output is the parity oracle.

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

std::string currentBranch(const std::filesystem::path& root) {
  std::string name = gitOut(root, "branch --show-current");
  while (!name.empty() && name.back() == '\n') name.pop_back();
  return name;
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

Json statusSummary(InteractiveSession& session, std::int64_t id, const std::string& repoId) {
  Json response = session.request(req(id, "status/summary", {{"repoId", repoId}}));
  EXPECT_TRUE(response.contains("result")) << response.dump();
  return response["result"];
}

bool hasPath(const Json& changes, const std::string& path) {
  for (const auto& change : changes) {
    if (change["path"] == path) return true;
  }
  return false;
}

Json headState(InteractiveSession& session, std::int64_t id, const std::string& repoId) {
  Json response = session.request(req(id, "repo/state", {{"repoId", repoId}}));
  EXPECT_TRUE(response.contains("result")) << response.dump();
  return response["result"]["head"];
}

TEST(MutateService, CommitAmendAndSignoff) {
  FixtureRepo fixture;
  fixture.writeFile("a.txt", "one\n");
  fixture.run("git add a.txt");

  InteractiveSession session;
  const std::string repoId = discoverRepo(session, fixture.root());
  const std::string before = rev(fixture.root(), "HEAD");

  Json commit =
      session.request(req(10, "mutate/commit", {{"repoId", repoId}, {"message", "add a"}}));
  ASSERT_TRUE(commit.contains("result")) << commit.dump();
  const std::string sha = commit["result"]["sha"];
  EXPECT_EQ(sha, rev(fixture.root(), "HEAD"));
  EXPECT_NE(sha, before);
  EXPECT_EQ(gitOut(fixture.root(), "log -1 --format=%s"), "add a\n");

  Json amend = session.request(req(
      11, "mutate/commit", {{"repoId", repoId}, {"message", "add a (amended)"}, {"amend", true}}));
  ASSERT_TRUE(amend.contains("result")) << amend.dump();
  const std::string amended = amend["result"]["sha"];
  EXPECT_NE(amended, sha);
  EXPECT_EQ(amended, rev(fixture.root(), "HEAD"));
  EXPECT_EQ(gitOut(fixture.root(), "log -1 --format=%s"), "add a (amended)\n");
  EXPECT_EQ(rev(fixture.root(), "HEAD~1"), before);  // parent unchanged by amend

  fixture.writeFile("b.txt", "two\n");
  fixture.run("git add b.txt");
  Json signoff = session.request(
      req(12, "mutate/commit", {{"repoId", repoId}, {"message", "add b"}, {"signoff", true}}));
  ASSERT_TRUE(signoff.contains("result")) << signoff.dump();
  EXPECT_NE(gitOut(fixture.root(), "log -1 --format=%B")
                .find("Signed-off-by: Fixture <fixture@example.invalid>"),
            std::string::npos);

  Json empty =
      session.request(req(13, "mutate/commit", {{"repoId", repoId}, {"message", ""}}));
  EXPECT_EQ(empty["error"]["code"], -32602);
}

TEST(MutateService, BranchCreateSwitchDelete) {
  FixtureRepo fixture;
  InteractiveSession session;
  const std::string repoId = discoverRepo(session, fixture.root());
  const std::string mainSha = rev(fixture.root(), "HEAD");

  Json create =
      session.request(req(10, "mutate/branchCreate", {{"repoId", repoId}, {"name", "feature"}}));
  ASSERT_TRUE(create.contains("result")) << create.dump();
  EXPECT_EQ(rev(fixture.root(), "feature"), mainSha);
  EXPECT_EQ(currentBranch(fixture.root()), "main");  // no checkout requested

  Json switched =
      session.request(req(11, "mutate/switch", {{"repoId", repoId}, {"ref", "feature"}}));
  ASSERT_TRUE(switched.contains("result")) << switched.dump();
  EXPECT_EQ(currentBranch(fixture.root()), "feature");

  Json createCheckout = session.request(req(12, "mutate/branchCreate",
                                            {{"repoId", repoId},
                                             {"name", "feature2"},
                                             {"startPoint", "main"},
                                             {"checkout", true}}));
  ASSERT_TRUE(createCheckout.contains("result")) << createCheckout.dump();
  EXPECT_EQ(currentBranch(fixture.root()), "feature2");
  EXPECT_EQ(rev(fixture.root(), "feature2"), mainSha);

  session.request(req(13, "mutate/switch", {{"repoId", repoId}, {"ref", "main"}}));
  Json del =
      session.request(req(14, "mutate/branchDelete", {{"repoId", repoId}, {"name", "feature"}}));
  ASSERT_TRUE(del.contains("result")) << del.dump();
  EXPECT_EQ(gitOut(fixture.root(), "branch --list feature"), "");
  Json delForce = session.request(
      req(15, "mutate/branchDelete", {{"repoId", repoId}, {"name", "feature2"}, {"force", true}}));
  ASSERT_TRUE(delForce.contains("result")) << delForce.dump();

  Json missing =
      session.request(req(16, "mutate/branchDelete", {{"repoId", repoId}, {"name", "nope"}}));
  EXPECT_EQ(missing["error"]["code"], -32001);
}

TEST(MutateService, SwitchDetachesOnNonBranchRef) {
  FixtureRepo fixture;
  fixture.writeFile("d.txt", "detach\n");
  fixture.run("git add d.txt");
  commitTick(fixture, "second", 1);
  const std::string target = rev(fixture.root(), "HEAD~1");

  InteractiveSession session;
  const std::string repoId = discoverRepo(session, fixture.root());

  Json detach = session.request(req(10, "mutate/switch", {{"repoId", repoId}, {"ref", target}}));
  ASSERT_TRUE(detach.contains("result")) << detach.dump();
  Json head = headState(session, 11, repoId);
  EXPECT_TRUE(head["detached"].get<bool>());
  EXPECT_EQ(head["oid"], target);

  Json back = session.request(req(12, "mutate/switch", {{"repoId", repoId}, {"ref", "main"}}));
  ASSERT_TRUE(back.contains("result")) << back.dump();
  Json restored = headState(session, 13, repoId);
  EXPECT_FALSE(restored["detached"].get<bool>());
  EXPECT_EQ(restored["branch"], "main");
}

TEST(MutateService, MergeFastForwardAndTrueMerge) {
  FixtureRepo fixture;
  fixture.run("git switch -q -c feature");
  fixture.writeFile("f.txt", "feature\n");
  fixture.run("git add f.txt");
  commitTick(fixture, "feature work", 1);
  const std::string featureSha = rev(fixture.root(), "feature");
  fixture.run("git switch -q main");

  InteractiveSession session;
  const std::string repoId = discoverRepo(session, fixture.root());

  Json ff = session.request(req(10, "mutate/merge", {{"repoId", repoId}, {"ref", "feature"}}));
  ASSERT_TRUE(ff.contains("result")) << ff.dump();
  EXPECT_FALSE(ff["result"]["conflicts"].get<bool>());
  EXPECT_EQ(rev(fixture.root(), "HEAD"), featureSha);  // fast-forwarded

  // Diverge and merge for a true merge commit.
  fixture.run("git switch -q -c topic");
  fixture.writeFile("t.txt", "topic\n");
  fixture.run("git add t.txt");
  commitTick(fixture, "topic work", 2);
  fixture.run("git switch -q main");
  fixture.writeFile("m.txt", "main\n");
  fixture.run("git add m.txt");
  commitTick(fixture, "main work", 3);

  Json merge = session.request(
      req(11, "mutate/merge", {{"repoId", repoId}, {"ref", "topic"}, {"noFf", true}}));
  ASSERT_TRUE(merge.contains("result")) << merge.dump();
  EXPECT_FALSE(merge["result"]["conflicts"].get<bool>());
  EXPECT_FALSE(rev(fixture.root(), "HEAD^2").empty());  // two parents
  EXPECT_TRUE(std::filesystem::exists(fixture.root() / "t.txt"));
}

TEST(MutateService, MergeConflictThenResolveWithCommit) {
  FixtureRepo fixture;
  fixture.writeFile("c.txt", "base\n");
  fixture.run("git add c.txt");
  commitTick(fixture, "base", 1);
  fixture.run("git switch -q -c left");
  fixture.writeFile("c.txt", "left\n");
  fixture.run("git add c.txt");
  commitTick(fixture, "left", 2);
  fixture.run("git switch -q main");
  fixture.writeFile("c.txt", "right\n");
  fixture.run("git add c.txt");
  commitTick(fixture, "right", 3);

  InteractiveSession session;
  const std::string repoId = discoverRepo(session, fixture.root());

  Json merge = session.request(req(10, "mutate/merge", {{"repoId", repoId}, {"ref", "left"}}));
  ASSERT_TRUE(merge.contains("result")) << merge.dump();
  EXPECT_TRUE(merge["result"]["conflicts"].get<bool>());
  EXPECT_TRUE(std::filesystem::exists(fixture.root() / ".git/MERGE_HEAD"));
  Json summary = statusSummary(session, 11, repoId);
  EXPECT_EQ(summary["conflicted"], Json::array({"c.txt"}));

  // Manual resolution completes through mutate/commit.
  fixture.writeFile("c.txt", "merged\n");
  fixture.run("git add c.txt");
  Json commit =
      session.request(req(12, "mutate/commit", {{"repoId", repoId}, {"message", "merge left"}}));
  ASSERT_TRUE(commit.contains("result")) << commit.dump();
  EXPECT_FALSE(std::filesystem::exists(fixture.root() / ".git/MERGE_HEAD"));
  EXPECT_FALSE(rev(fixture.root(), "HEAD^2").empty());  // merge commit landed
  EXPECT_EQ(gitOut(fixture.root(), "log -1 --format=%s"), "merge left\n");
}

TEST(MutateService, CherryPickCleanMultipleAndConflict) {
  FixtureRepo fixture;
  fixture.run("git switch -q -c side");
  fixture.writeFile("cp1.txt", "one\n");
  fixture.run("git add cp1.txt");
  commitTick(fixture, "side one", 1);
  const std::string pick1 = rev(fixture.root(), "HEAD");
  fixture.writeFile("cp2.txt", "two\n");
  fixture.run("git add cp2.txt");
  commitTick(fixture, "side two", 2);
  const std::string pick2 = rev(fixture.root(), "HEAD");
  fixture.writeFile("README.md", "side edit\n");
  fixture.run("git add README.md");
  commitTick(fixture, "side readme", 3);
  const std::string conflictSha = rev(fixture.root(), "HEAD");
  fixture.run("git switch -q main");
  fixture.writeFile("README.md", "main edit\n");
  fixture.run("git add README.md");
  commitTick(fixture, "main readme", 4);

  InteractiveSession session;
  const std::string repoId = discoverRepo(session, fixture.root());

  Json clean = session.request(
      req(10, "mutate/cherryPick", {{"repoId", repoId}, {"shas", {pick1, pick2}}}));
  ASSERT_TRUE(clean.contains("result")) << clean.dump();
  EXPECT_FALSE(clean["result"]["conflicts"].get<bool>());
  EXPECT_TRUE(std::filesystem::exists(fixture.root() / "cp1.txt"));
  EXPECT_TRUE(std::filesystem::exists(fixture.root() / "cp2.txt"));
  EXPECT_EQ(gitOut(fixture.root(), "log -2 --format=%s"), "side two\nside one\n");

  Json conflict = session.request(
      req(11, "mutate/cherryPick", {{"repoId", repoId}, {"shas", {conflictSha}}}));
  ASSERT_TRUE(conflict.contains("result")) << conflict.dump();
  EXPECT_TRUE(conflict["result"]["conflicts"].get<bool>());
  EXPECT_TRUE(std::filesystem::exists(fixture.root() / ".git/CHERRY_PICK_HEAD"));
  fixture.run("git cherry-pick --abort");

  Json bad = session.request(
      req(12, "mutate/cherryPick", {{"repoId", repoId}, {"shas", Json::array()}}));
  EXPECT_EQ(bad["error"]["code"], -32602);
}

TEST(MutateService, RevertRemovesCommittedFile) {
  FixtureRepo fixture;
  fixture.writeFile("r.txt", "doomed\n");
  fixture.run("git add r.txt");
  commitTick(fixture, "add r", 1);
  const std::string sha = rev(fixture.root(), "HEAD");

  InteractiveSession session;
  const std::string repoId = discoverRepo(session, fixture.root());

  Json revert =
      session.request(req(10, "mutate/revert", {{"repoId", repoId}, {"shas", {sha}}}));
  ASSERT_TRUE(revert.contains("result")) << revert.dump();
  EXPECT_FALSE(revert["result"]["conflicts"].get<bool>());
  EXPECT_FALSE(std::filesystem::exists(fixture.root() / "r.txt"));
  EXPECT_EQ(gitOut(fixture.root(), "log -1 --format=%s"), "Revert \"add r\"\n");
}

TEST(MutateService, ResetSoftMixedHard) {
  FixtureRepo fixture;
  fixture.writeFile("a.txt", "payload\n");
  fixture.run("git add a.txt");
  commitTick(fixture, "add a", 1);
  const std::string base = rev(fixture.root(), "HEAD~1");
  const std::string tip = rev(fixture.root(), "HEAD");

  InteractiveSession session;
  const std::string repoId = discoverRepo(session, fixture.root());

  Json soft = session.request(
      req(10, "mutate/reset", {{"repoId", repoId}, {"ref", "HEAD~1"}, {"mode", "soft"}}));
  ASSERT_TRUE(soft.contains("result")) << soft.dump();
  EXPECT_EQ(rev(fixture.root(), "HEAD"), base);
  Json afterSoft = statusSummary(session, 11, repoId);
  EXPECT_TRUE(hasPath(afterSoft["staged"], "a.txt"));  // index kept

  Json mixed = session.request(
      req(12, "mutate/reset", {{"repoId", repoId}, {"ref", "HEAD"}, {"mode", "mixed"}}));
  ASSERT_TRUE(mixed.contains("result")) << mixed.dump();
  Json afterMixed = statusSummary(session, 13, repoId);
  EXPECT_TRUE(afterMixed["staged"].empty());
  EXPECT_EQ(afterMixed["untracked"], Json::array({"a.txt"}));  // workdir kept

  fixture.writeFile("README.md", "scribbled\n");
  Json hard = session.request(
      req(14, "mutate/reset", {{"repoId", repoId}, {"ref", "HEAD"}, {"mode", "hard"}}));
  ASSERT_TRUE(hard.contains("result")) << hard.dump();
  EXPECT_EQ(slurp(fixture.root() / "README.md"), "fixture\n");  // tracked edit discarded

  Json hardTip = session.request(
      req(15, "mutate/reset", {{"repoId", repoId}, {"ref", tip}, {"mode", "hard"}}));
  ASSERT_TRUE(hardTip.contains("result")) << hardTip.dump();
  EXPECT_EQ(rev(fixture.root(), "HEAD"), tip);
  EXPECT_EQ(slurp(fixture.root() / "a.txt"), "payload\n");

  Json badMode = session.request(
      req(16, "mutate/reset", {{"repoId", repoId}, {"ref", "HEAD"}, {"mode", "yolo"}}));
  EXPECT_EQ(badMode["error"]["code"], -32602);
}

TEST(MutateService, FetchPullPushAgainstBareRemote) {
  FixtureRepo fixture;
  commitTick(fixture, "c2", 1);
  fixture.run("git clone --bare -q . upstream.git");
  fixture.run("git remote add origin upstream.git");
  const std::filesystem::path upstream = fixture.root() / "upstream.git";

  InteractiveSession session;
  const std::string repoId = discoverRepo(session, fixture.root());

  fixture.writeFile("local.txt", "local\n");
  fixture.run("git add local.txt");
  commitTick(fixture, "local work", 2);

  Json push =
      session.request(req(10, "mutate/push", {{"repoId", repoId}, {"setUpstream", true}}));
  ASSERT_TRUE(push.contains("result")) << push.dump();
  EXPECT_EQ(rev(upstream, "main"), rev(fixture.root(), "HEAD"));
  Json afterPush = statusSummary(session, 11, repoId);
  EXPECT_EQ(afterPush["upstream"], "origin/main");
  EXPECT_EQ(afterPush["ahead"], 0);
  EXPECT_EQ(afterPush["behind"], 0);

  // Remote-side commit via a second clone.
  fixture.run("git clone -q upstream.git second");
  fixture.run("cd second && git -c user.name=Remote -c user.email=remote@example.invalid "
              "commit -q --allow-empty -m 'remote work' && git push -q origin main");

  Json fetch = session.request(req(12, "mutate/fetch", {{"repoId", repoId}}));
  ASSERT_TRUE(fetch.contains("result")) << fetch.dump();
  Json afterFetch = statusSummary(session, 13, repoId);
  EXPECT_EQ(afterFetch["ahead"], 0);
  EXPECT_EQ(afterFetch["behind"], 1);

  Json pull = session.request(req(14, "mutate/pull", {{"repoId", repoId}}));
  ASSERT_TRUE(pull.contains("result")) << pull.dump();
  EXPECT_EQ(rev(fixture.root(), "HEAD"), rev(upstream, "main"));
  Json afterPull = statusSummary(session, 15, repoId);
  EXPECT_EQ(afterPull["behind"], 0);

  // Rewrite local history: plain push is rejected, with-lease force succeeds.
  fixture.run("git reset -q --hard HEAD~1");
  fixture.writeFile("re.txt", "rewrite\n");
  fixture.run("git add re.txt");
  commitTick(fixture, "rewritten", 5);
  Json rejected = session.request(req(16, "mutate/push", {{"repoId", repoId}}));
  EXPECT_EQ(rejected["error"]["code"], -32001);
  Json forced = session.request(
      req(17, "mutate/push", {{"repoId", repoId}, {"force", "with-lease"}}));
  ASSERT_TRUE(forced.contains("result")) << forced.dump();
  EXPECT_EQ(rev(upstream, "main"), rev(fixture.root(), "HEAD"));

  Json badForce =
      session.request(req(18, "mutate/push", {{"repoId", repoId}, {"force", "yes"}}));
  EXPECT_EQ(badForce["error"]["code"], -32602);
}

TEST(MutateService, StashPushApplyPopDropAndConflict) {
  FixtureRepo fixture;
  fixture.writeFile("s.txt", "base\n");
  fixture.run("git add s.txt");
  commitTick(fixture, "seed", 1);

  InteractiveSession session;
  const std::string repoId = discoverRepo(session, fixture.root());

  fixture.writeFile("s.txt", "working\n");
  Json push = session.request(
      req(10, "stash/push", {{"repoId", repoId}, {"message", "wip work"}}));
  ASSERT_TRUE(push.contains("result")) << push.dump();
  EXPECT_EQ(slurp(fixture.root() / "s.txt"), "base\n");
  EXPECT_NE(gitOut(fixture.root(), "stash list").find("wip work"), std::string::npos);

  Json apply = session.request(
      req(11, "stash/apply", {{"repoId", repoId}, {"index", 0}, {"pop", false}}));
  ASSERT_TRUE(apply.contains("result")) << apply.dump();
  EXPECT_FALSE(apply["result"]["conflicts"].get<bool>());
  EXPECT_EQ(slurp(fixture.root() / "s.txt"), "working\n");
  EXPECT_NE(gitOut(fixture.root(), "stash list"), "");  // apply keeps the entry

  fixture.run("git checkout -q -- s.txt");
  Json pop = session.request(
      req(12, "stash/apply", {{"repoId", repoId}, {"index", 0}, {"pop", true}}));
  ASSERT_TRUE(pop.contains("result")) << pop.dump();
  EXPECT_FALSE(pop["result"]["conflicts"].get<bool>());
  EXPECT_EQ(slurp(fixture.root() / "s.txt"), "working\n");
  EXPECT_EQ(gitOut(fixture.root(), "stash list"), "");  // pop dropped the entry

  // Conflict on apply: stash again, then diverge the committed content.
  Json push2 = session.request(req(13, "stash/push", {{"repoId", repoId}}));
  ASSERT_TRUE(push2.contains("result")) << push2.dump();
  fixture.writeFile("s.txt", "diverged\n");
  fixture.run("git add s.txt");
  commitTick(fixture, "diverge", 2);
  Json conflictApply = session.request(
      req(14, "stash/apply", {{"repoId", repoId}, {"index", 0}, {"pop", true}}));
  ASSERT_TRUE(conflictApply.contains("result")) << conflictApply.dump();
  EXPECT_TRUE(conflictApply["result"]["conflicts"].get<bool>());
  Json summary = statusSummary(session, 15, repoId);
  EXPECT_EQ(summary["conflicted"], Json::array({"s.txt"}));
  EXPECT_NE(gitOut(fixture.root(), "stash list"), "");  // kept on conflicted pop

  fixture.run("git reset -q --hard");  // clear the conflict
  Json drop = session.request(req(16, "stash/drop", {{"repoId", repoId}, {"index", 0}}));
  ASSERT_TRUE(drop.contains("result")) << drop.dump();
  EXPECT_EQ(gitOut(fixture.root(), "stash list"), "");

  Json dropMissing = session.request(req(17, "stash/drop", {{"repoId", repoId}, {"index", 0}}));
  EXPECT_EQ(dropMissing["error"]["code"], -32001);
  Json badIndex = session.request(req(18, "stash/drop", {{"repoId", repoId}, {"index", -3}}));
  EXPECT_EQ(badIndex["error"]["code"], -32602);
}

TEST(MutateService, StashPushIncludeUntracked) {
  FixtureRepo fixture;
  InteractiveSession session;
  const std::string repoId = discoverRepo(session, fixture.root());

  fixture.writeFile("u.txt", "loose\n");
  Json withU = session.request(
      req(10, "stash/push", {{"repoId", repoId}, {"includeUntracked", true}}));
  ASSERT_TRUE(withU.contains("result")) << withU.dump();
  EXPECT_FALSE(std::filesystem::exists(fixture.root() / "u.txt"));
  EXPECT_NE(gitOut(fixture.root(), "stash list"), "");

  Json pop = session.request(
      req(11, "stash/apply", {{"repoId", repoId}, {"index", 0}, {"pop", true}}));
  ASSERT_TRUE(pop.contains("result")) << pop.dump();
  EXPECT_EQ(slurp(fixture.root() / "u.txt"), "loose\n");
}

TEST(MutateService, WorktreeAddListRemove) {
  FixtureRepo fixture;
  const std::string branchWt = fixture.root().string() + "-wt";
  const std::string detachedWt = fixture.root().string() + "-wt2";
  struct Cleanup {
    std::string a, b;
    ~Cleanup() {
      std::error_code ec;
      std::filesystem::remove_all(a, ec);
      std::filesystem::remove_all(b, ec);
    }
  } cleanup{branchWt, detachedWt};

  InteractiveSession session;
  const std::string repoId = discoverRepo(session, fixture.root());
  const std::string mainSha = rev(fixture.root(), "HEAD");

  Json add = session.request(req(10, "worktree/add",
                                 {{"repoId", repoId},
                                  {"path", branchWt},
                                  {"ref", "main"},
                                  {"createBranch", "wt-branch"}}));
  ASSERT_TRUE(add.contains("result")) << add.dump();
  Json addDetached = session.request(
      req(11, "worktree/add", {{"repoId", repoId}, {"path", detachedWt}, {"ref", mainSha}}));
  ASSERT_TRUE(addDetached.contains("result")) << addDetached.dump();

  Json list = session.request(req(12, "worktree/list", {{"repoId", repoId}}));
  ASSERT_TRUE(list.contains("result")) << list.dump();
  const Json& worktrees = list["result"]["worktrees"];
  ASSERT_EQ(worktrees.size(), 3u) << list.dump();

  const Json& mainWt = worktrees[0];
  EXPECT_EQ(std::filesystem::canonical(mainWt["path"].get<std::string>()),
            std::filesystem::canonical(fixture.root()));
  EXPECT_EQ(mainWt["branch"], "main");
  EXPECT_EQ(mainWt["sha"], mainSha);
  EXPECT_FALSE(mainWt["bare"].get<bool>());
  EXPECT_FALSE(mainWt["locked"].get<bool>());

  const Json& branchEntry = worktrees[1];
  EXPECT_EQ(std::filesystem::canonical(branchEntry["path"].get<std::string>()),
            std::filesystem::canonical(branchWt));
  EXPECT_EQ(branchEntry["branch"], "wt-branch");
  EXPECT_EQ(branchEntry["sha"], mainSha);

  const Json& detachedEntry = worktrees[2];
  EXPECT_FALSE(detachedEntry.contains("branch"));  // detached checkout
  EXPECT_EQ(detachedEntry["sha"], mainSha);

  Json remove =
      session.request(req(13, "worktree/remove", {{"repoId", repoId}, {"path", branchWt}}));
  ASSERT_TRUE(remove.contains("result")) << remove.dump();
  Json remove2 =
      session.request(req(14, "worktree/remove", {{"repoId", repoId}, {"path", detachedWt}}));
  ASSERT_TRUE(remove2.contains("result")) << remove2.dump();
  Json after = session.request(req(15, "worktree/list", {{"repoId", repoId}}));
  EXPECT_EQ(after["result"]["worktrees"].size(), 1u) << after.dump();
}

TEST(MutateService, CommitEmitsRepoDidChange) {
#ifdef GG_SINGLE_THREADED
  GTEST_SKIP() << "single-threaded build: the watcher is never started (capability watch:false)";
#else
  FixtureRepo fixture;
  InteractiveSession session;
  const std::string repoId = discoverRepo(session, fixture.root());

  fixture.writeFile("w.txt", "watched\n");
  fixture.run("git add w.txt");
  Json commit = session.request(
      req(10, "mutate/commit", {{"repoId", repoId}, {"message", "watched change"}}));
  ASSERT_TRUE(commit.contains("result")) << commit.dump();

  // A commit moves the branch ref HEAD resolves to; depending on debounce
  // batching the watcher reports it as 'HEAD' or 'refs' (the same acceptance
  // the watch-manager tests use).
  bool sawHeadChange = false;
  for (int i = 0; i < 5 && !sawHeadChange; ++i) {
    Json notification = session.readNotificationUntil("repo/didChange", 5000);
    if (!notification.contains("params")) break;
    EXPECT_EQ(notification["params"]["repoId"], repoId);
    for (const auto& category : notification["params"]["changed"]) {
      if (category == "HEAD" || category == "refs") sawHeadChange = true;
    }
  }
  EXPECT_TRUE(sawHeadChange) << "no HEAD/refs repo/didChange after mutate/commit";
#endif
}

}  // namespace
}  // namespace gg
