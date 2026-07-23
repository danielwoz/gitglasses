// End-to-end tests for remote/list, patch/create and patch/apply, driven
// through the full server loop.

#include <gtest/gtest.h>
#include <nlohmann/json.hpp>

#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <regex>
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
  return gg::testing::gitCapture(root, args);
}

std::string rev(const std::filesystem::path& root, const std::string& spec) {
  // `^` never reaches a shell: cmd.exe treats carets as escape characters,
  // so first-parent specs resolve via rev-list --parents instead.
  const size_t caret = spec.find('^');
  if (caret != std::string::npos) {
    const std::string base = spec.substr(0, caret);
    std::string line =
        gg::testing::gitCapture(root, "rev-list --parents -n 1 " + base, /*quiet=*/true);
    std::istringstream fields(line);
    std::string sha, parent;
    fields >> sha >> parent;
    return parent;
  }
  std::string sha = gg::testing::gitCapture(root, "rev-parse " + spec, /*quiet=*/true);
  while (!sha.empty() && sha.back() == '\n') sha.pop_back();
  return sha;
}

std::string slurp(const std::filesystem::path& file) {
  std::ifstream in(file, std::ios::binary);
  std::ostringstream buffer;
  buffer << in.rdbuf();
  return buffer.str();
}

using gg::testing::runGit;

void commitTick(const std::filesystem::path& dir, const std::string& message, int tick) {
  const std::string date = "@" + std::to_string(1700000000 + 60 * tick) + " +0000";
  gg::testing::ScopedEnv author("GIT_AUTHOR_DATE", date);
  gg::testing::ScopedEnv committer("GIT_COMMITTER_DATE", date);
  runGit(dir, "git commit -aq --allow-empty -m \"" + message + "\"");
}

std::string discoverRepo(InteractiveSession& session, std::int64_t id,
                         const std::filesystem::path& root) {
  Json discover = session.request(req(id, "repo/discover", {{"path", root.string()}}));
  EXPECT_TRUE(discover.contains("result")) << discover.dump();
  return discover["result"]["repoId"];
}

// Clone of the fixture repo, placed next to it and removed on destruction.
class CloneRepo {
 public:
  explicit CloneRepo(const FixtureRepo& fixture)
      : root_(fixture.root().string() + "-clone") {
    runGit(fixture.root(), "git clone -q . \"" + root_.string() + "\"");
    runGit(root_, "git config user.name Fixture");
    runGit(root_, "git config user.email fixture@example.invalid");
    runGit(root_, "git config commit.gpgsign false");
  }

  ~CloneRepo() {
    std::error_code ec;
    std::filesystem::remove_all(root_, ec);
  }

  const std::filesystem::path& root() const { return root_; }

 private:
  std::filesystem::path root_;
};

Json createPatch(InteractiveSession& session, std::int64_t id, const std::string& repoId,
                 Json source) {
  Json response = session.request(
      req(id, "patch/create", {{"repoId", repoId}, {"source", std::move(source)}}));
  EXPECT_TRUE(response.contains("result")) << response.dump();
  return response["result"]["envelope"];
}

Json applyPatch(InteractiveSession& session, std::int64_t id, const std::string& repoId,
                const Json& envelope) {
  Json response = session.request(
      req(id, "patch/apply", {{"repoId", repoId}, {"envelope", envelope}}));
  EXPECT_TRUE(response.contains("result")) << response.dump();
  return response["result"];
}

TEST(PatchService, RemoteListNoneThenOriginWithPushUrl) {
  FixtureRepo fixture;
  InteractiveSession session;
  session.request(initRequest(1));
  const std::string repoId = discoverRepo(session, 2, fixture.root());

  Json none = session.request(req(10, "remote/list", {{"repoId", repoId}}));
  ASSERT_TRUE(none.contains("result")) << none.dump();
  EXPECT_EQ(none["result"]["remotes"], Json::array());

  fixture.run("git remote add origin https://example.invalid/repo.git");
  fixture.run("git remote add mirror https://example.invalid/mirror.git");
  fixture.run("git remote set-url --push mirror ssh://push.example.invalid/mirror.git");

  Json listed = session.request(req(11, "remote/list", {{"repoId", repoId}}));
  ASSERT_TRUE(listed.contains("result")) << listed.dump();
  const Json& remotes = listed["result"]["remotes"];
  ASSERT_EQ(remotes.size(), 2u) << listed.dump();
  const auto findRemote = [&remotes](const std::string& name) {
    for (const auto& remote : remotes) {
      if (remote["name"] == name) return remote;
    }
    ADD_FAILURE() << "remote not listed: " << name;
    return Json{};
  };
  const Json mirror = findRemote("mirror");
  EXPECT_EQ(mirror["fetchUrl"], "https://example.invalid/mirror.git");
  EXPECT_EQ(mirror["pushUrl"], "ssh://push.example.invalid/mirror.git");
  const Json origin = findRemote("origin");
  EXPECT_EQ(origin["fetchUrl"], "https://example.invalid/repo.git");
  EXPECT_FALSE(origin.contains("pushUrl"));  // no separate push url configured
}

