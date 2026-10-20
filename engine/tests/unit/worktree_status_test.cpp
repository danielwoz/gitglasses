// worktree/list and worktree/status against real linked worktrees, plus the
// pure pieces they rest on: git version parsing, agent recognition and
// merge-tree output parsing.

#include <gtest/gtest.h>
#include <nlohmann/json.hpp>

#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <set>
#include <string>
#include <vector>

#include "exec/cli_detect.h"
#include "services/worktree/worktree_status.h"
#include "test_fixtures.h"
#include "test_session.h"

namespace gg {
namespace {

namespace fs = std::filesystem;
using Json = nlohmann::json;
using gg::testing::FixtureRepo;
using gg::testing::InteractiveSession;
using gg::testing::ScopedEnv;
using services::worktree::agentFromLocation;
using services::worktree::agentFromTrailer;
using services::worktree::mergeTreeConflicts;

Json req(std::int64_t id, const std::string& method, Json params) {
  return {{"jsonrpc", "2.0"}, {"id", id}, {"method", method}, {"params", std::move(params)}};
}

std::string rev(const fs::path& root, const std::string& spec) {
  std::string sha = gg::testing::gitCapture(root, "rev-parse " + spec, /*quiet=*/true);
  while (!sha.empty() && sha.back() == '\n') sha.pop_back();
  return sha;
}

void writeFile(const fs::path& file, const std::string& contents) {
  fs::create_directories(file.parent_path());
  std::ofstream out(file, std::ios::binary);
  out << contents;
}

// Commits in `dir` with pinned dates, so ordering does not depend on timing.
void commitIn(const fs::path& dir, const std::string& message, int tick) {
  const std::string date = "@" + std::to_string(1700000000 + 60 * tick) + " +0000";
  ScopedEnv author("GIT_AUTHOR_DATE", date);
  ScopedEnv committer("GIT_COMMITTER_DATE", date);
  gg::testing::runGit(dir, "git commit -q -m \"" + message + "\"");
}

// Loose and packed object files under the repository's object database.
std::size_t objectFiles(const fs::path& gitdir) {
  std::size_t count = 0;
  for (const auto& entry : fs::recursive_directory_iterator(gitdir / "objects")) {
    if (entry.is_regular_file()) ++count;
  }
  return count;
}

// A fixture repository with linked worktrees next to it, removed afterwards.
class WorktreeRepo {
 public:
  WorktreeRepo() { session_.request(gg::testing::initRequest(1)); }
  ~WorktreeRepo() {
    std::error_code ec;
    for (const auto& dir : extra_) fs::remove_all(dir, ec);
  }

  FixtureRepo& fixture() { return fixture_; }
  InteractiveSession& session() { return session_; }

  std::string repoId() {
    if (repoId_.empty()) {
      Json discover =
          session_.request(req(2, "repo/discover", {{"path", fixture_.root().string()}}));
      repoId_ = discover["result"]["repoId"].get<std::string>();
    }
    return repoId_;
  }

  // Adds a worktree at a sibling directory (or below the repository when
  // `inside`), on a new branch `branch` starting at `start`.
  fs::path add(const std::string& name, const std::string& branch,
               const std::string& start = "main") {
    const fs::path dir = fs::path(fixture_.root().string() + "-" + name);
    extra_.push_back(dir);
    fixture_.run("git worktree add -q -b " + branch + " \"" + dir.string() + "\" " + start);
    return dir;
  }

  fs::path addAt(const fs::path& dir, const std::string& branch) {
    extra_.push_back(dir);
    fixture_.run("git worktree add -q -b " + branch + " \"" + dir.string() + "\" main");
    return dir;
  }

  Json status(const fs::path& dir, const std::string& base = "") {
    Json params = {{"repoId", repoId()}, {"path", dir.string()}};
    if (!base.empty()) params["base"] = base;
    Json response = session_.request(req(++id_, "worktree/status", params));
    EXPECT_TRUE(response.contains("result")) << response.dump();
    return response.value("result", Json::object());
  }

  Json list() {
    Json response = session_.request(req(++id_, "worktree/list", {{"repoId", repoId()}}));
    EXPECT_TRUE(response.contains("result")) << response.dump();
    return response["result"].value("worktrees", Json::array());
  }

