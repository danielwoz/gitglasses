// End-to-end tests for branch/*, tag/* and remote/* management, driven
// through the full server loop against real repositories and bare remotes.

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

std::string gitOut(const std::filesystem::path& root, const std::string& args) {
  return gg::testing::gitCapture(root, args);
}

std::string rev(const std::filesystem::path& root, const std::string& spec) {
  std::string sha = gg::testing::gitCapture(root, "rev-parse " + spec, /*quiet=*/true);
  while (!sha.empty() && sha.back() == '\n') sha.pop_back();
  return sha;
}

std::string discoverRepo(InteractiveSession& session, const std::filesystem::path& root) {
  session.request(initRequest(1));
  Json discover = session.request(req(2, "repo/discover", {{"path", root.string()}}));
  return discover["result"]["repoId"];
}

// A bare repository inside the fixture, added as remote `name`.
std::filesystem::path addBareRemote(FixtureRepo& fixture, const std::string& name) {
  fixture.run("git init -q --bare " + name + ".git");
  fixture.run("git remote add " + name + " " + name + ".git");
  return fixture.root() / (name + ".git");
}

std::string upstreamOf(const std::filesystem::path& root, const std::string& branch) {
  std::string name =
      gitOut(root, "for-each-ref \"--format=%(upstream:short)\" refs/heads/" + branch);
  while (!name.empty() && name.back() == '\n') name.pop_back();
  return name;
}

TEST(RefMethods, BranchRenameAndUpstream) {
  FixtureRepo fixture;
  fixture.run("git branch feature");
  addBareRemote(fixture, "origin");
  fixture.run("git push -q origin main");
  fixture.run("git fetch -q origin");
  InteractiveSession session;
  const std::string repoId = discoverRepo(session, fixture.root());

  Json rename = session.request(
      req(10, "branch/rename", {{"repoId", repoId}, {"name", "feature"}, {"newName", "renamed"}}));
  ASSERT_TRUE(rename.contains("result")) << rename.dump();
  EXPECT_EQ(gitOut(fixture.root(), "branch --list feature renamed \"--format=%(refname:short)\""),
            "renamed\n");

  Json set =
      session.request(req(11, "branch/setUpstream",
                          {{"repoId", repoId}, {"name", "renamed"}, {"upstream", "origin/main"}}));
  ASSERT_TRUE(set.contains("result")) << set.dump();
  EXPECT_EQ(upstreamOf(fixture.root(), "renamed"), "origin/main");

  Json unset =
      session.request(req(12, "branch/setUpstream", {{"repoId", repoId}, {"name", "renamed"}}));
  ASSERT_TRUE(unset.contains("result")) << unset.dump();
  EXPECT_EQ(upstreamOf(fixture.root(), "renamed"), "");

  // git's refusal comes back whole.
  Json missing =
      session.request(req(13, "branch/setUpstream",
                          {{"repoId", repoId}, {"name", "renamed"}, {"upstream", "origin/none"}}));
  ASSERT_TRUE(missing.contains("error")) << missing.dump();
  EXPECT_NE(missing["error"]["message"].get<std::string>().find("does not exist"),
            std::string::npos);
}

// Publishing goes to the remote git would pick, not a hard-coded "origin",
// and works for a branch that is not checked out.
TEST(RefMethods, BranchPushPicksTheRemoteGitWould) {
  FixtureRepo fixture;
  fixture.run("git branch feature");
  const std::filesystem::path fork = addBareRemote(fixture, "fork");
  InteractiveSession session;
  const std::string repoId = discoverRepo(session, fixture.root());

  Json only = session.request(
      req(10, "branch/push", {{"repoId", repoId}, {"name", "feature"}, {"setUpstream", true}}));
  ASSERT_TRUE(only.contains("result")) << only.dump();
  EXPECT_EQ(only["result"]["remote"], "fork");
  EXPECT_EQ(rev(fork, "feature"), rev(fixture.root(), "feature"));
  EXPECT_EQ(upstreamOf(fixture.root(), "feature"), "fork/feature");

  const std::filesystem::path second = addBareRemote(fixture, "second");
  fixture.run("git branch other");
  Json ambiguous = session.request(req(11, "branch/push", {{"repoId", repoId}, {"name", "other"}}));
  ASSERT_TRUE(ambiguous.contains("error")) << ambiguous.dump();
  EXPECT_NE(ambiguous["error"]["message"].get<std::string>().find("choose one"), std::string::npos);

  fixture.run("git config remote.pushDefault second");
  Json byDefault = session.request(req(12, "branch/push", {{"repoId", repoId}, {"name", "other"}}));
  ASSERT_TRUE(byDefault.contains("result")) << byDefault.dump();
  EXPECT_EQ(byDefault["result"]["remote"], "second");
  EXPECT_EQ(rev(second, "other"), rev(fixture.root(), "other"));

  Json explicitRemote = session.request(
      req(13, "branch/push", {{"repoId", repoId}, {"name", "other"}, {"remote", "fork"}}));
  ASSERT_TRUE(explicitRemote.contains("result")) << explicitRemote.dump();
  EXPECT_EQ(rev(fork, "other"), rev(fixture.root(), "other"));
}