TEST(PatchService, WipEnvelopeRoundTrip) {
  FixtureRepo fixture;
  fixture.writeFile("f.txt", "l1\nl2\nl3\nl4\nl5\n");
  fixture.run("git add f.txt");
  commitTick(fixture.root(), "add f", 1);
  fixture.run("git remote add origin https://example.invalid/repo.git");
  CloneRepo clone(fixture);

  fixture.writeFile("f.txt", "l1\nl2\nl3 edited\nl4\nl5\n");
  fixture.writeFile("new.txt", "fresh\n");

  InteractiveSession session;
  session.request(initRequest(1));
  const std::string repoA = discoverRepo(session, 2, fixture.root());
  const std::string repoB = discoverRepo(session, 3, clone.root());

  Json envelope =
      createPatch(session, 10, repoA, {{"kind", "wip"}, {"includeUntracked", true}});
  EXPECT_EQ(envelope["format"], "gitglasses-patch");
  EXPECT_EQ(envelope["version"], 1);
  EXPECT_EQ(envelope["baseSha"], rev(fixture.root(), "HEAD"));
  EXPECT_EQ(envelope["branch"], "main");
  EXPECT_EQ(envelope["summary"], "WIP on main");
  // sha256("https://example.invalid/repo.git") truncated to 16 hex chars.
  EXPECT_EQ(envelope["remoteFingerprint"], "2bcb29a3edefb659");
  EXPECT_TRUE(std::regex_match(
      envelope["createdAtIso"].get<std::string>(),
      std::regex(R"(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)")));
  const std::string patchText = envelope["patch"];
  EXPECT_NE(patchText.find("l3 edited"), std::string::npos);
  EXPECT_NE(patchText.find("b/new.txt"), std::string::npos);

  Json applied = applyPatch(session, 11, repoB, envelope);
  EXPECT_TRUE(applied["applied"].get<bool>());
  EXPECT_FALSE(applied["conflicts"].get<bool>());
  EXPECT_TRUE(applied["baseFound"].get<bool>());
  EXPECT_EQ(slurp(clone.root() / "f.txt"), "l1\nl2\nl3 edited\nl4\nl5\n");
  EXPECT_EQ(slurp(clone.root() / "new.txt"), "fresh\n");
}

TEST(PatchService, WipCleanTreeIsGitError) {
  FixtureRepo fixture;
  InteractiveSession session;
  session.request(initRequest(1));
  const std::string repoId = discoverRepo(session, 2, fixture.root());

  Json response = session.request(
      req(10, "patch/create", {{"repoId", repoId}, {"source", {{"kind", "wip"}}}}));
  ASSERT_TRUE(response.contains("error")) << response.dump();
  EXPECT_EQ(response["error"]["code"], -32001);
  EXPECT_NE(response["error"]["message"].get<std::string>().find("nothing to include"),
            std::string::npos);
}

TEST(PatchService, ApplyThreeWayWithDivergedBase) {
  FixtureRepo fixture;
  fixture.writeFile("f.txt", "l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\n");
  fixture.run("git add f.txt");
  commitTick(fixture.root(), "base", 1);
  CloneRepo clone(fixture);

  // The clone advances with a commit touching a nearby (but different) line.
  std::ofstream(clone.root() / "f.txt", std::ios::binary)
      << "l1\nl2\nl3\nl4\nl5 clone\nl6\nl7\nl8\nl9\n";
  commitTick(clone.root(), "clone work", 2);

  fixture.writeFile("f.txt", "l1\nl2 patched\nl3\nl4\nl5\nl6\nl7\nl8\nl9\n");

  InteractiveSession session;
  session.request(initRequest(1));
  const std::string repoA = discoverRepo(session, 2, fixture.root());
  const std::string repoB = discoverRepo(session, 3, clone.root());

  Json envelope = createPatch(session, 10, repoA, {{"kind", "wip"}});
  Json applied = applyPatch(session, 11, repoB, envelope);
  EXPECT_TRUE(applied["applied"].get<bool>());
  EXPECT_FALSE(applied["conflicts"].get<bool>());
  EXPECT_TRUE(applied["baseFound"].get<bool>());
  EXPECT_EQ(slurp(clone.root() / "f.txt"), "l1\nl2 patched\nl3\nl4\nl5 clone\nl6\nl7\nl8\nl9\n");
}