  Json raw(const std::string& method, Json params) {
    params["repoId"] = repoId();
    return session_.request(req(++id_, method, std::move(params)));
  }

 private:
  FixtureRepo fixture_;
  InteractiveSession session_;
  std::string repoId_;
  std::vector<fs::path> extra_;
  std::int64_t id_ = 100;
};

const Json* entryFor(const Json& worktrees, const fs::path& dir) {
  for (const auto& entry : worktrees) {
    std::error_code ec;
    if (fs::equivalent(entry["path"].get<std::string>(), dir, ec)) return &entry;
  }
  return nullptr;
}

// --- Pure pieces ------------------------------------------------------------

TEST(GitVersion, ParsesWhatGitPrints) {
  const auto plain = exec::parseGitVersion("git version 2.43.0");
  ASSERT_TRUE(plain);
  EXPECT_EQ(plain->major, 2);
  EXPECT_EQ(plain->minor, 43);
  EXPECT_EQ(plain->patch, 0);

  const auto apple = exec::parseGitVersion("git version 2.39.3 (Apple Git-145)");
  ASSERT_TRUE(apple);
  EXPECT_EQ(apple->minor, 39);
  EXPECT_EQ(apple->patch, 3);

  const auto windows = exec::parseGitVersion("git version 2.41.0.windows.1");
  ASSERT_TRUE(windows);
  EXPECT_EQ(windows->minor, 41);

  const auto source = exec::parseGitVersion("git version 2.45.GIT");
  ASSERT_TRUE(source);
  EXPECT_EQ(source->minor, 45);
  EXPECT_EQ(source->patch, 0);

  EXPECT_FALSE(exec::parseGitVersion(""));
  EXPECT_FALSE(exec::parseGitVersion("git version"));
  EXPECT_FALSE(exec::parseGitVersion("git version two"));
  EXPECT_FALSE(exec::parseGitVersion("hub version 2.14.2"));
}

TEST(GitVersion, ComparesReleases) {
  const exec::GitVersion v{2, 38, 1};
  EXPECT_TRUE(v.atLeast(2, 38));
  EXPECT_TRUE(v.atLeast(2, 38, 1));
  EXPECT_FALSE(v.atLeast(2, 38, 2));
  EXPECT_FALSE(v.atLeast(2, 39));
  EXPECT_TRUE(v.atLeast(1, 99));
  EXPECT_FALSE((exec::GitVersion{2, 37, 9}).atLeast(2, 38));
  EXPECT_TRUE((exec::GitVersion{3, 0, 0}).atLeast(2, 45));
}

TEST(GitVersion, ProbeReadsTheGitOnPath) {
  const auto version = exec::probeGitVersion();
  ASSERT_TRUE(version) << "git --version did not parse";
  EXPECT_GE(version->major, 2);
}

TEST(WorktreeAgents, RecognisesAgentWorktreeLocations) {
  const auto claude = agentFromLocation("/src/app/.claude/worktrees/auth", "worktree-auth");
  ASSERT_TRUE(claude);
  EXPECT_EQ(claude->name, "Claude Code");
  EXPECT_EQ(claude->evidence, "path");

  const auto cursor = agentFromLocation("C:\\Users\\me\\.cursor\\worktrees\\app\\66rZn", "");
  ASSERT_TRUE(cursor);
  EXPECT_EQ(cursor->name, "Cursor");

  const auto codex = agentFromLocation("/home/me/.codex/worktrees/1a2b/app", "");
  ASSERT_TRUE(codex);
  EXPECT_EQ(codex->name, "Codex");

  const auto copilot =
      agentFromLocation("/src/app.worktrees/copilot-worktree-2026-02-18T02-49-49", "x");
  ASSERT_TRUE(copilot);
  EXPECT_EQ(copilot->name, "Copilot");

  const auto vscode = agentFromLocation("/src/app.worktrees/agents-fix-login/", "x");
  ASSERT_TRUE(vscode);
  EXPECT_EQ(vscode->name, "VS Code agent");
}

TEST(WorktreeAgents, RecognisesAgentBranchNames) {
  const auto claude = agentFromLocation("/elsewhere/auth", "worktree-auth");
  ASSERT_TRUE(claude);
  EXPECT_EQ(claude->name, "Claude Code");
  EXPECT_EQ(claude->evidence, "branch");

  EXPECT_EQ(agentFromLocation("/x/y", "cursor/fix-table-66rZn")->name, "Cursor");
  EXPECT_EQ(agentFromLocation("/x/y", "codex/refactor")->name, "Codex");
  EXPECT_EQ(agentFromLocation("/x/y", "copilot/fix-123")->name, "Copilot");
  EXPECT_EQ(agentFromLocation("/x/y", "claude/add-tests-x1")->name, "Claude Code");
  EXPECT_EQ(agentFromLocation("/x/y", "copilot-worktree-2026-01-01T00-00-00")->name, "Copilot");
}

TEST(WorktreeAgents, LeavesOrdinaryWorktreesUnclaimed) {
  EXPECT_FALSE(agentFromLocation("/src/app-feature", "feature"));
  // worktree-<name> claims a Claude Code worktree only with the matching folder.
  EXPECT_FALSE(agentFromLocation("/src/app-review", "worktree-other"));
  EXPECT_FALSE(agentFromLocation("/src/app.worktrees/feature", "feature"));
  EXPECT_FALSE(agentFromLocation("/src/worktrees/x", "claude/"));
  EXPECT_FALSE(agentFromLocation("", ""));
}

TEST(WorktreeAgents, ReadsAgentTrailers) {
  EXPECT_EQ(agentFromTrailer("Co-Authored-By", "Claude Opus 4.5 <noreply@anthropic.com>"),
            "Claude Code");
  EXPECT_EQ(agentFromTrailer("Co-authored-by", "Cursor Agent <cursoragent@cursor.com>"), "Cursor");
  EXPECT_EQ(
      agentFromTrailer("co-authored-by", "Copilot <198982749+Copilot@users.noreply.github.com>"),
      "Copilot");
  EXPECT_EQ(agentFromTrailer("Co-authored-by", "aider (gpt-5) <noreply@aider.chat>"), "Aider");
  EXPECT_EQ(agentFromTrailer("Assisted-by", "Claude Code:claude-opus-4 coccinelle"), "Claude Code");
  EXPECT_EQ(agentFromTrailer("Generated-by", "Kiro"), "Kiro");
  // People who share a name with an agent are told apart by their address.
  EXPECT_FALSE(agentFromTrailer("Co-authored-by", "Claude Monet <claude@example.com>"));
  EXPECT_FALSE(agentFromTrailer("Co-authored-by", "no address"));
  EXPECT_FALSE(agentFromTrailer("Signed-off-by", "Claude <noreply@anthropic.com>"));
  // Free-form names stay short and plain.
  EXPECT_FALSE(agentFromTrailer("Generated-by", "](javascript:alert(1))"));
  EXPECT_FALSE(agentFromTrailer("Generated-by", std::string(64, 'a')));
}

TEST(WorktreeMergeTree, ParsesConflictedPaths) {
  using namespace std::string_literals;
  EXPECT_TRUE(mergeTreeConflicts("0123456789012345678901234567890123456789\0"s, 50).empty());
  const auto paths = mergeTreeConflicts(
      "0123456789012345678901234567890123456789\0f.txt\0sp ace\"q.txt\0\xc3\xa9.txt\0f.txt\0"s, 50);
  EXPECT_EQ(paths, (std::vector<std::string>{"f.txt", "sp ace\"q.txt", "\xc3\xa9.txt"}));
  EXPECT_EQ(mergeTreeConflicts("tree\0a\0b\0c\0"s, 2), (std::vector<std::string>{"a", "b"}));
}

// --- worktree/status against real worktrees ---------------------------------

TEST(WorktreeStatus, CountsUncommittedPathsAndComparesWithTheMainBranch) {
  WorktreeRepo repo;
  FixtureRepo& fixture = repo.fixture();
  const std::string start = rev(fixture.root(), "HEAD");
  const fs::path agent = repo.add("agent", "feature");

  writeFile(agent / "one.txt", "one\n");
  gg::testing::runGit(agent, "git add one.txt");
  commitIn(agent, "add one", 1);
  writeFile(agent / "two.txt", "two\n");
  gg::testing::runGit(agent, "git add two.txt");
  commitIn(agent, "add two", 2);
  // One modified, one staged new and one untracked path; README.md is both
  // staged and modified again, and still counts once.
  writeFile(agent / "one.txt", "one changed\n");
  writeFile(agent / "staged.txt", "staged\n");
  gg::testing::runGit(agent, "git add staged.txt");
  writeFile(agent / "notes/untracked.txt", "untracked\n");
  writeFile(agent / "README.md", "fixture staged\n");
  gg::testing::runGit(agent, "git add README.md");
  writeFile(agent / "README.md", "fixture staged and edited\n");

  fixture.writeFile("main-only.txt", "main\n");
  fixture.run("git add main-only.txt");
  fixture.commit("main moves on");

  const std::size_t objectsBefore = objectFiles(fixture.root() / ".git");
  Json status = repo.status(agent);
  EXPECT_EQ(status["path"], agent.string());
  EXPECT_EQ(status["dirty"], 4) << status.dump();
  EXPECT_GT(status.value("lastActivity", 0), 1600000000) << status.dump();
  EXPECT_FALSE(status.contains("upstream"));

  ASSERT_TRUE(status.contains("base")) << status.dump();
  const Json& base = status["base"];
  EXPECT_EQ(base["ref"], "main");
  EXPECT_EQ(base["sha"], rev(fixture.root(), "main"));
  EXPECT_EQ(base["ahead"], 2);
  EXPECT_EQ(base["behind"], 1);
  EXPECT_EQ(base["mergeBase"], start);
  EXPECT_EQ(base["mergesCleanly"], true) << status.dump();
  EXPECT_FALSE(base.contains("mergeSkipped"));
  EXPECT_FALSE(base.contains("conflicts"));
  // The merge check writes its trees to a quarantine, not the repository.
  EXPECT_EQ(objectFiles(fixture.root() / ".git"), objectsBefore);
  EXPECT_FALSE(status.contains("agent")) << status.dump();

  // The main worktree compared with its own branch has nothing to merge.
  Json mainStatus = repo.status(fixture.root());
  EXPECT_EQ(mainStatus["dirty"], 0);
  EXPECT_EQ(mainStatus["base"]["ahead"], 0);
  EXPECT_EQ(mainStatus["base"]["behind"], 0);
  EXPECT_EQ(mainStatus["base"]["mergesCleanly"], true);
}

TEST(WorktreeStatus, ReportsConflictsWithTheBase) {
  WorktreeRepo repo;
  FixtureRepo& fixture = repo.fixture();
  fixture.writeFile("shared.txt", "a\nb\nc\n");
  fixture.writeFile("other.txt", "x\n");
  fixture.run("git add shared.txt other.txt");
  fixture.commit("add shared");
  const fs::path agent = repo.add("agent", "feature");

  writeFile(agent / "shared.txt", "a\nfeature\nc\n");
  writeFile(agent / "other.txt", "feature\n");
  gg::testing::runGit(agent, "git add shared.txt other.txt");
  commitIn(agent, "feature edits", 1);
  fixture.writeFile("shared.txt", "a\nmain\nc\n");
  fixture.writeFile("other.txt", "main\n");
  fixture.run("git add shared.txt other.txt");
  fixture.commit("main edits");

  Json status = repo.status(agent);
  const Json& base = status["base"];
  EXPECT_EQ(base["ahead"], 1);
  EXPECT_EQ(base["behind"], 1);
  EXPECT_EQ(base["mergesCleanly"], false) << status.dump();
  EXPECT_EQ(base["conflicts"], Json::array({"other.txt", "shared.txt"})) << status.dump();
  EXPECT_EQ(status["dirty"], 0);
  // Neither branch moved: merge-tree only looked.
  EXPECT_NE(rev(fixture.root(), "main"), rev(fixture.root(), "feature"));
}

TEST(WorktreeStatus, ComparesWithAnExplicitBaseAndTheUpstream) {
  WorktreeRepo repo;
  FixtureRepo& fixture = repo.fixture();
  fixture.run("git tag v1");
  const fs::path agent = repo.add("agent", "feature");
  writeFile(agent / "a.txt", "a\n");
  gg::testing::runGit(agent, "git add a.txt");
  commitIn(agent, "a", 1);
  const std::string pushed = rev(agent, "HEAD");
  writeFile(agent / "b.txt", "b\n");
  gg::testing::runGit(agent, "git add b.txt");
  commitIn(agent, "b", 2);

  // A remote-tracking branch one commit behind the local branch.
  fixture.run("git remote add origin https://example.invalid/app.git");
  fixture.run("git update-ref refs/remotes/origin/feature " + pushed);
  fixture.run("git branch --set-upstream-to=origin/feature feature");

  Json status = repo.status(agent, "v1");
  ASSERT_TRUE(status.contains("upstream")) << status.dump();
  EXPECT_EQ(status["upstream"]["ref"], "origin/feature");
  EXPECT_EQ(status["upstream"]["ahead"], 1);
  EXPECT_EQ(status["upstream"]["behind"], 0);
  EXPECT_EQ(status["base"]["ref"], "v1");
  EXPECT_EQ(status["base"]["ahead"], 2);
  EXPECT_EQ(status["base"]["behind"], 0);
  // A fast-forward merges cleanly without asking git.
  EXPECT_EQ(status["base"]["mergesCleanly"], true);

  Json bad = repo.raw("worktree/status", {{"path", agent.string()}, {"base", "no-such-ref"}});
  ASSERT_TRUE(bad.contains("error")) << bad.dump();
  EXPECT_EQ(bad["error"]["code"], -32602);
  Json option = repo.raw("worktree/status", {{"path", agent.string()}, {"base", "--output=x"}});
  EXPECT_EQ(option["error"]["code"], -32602);
}

TEST(WorktreeStatus, DetachedWorktreesCompareTheirCommit) {
  WorktreeRepo repo;
  FixtureRepo& fixture = repo.fixture();
  const fs::path dir = fs::path(fixture.root().string() + "-detached");
  struct Cleanup {
    fs::path dir;
    ~Cleanup() {
      std::error_code ec;
      fs::remove_all(dir, ec);
    }
  } cleanup{dir};
  fixture.run("git worktree add -q --detach \"" + dir.string() + "\" main");
  writeFile(dir / "d.txt", "d\n");
  gg::testing::runGit(dir, "git add d.txt");
  commitIn(dir, "detached work", 1);

  Json status = repo.status(dir);
  EXPECT_FALSE(status.contains("upstream"));
  EXPECT_EQ(status["base"]["ref"], "main");
  EXPECT_EQ(status["base"]["ahead"], 1);
  EXPECT_EQ(status["base"]["mergesCleanly"], true);
}

TEST(WorktreeStatus, RecognisesAgentsByPathAndTrailer) {
  WorktreeRepo repo;
  FixtureRepo& fixture = repo.fixture();
  // `claude --worktree auth` lays its worktree out like this.
  const fs::path claude =
      repo.addAt(fixture.root() / ".claude" / "worktrees" / "auth", "worktree-auth");
  Json byPath = repo.status(claude);
  ASSERT_TRUE(byPath.contains("agent")) << byPath.dump();
  EXPECT_EQ(byPath["agent"]["name"], "Claude Code");
  EXPECT_EQ(byPath["agent"]["evidence"], "path");

  const fs::path cursor = repo.add("plain", "plain-branch");
  writeFile(cursor / "c.txt", "c\n");
  gg::testing::runGit(cursor, "git add c.txt");
  const fs::path message = fs::path(fixture.root().string() + "-message.txt");
  writeFile(message, "agent work\n\nCo-authored-by: Cursor Agent <cursoragent@cursor.com>\n");
  {
    ScopedEnv author("GIT_AUTHOR_DATE", "@1700000060 +0000");
    ScopedEnv committer("GIT_COMMITTER_DATE", "@1700000060 +0000");
    gg::testing::runGit(cursor, "git commit -q -F \"" + message.string() + "\"");
  }
  fs::remove(message);
  // A human commit on top: the newest commit with an agent trailer counts.
  writeFile(cursor / "d.txt", "d\n");
  gg::testing::runGit(cursor, "git add d.txt");
  commitIn(cursor, "human follow-up", 2);

  Json byTrailer = repo.status(cursor);
  ASSERT_TRUE(byTrailer.contains("agent")) << byTrailer.dump();
  EXPECT_EQ(byTrailer["agent"]["name"], "Cursor");
  EXPECT_EQ(byTrailer["agent"]["evidence"], "trailer");
}

TEST(WorktreeStatus, RefusesPathsOutsideTheRepository) {
  WorktreeRepo repo;
  FixtureRepo other;
  Json foreign = repo.raw("worktree/status", {{"path", other.root().string()}});
  ASSERT_TRUE(foreign.contains("error")) << foreign.dump();
  EXPECT_EQ(foreign["error"]["code"], -32602);

  Json missing =
      repo.raw("worktree/status", {{"path", (repo.fixture().root() / "no-such-dir").string()}});
  ASSERT_TRUE(missing.contains("error")) << missing.dump();
  EXPECT_EQ(missing["error"]["code"], -32000);
}

TEST(WorktreeList, MarksTheCurrentAndPrunableWorktrees) {
  WorktreeRepo repo;
  const fs::path kept = repo.add("kept", "kept");
  const fs::path gone = repo.add("gone", "gone");
  fs::remove_all(gone);

  const Json worktrees = repo.list();
  ASSERT_EQ(worktrees.size(), 3u) << worktrees.dump();
  const Json* main = entryFor(worktrees, repo.fixture().root());
  ASSERT_NE(main, nullptr);
  EXPECT_TRUE((*main)["current"].get<bool>());
  EXPECT_FALSE((*main)["prunable"].get<bool>());
  const Json* keptEntry = entryFor(worktrees, kept);
  ASSERT_NE(keptEntry, nullptr);
  EXPECT_FALSE((*keptEntry)["current"].get<bool>());
  EXPECT_FALSE((*keptEntry)["prunable"].get<bool>());
  bool sawGone = false;
  for (const auto& entry : worktrees) {
    if (entry.value("branch", "") != "gone") continue;
    sawGone = true;
    EXPECT_TRUE(entry["prunable"].get<bool>()) << entry.dump();
  }
  EXPECT_TRUE(sawGone) << worktrees.dump();

  // From the linked worktree's side, it is the current one.
  Json discover = repo.session().request(req(50, "repo/discover", {{"path", kept.string()}}));
  const std::string keptId = discover["result"]["repoId"];
  Json fromKept = repo.session().request(req(51, "worktree/list", {{"repoId", keptId}}));
  const Json* keptSelf = entryFor(fromKept["result"]["worktrees"], kept);
  ASSERT_NE(keptSelf, nullptr) << fromKept.dump();
  EXPECT_TRUE((*keptSelf)["current"].get<bool>());
}

#ifndef _WIN32
TEST(WorktreeList, RestrictedModeListsThroughLibgit2AndSkipsTheMergeCheck) {
  FixtureRepo fixture;
  fixture.writeFile("shared.txt", "a\n");
  fixture.run("git add shared.txt");
  fixture.commit("shared");
  const fs::path agent = fs::path(fixture.root().string() + "-agent");
  const fs::path gone = fs::path(fixture.root().string() + "-gone");
  struct Cleanup {
    fs::path a, b;
    ~Cleanup() {
      std::error_code ec;
      fs::remove_all(a, ec);
      fs::remove_all(b, ec);
    }
  } cleanup{agent, gone};
  fixture.run("git worktree add -q -b feature \"" + agent.string() + "\" main");
  fixture.run("git worktree add -q -b gone \"" + gone.string() + "\" main");
  fs::remove_all(gone);
  writeFile(agent / "shared.txt", "feature\n");
  gg::testing::runGit(agent, "git commit -q -am feature");
  fixture.writeFile("shared.txt", "main\n");
  fixture.run("git commit -q -am main");
  writeFile(agent / "dirty.txt", "dirty\n");

  // git's own listing, for comparison.
  std::set<std::string> expected;
  {
    InteractiveSession session;
    session.request(gg::testing::initRequest(1));
    Json discover = session.request(req(2, "repo/discover", {{"path", fixture.root().string()}}));
    Json list =
        session.request(req(3, "worktree/list", {{"repoId", discover["result"]["repoId"]}}));
    for (const auto& entry : list["result"]["worktrees"]) expected.insert(entry.dump());
  }

  gg::testing::ScopedRestrictedMode restricted;
  InteractiveSession session;
  session.request(gg::testing::initRequest(1));
  Json discover = session.request(req(2, "repo/discover", {{"path", fixture.root().string()}}));
  const std::string repoId = discover["result"]["repoId"];
  Json list = session.request(req(3, "worktree/list", {{"repoId", repoId}}));
  ASSERT_TRUE(list.contains("result")) << list.dump();
  std::set<std::string> listed;
  for (const auto& entry : list["result"]["worktrees"]) listed.insert(entry.dump());
  EXPECT_EQ(listed, expected);
  EXPECT_EQ(list["result"]["worktrees"][0]["current"], true);

  Json status =
      session.request(req(4, "worktree/status", {{"repoId", repoId}, {"path", agent.string()}}));
  ASSERT_TRUE(status.contains("result")) << status.dump();
  EXPECT_EQ(status["result"]["dirty"], 1);
  EXPECT_EQ(status["result"]["base"]["ahead"], 1);
  EXPECT_EQ(status["result"]["base"]["behind"], 1);
  EXPECT_TRUE(status["result"]["base"]["mergesCleanly"].is_null()) << status.dump();
  EXPECT_EQ(status["result"]["base"]["mergeSkipped"], "restricted");
}

// A git older than 2.38 has no `merge-tree --write-tree`: the check is
// skipped with the reason instead of failing the status.
TEST(WorktreeStatus, SkipsTheMergeCheckWithAnOldGit) {
  std::string realGit;
  const char* pathVar = std::getenv("PATH");
  std::string path = pathVar ? pathVar : "";
  for (size_t start = 0; start <= path.size();) {
    const size_t colon = path.find(':', start);
    const std::string dir =
        path.substr(start, colon == std::string::npos ? std::string::npos : colon - start);
    std::error_code ec;
    if (!dir.empty() && fs::exists(fs::path(dir) / "git", ec)) {
      realGit = (fs::path(dir) / "git").string();
      break;
    }
    if (colon == std::string::npos) break;
    start = colon + 1;
  }
  ASSERT_FALSE(realGit.empty()) << "no git on PATH";

  const fs::path fakeDir = gg::testing::makeTempDir("gg-old-git-");
  struct Cleanup {
    fs::path dir;
    ~Cleanup() {
      std::error_code ec;
      fs::remove_all(dir, ec);
    }
  } cleanupFake{fakeDir};
  // The engine runs `git -C <dir> --version`; everything else goes to git.
  writeFile(fakeDir / "git",
            "#!/bin/sh\n"
            "for arg in \"$@\"; do\n"
            "  if [ \"$arg\" = \"--version\" ]; then echo \"git version 2.37.9\"; exit 0; fi\n"
            "done\n"
            "exec \"" +
                realGit + "\" \"$@\"\n");
  fs::permissions(fakeDir / "git", fs::perms::owner_all | fs::perms::group_read |
                                       fs::perms::group_exec | fs::perms::others_read |
                                       fs::perms::others_exec);

  FixtureRepo fixture;
  fixture.writeFile("shared.txt", "a\n");
  fixture.run("git add shared.txt");
  fixture.commit("shared");
  const fs::path agent = fs::path(fixture.root().string() + "-agent");
  struct CleanupAgent {
    fs::path dir;
    ~CleanupAgent() {
      std::error_code ec;
      fs::remove_all(dir, ec);
    }
  } cleanupAgent{agent};
  fixture.run("git worktree add -q -b feature \"" + agent.string() + "\" main");
  writeFile(agent / "shared.txt", "feature\n");
  gg::testing::runGit(agent, "git commit -q -am feature");
  fixture.writeFile("other.txt", "main\n");
  fixture.run("git add other.txt");
  fixture.commit("main");

  ScopedEnv oldGitFirst("PATH", fakeDir.string() + ":" + path);
  InteractiveSession session;
  session.request(gg::testing::initRequest(1));
  Json discover = session.request(req(2, "repo/discover", {{"path", fixture.root().string()}}));
  Json status = session.request(req(
      3, "worktree/status", {{"repoId", discover["result"]["repoId"]}, {"path", agent.string()}}));
  ASSERT_TRUE(status.contains("result")) << status.dump();
  EXPECT_TRUE(status["result"]["base"]["mergesCleanly"].is_null()) << status.dump();
  EXPECT_EQ(status["result"]["base"]["mergeSkipped"], "gitVersion");
  EXPECT_EQ(status["result"]["base"]["ahead"], 1);
}
#endif  // !_WIN32

}  // namespace
}  // namespace gg