TEST(RefMethods, BranchPushUpdatesTheTrackedBranch) {
  FixtureRepo fixture;
  const std::filesystem::path origin = addBareRemote(fixture, "origin");
  fixture.run("git push -q origin main:remote-name");
  fixture.run("git fetch -q origin");
  fixture.run("git branch --track local-name origin/remote-name");
  fixture.run("git checkout -q local-name");
  fixture.commit("local work");
  InteractiveSession session;
  const std::string repoId = discoverRepo(session, fixture.root());

  Json push = session.request(req(10, "branch/push", {{"repoId", repoId}, {"name", "local-name"}}));
  ASSERT_TRUE(push.contains("result")) << push.dump();
  EXPECT_EQ(rev(origin, "remote-name"), rev(fixture.root(), "local-name"));
  EXPECT_EQ(gitOut(origin, "branch --list local-name"), "");
}

TEST(RefMethods, TagCreatePushAndDelete) {
  FixtureRepo fixture;
  const std::string first = rev(fixture.root(), "HEAD");
  fixture.commit("second");
  const std::filesystem::path origin = addBareRemote(fixture, "origin");
  InteractiveSession session;
  const std::string repoId = discoverRepo(session, fixture.root());

  Json light = session.request(req(10, "tag/create", {{"repoId", repoId}, {"name", "v1"}}));
  ASSERT_TRUE(light.contains("result")) << light.dump();
  EXPECT_EQ(gitOut(fixture.root(), "cat-file -t v1"), "commit\n");

  Json annotated = session.request(
      req(11, "tag/create",
          {{"repoId", repoId}, {"name", "v0"}, {"ref", first}, {"message", "-first release"}}));
  ASSERT_TRUE(annotated.contains("result")) << annotated.dump();
  EXPECT_EQ(gitOut(fixture.root(), "cat-file -t v0"), "tag\n");
  EXPECT_EQ(rev(fixture.root(), "v0^{commit}"), first);
  EXPECT_EQ(gitOut(fixture.root(), "tag -l \"--format=%(contents)\" v0"), "-first release\n\n");

  Json push = session.request(
      req(12, "tag/push", {{"repoId", repoId}, {"name", "v0"}, {"remote", "origin"}}));
  ASSERT_TRUE(push.contains("result")) << push.dump();
  EXPECT_EQ(rev(origin, "v0"), rev(fixture.root(), "v0"));

  Json remoteDelete = session.request(
      req(13, "tag/push",
          {{"repoId", repoId}, {"name", "v0"}, {"remote", "origin"}, {"delete", true}}));
  ASSERT_TRUE(remoteDelete.contains("result")) << remoteDelete.dump();
  EXPECT_EQ(gitOut(origin, "tag -l"), "");
  EXPECT_EQ(rev(fixture.root(), "v0^{commit}"), first);  // local tag untouched

  Json localDelete = session.request(req(14, "tag/delete", {{"repoId", repoId}, {"name", "v0"}}));
  ASSERT_TRUE(localDelete.contains("result")) << localDelete.dump();
  EXPECT_EQ(gitOut(fixture.root(), "tag -l"), "v1\n");
}

TEST(RefMethods, RemoteAddAndRemove) {
  FixtureRepo fixture;
  fixture.run("git init -q --bare elsewhere.git");
  InteractiveSession session;
  const std::string repoId = discoverRepo(session, fixture.root());

  Json add = session.request(
      req(10, "remote/add", {{"repoId", repoId}, {"name", "upstream"}, {"url", "elsewhere.git"}}));
  ASSERT_TRUE(add.contains("result")) << add.dump();
  Json listed = session.request(req(11, "remote/list", {{"repoId", repoId}}));
  ASSERT_EQ(listed["result"]["remotes"].size(), 1u) << listed.dump();
  EXPECT_EQ(listed["result"]["remotes"][0]["name"], "upstream");

  Json duplicate = session.request(
      req(12, "remote/add", {{"repoId", repoId}, {"name", "upstream"}, {"url", "elsewhere.git"}}));
  EXPECT_EQ(duplicate["error"]["code"], -32001) << duplicate.dump();

  Json remove =
      session.request(req(13, "remote/remove", {{"repoId", repoId}, {"name", "upstream"}}));
  ASSERT_TRUE(remove.contains("result")) << remove.dump();
  EXPECT_EQ(gitOut(fixture.root(), "remote"), "");
}

TEST(RefMethods, OptionLikeValuesNeverReachGit) {
  FixtureRepo fixture;
  InteractiveSession session;
  const std::string repoId = discoverRepo(session, fixture.root());

  std::int64_t id = 10;
  const auto rejected = [&](const std::string& method, Json params) {
    params["repoId"] = repoId;
    Json response = session.request(req(++id, method, std::move(params)));
    EXPECT_EQ(response["error"]["code"], -32602) << method << ": " << response.dump();
  };
  rejected("branch/rename", {{"name", "main"}, {"newName", "--force"}});
  rejected("branch/setUpstream", {{"name", "main"}, {"upstream", "-x"}});
  rejected("branch/push", {{"name", "main"}, {"remote", "--exec=evil"}});
  rejected("branch/push", {{"name", "main"}, {"force", "yes"}});
  rejected("tag/create", {{"name", "-d"}});
  rejected("tag/delete", {{"name", "-l"}});
  rejected("tag/push", {{"name", "v1"}, {"remote", "--mirror"}});
  rejected("remote/add", {{"name", "x"}, {"url", "--upload-pack=evil"}});
  rejected("remote/remove", {{"name", "-v"}});
}

}  // namespace
}  // namespace gg