TEST(PatchService, ApplyConflictReportsUnmerged) {
  FixtureRepo fixture;
  fixture.writeFile("f.txt", "l1\nl2\nl3\n");
  fixture.run("git add f.txt");
  commitTick(fixture.root(), "base", 1);
  CloneRepo clone(fixture);

  // The clone rewrites the same line the patch touches.
  std::ofstream(clone.root() / "f.txt", std::ios::binary) << "l1\nl2 clone\nl3\n";
  commitTick(clone.root(), "clone conflicting work", 2);

  fixture.writeFile("f.txt", "l1\nl2 patched\nl3\n");

  InteractiveSession session;
  session.request(initRequest(1));
  const std::string repoA = discoverRepo(session, 2, fixture.root());
  const std::string repoB = discoverRepo(session, 3, clone.root());

  Json envelope = createPatch(session, 10, repoA, {{"kind", "wip"}});
  Json applied = applyPatch(session, 11, repoB, envelope);
  EXPECT_TRUE(applied["applied"].get<bool>());
  EXPECT_TRUE(applied["conflicts"].get<bool>());
  EXPECT_TRUE(applied["baseFound"].get<bool>());
  EXPECT_NE(gitOut(clone.root(), "ls-files -u"), "");  // unmerged index entries
  const std::string contents = slurp(clone.root() / "f.txt");
  EXPECT_NE(contents.find("<<<<<<<"), std::string::npos);
  EXPECT_NE(contents.find("l2 patched"), std::string::npos);
  EXPECT_NE(contents.find("l2 clone"), std::string::npos);
}

TEST(PatchService, ApplyMissingBaseFails) {
  FixtureRepo source;
  source.writeFile("f.txt", "l1\nl2\nl3\n");
  source.run("git add f.txt");
  commitTick(source.root(), "base", 1);
  source.writeFile("f.txt", "l1\nl2 patched\nl3\n");

  FixtureRepo unrelated;  // shares no history (and no f.txt) with `source`

  InteractiveSession session;
  session.request(initRequest(1));
  const std::string repoA = discoverRepo(session, 2, source.root());
  const std::string repoC = discoverRepo(session, 3, unrelated.root());

  Json envelope = createPatch(session, 10, repoA, {{"kind", "wip"}});
  Json applied = applyPatch(session, 11, repoC, envelope);
  EXPECT_FALSE(applied["applied"].get<bool>());
  EXPECT_FALSE(applied["conflicts"].get<bool>());
  EXPECT_FALSE(applied["baseFound"].get<bool>());
  EXPECT_FALSE(std::filesystem::exists(unrelated.root() / "f.txt"));
}

TEST(PatchService, StashSourceEnvelope) {
  FixtureRepo fixture;
  fixture.writeFile("s.txt", "base\n");
  fixture.run("git add s.txt");
  commitTick(fixture.root(), "seed", 1);
  fixture.writeFile("s.txt", "working\n");
  fixture.writeFile("loose.txt", "loose\n");
  fixture.run("git stash push -q -u -m \"stash work\"");
  // Bare spec: rev() resolves the ^1 via rev-list, and stash@{0} needs no
  // quoting in either sh or cmd.
  const std::string stashBase = rev(fixture.root(), "stash@{0}^1");

  InteractiveSession session;
  session.request(initRequest(1));
  const std::string repoId = discoverRepo(session, 2, fixture.root());

  Json envelope = createPatch(session, 10, repoId, {{"kind", "stash"}, {"index", 0}});
  EXPECT_EQ(envelope["baseSha"], stashBase);
  EXPECT_EQ(envelope["baseSha"], rev(fixture.root(), "HEAD"));
  EXPECT_EQ(envelope["summary"], "On main: stash work");
  const std::string patchText = envelope["patch"];
  EXPECT_NE(patchText.find("+working"), std::string::npos);
  EXPECT_NE(patchText.find("b/loose.txt"), std::string::npos);

  // The worktree is clean after the stash push, so the envelope re-applies
  // in place.
  Json applied = applyPatch(session, 11, repoId, envelope);
  EXPECT_TRUE(applied["applied"].get<bool>());
  EXPECT_FALSE(applied["conflicts"].get<bool>());
  EXPECT_TRUE(applied["baseFound"].get<bool>());
  EXPECT_EQ(slurp(fixture.root() / "s.txt"), "working\n");
  EXPECT_EQ(slurp(fixture.root() / "loose.txt"), "loose\n");

  Json missing = session.request(
      req(12, "patch/create",
          {{"repoId", repoId}, {"source", {{"kind", "stash"}, {"index", 5}}}}));
  EXPECT_EQ(missing["error"]["code"], -32001);
}

TEST(PatchService, CommitSourceEnvelope) {
  FixtureRepo fixture;
  fixture.writeFile("c.txt", "one\n");
  fixture.run("git add c.txt");
  commitTick(fixture.root(), "add c", 1);
  CloneRepo clone(fixture);

  fixture.writeFile("c.txt", "one\ntwo\n");
  commitTick(fixture.root(), "extend c", 2);
  const std::string sha = rev(fixture.root(), "HEAD");

  InteractiveSession session;
  session.request(initRequest(1));
  const std::string repoA = discoverRepo(session, 2, fixture.root());
  const std::string repoB = discoverRepo(session, 3, clone.root());

  Json envelope = createPatch(session, 10, repoA, {{"kind", "commit"}, {"sha", sha}});
  EXPECT_EQ(envelope["baseSha"], rev(fixture.root(), "HEAD^"));
  EXPECT_EQ(envelope["summary"], "extend c");
  // Plain unified diff, not a format-patch mail (which git apply can't take).
  const std::string patchText = envelope["patch"];
  EXPECT_EQ(patchText.rfind("diff --git", 0), 0u) << patchText.substr(0, 80);

  Json applied = applyPatch(session, 11, repoB, envelope);
  EXPECT_TRUE(applied["applied"].get<bool>());
  EXPECT_FALSE(applied["conflicts"].get<bool>());
  EXPECT_TRUE(applied["baseFound"].get<bool>());
  EXPECT_EQ(slurp(clone.root() / "c.txt"), "one\ntwo\n");
}

TEST(PatchService, RangeSourceEnvelope) {
  FixtureRepo fixture;
  CloneRepo clone(fixture);
  fixture.writeFile("r1.txt", "first\n");
  fixture.run("git add r1.txt");
  commitTick(fixture.root(), "range one", 1);
  fixture.writeFile("r2.txt", "second\n");
  fixture.run("git add r2.txt");
  commitTick(fixture.root(), "range two", 2);

  InteractiveSession session;
  session.request(initRequest(1));
  const std::string repoA = discoverRepo(session, 2, fixture.root());
  const std::string repoB = discoverRepo(session, 3, clone.root());

  Json envelope = createPatch(session, 10, repoA,
                              {{"kind", "range"}, {"base", "HEAD~2"}, {"head", "HEAD"}});
  EXPECT_EQ(envelope["baseSha"], rev(fixture.root(), "HEAD~2"));
  EXPECT_EQ(envelope["summary"], "range two");
  const std::string patchText = envelope["patch"];
  EXPECT_NE(patchText.find("b/r1.txt"), std::string::npos);
  EXPECT_NE(patchText.find("b/r2.txt"), std::string::npos);

  Json applied = applyPatch(session, 11, repoB, envelope);
  EXPECT_TRUE(applied["applied"].get<bool>());
  EXPECT_FALSE(applied["conflicts"].get<bool>());
  EXPECT_TRUE(applied["baseFound"].get<bool>());
  EXPECT_EQ(slurp(clone.root() / "r1.txt"), "first\n");
  EXPECT_EQ(slurp(clone.root() / "r2.txt"), "second\n");
}

TEST(PatchService, InvalidParamsRejected) {
  FixtureRepo fixture;
  InteractiveSession session;
  session.request(initRequest(1));
  const std::string repoId = discoverRepo(session, 2, fixture.root());

  Json noSource = session.request(req(10, "patch/create", {{"repoId", repoId}}));
  EXPECT_EQ(noSource["error"]["code"], -32602);
  Json badKind = session.request(
      req(11, "patch/create", {{"repoId", repoId}, {"source", {{"kind", "zip"}}}}));
  EXPECT_EQ(badKind["error"]["code"], -32602);
  Json badIndex = session.request(
      req(12, "patch/create",
          {{"repoId", repoId}, {"source", {{"kind", "stash"}, {"index", -1}}}}));
  EXPECT_EQ(badIndex["error"]["code"], -32602);

  Json noEnvelope = session.request(req(13, "patch/apply", {{"repoId", repoId}}));
  EXPECT_EQ(noEnvelope["error"]["code"], -32602);
  Json badFormat = session.request(
      req(14, "patch/apply",
          {{"repoId", repoId},
           {"envelope",
            {{"format", "zipfile"}, {"version", 1}, {"baseSha", ""}, {"patch", "x"}}}}));
  EXPECT_EQ(badFormat["error"]["code"], -32602);
  Json emptyPatch = session.request(
      req(15, "patch/apply",
          {{"repoId", repoId},
           {"envelope",
            {{"format", "gitglasses-patch"}, {"version", 1}, {"baseSha", ""}, {"patch", ""}}}}));
  EXPECT_EQ(emptyPatch["error"]["code"], -32602);
}

}  // namespace
}  // namespace gg
