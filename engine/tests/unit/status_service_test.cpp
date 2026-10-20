// End-to-end tests for status/summary, diff/commit, diff/refs,
// diff/fileHunks, stage/files and stage/hunks, driven through the full server
// loop. Git's own porcelain output is the parity oracle for staging results.

#include <gtest/gtest.h>
#include <nlohmann/json.hpp>

#include <algorithm>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <optional>
#include <string>
#include <thread>
#include <utility>
#include <vector>

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

std::string rev(const FixtureRepo& fixture, const std::string& spec) {
  std::string sha = gitOut(fixture.root(), "rev-parse " + spec);
  while (!sha.empty() && sha.back() == '\n') sha.pop_back();
  return sha;
}

void commitTick(FixtureRepo& fixture, const std::string& message, int tick) {
  const std::string date = "@" + std::to_string(1700000000 + 60 * tick) + " +0000";
  fixture.commitAt(date, message);
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

// Finds the FileChange for `path`, failing the test when absent.
Json changeFor(const Json& changes, const std::string& path) {
  for (const auto& change : changes) {
    if (change["path"] == path) return change;
  }
  ADD_FAILURE() << "no change for " << path << " in " << changes.dump();
  return {};
}

bool hasPath(const Json& changes, const std::string& path) {
  for (const auto& change : changes) {
    if (change["path"] == path) return true;
  }
  return false;
}

TEST(StatusService, SummarySplitsStagedUnstagedUntracked) {
  FixtureRepo fixture;
  fixture.writeFile("a.txt", "one\n");
  fixture.writeFile("b.txt", "one\n");
  fixture.writeFile("d.txt", "one\n");
  fixture.writeFile("e.txt", "stable content that survives the rename\n");
  fixture.run("git add a.txt b.txt d.txt e.txt");
  commitTick(fixture, "seed", 1);

  fixture.writeFile("a.txt", "one\ntwo\n");
  fixture.run("git add a.txt");                  // staged M
  fixture.writeFile("b.txt", "one\nchanged\n");  // unstaged M
  fixture.writeFile("c.txt", "new\n");
  fixture.run("git add c.txt");        // staged A
  fixture.run("git rm -q d.txt");      // staged D
  fixture.run("git mv e.txt e2.txt");  // staged R
  fixture.writeFile("untracked.txt", "loose\n");

  InteractiveSession session;
  const std::string repoId = discoverRepo(session, fixture.root());
  Json summary = statusSummary(session, 10, repoId);

  EXPECT_EQ(summary["branch"], "main");
  EXPECT_FALSE(summary.contains("upstream"));
  EXPECT_EQ(summary["ahead"], 0);
  EXPECT_EQ(summary["behind"], 0);

  ASSERT_EQ(summary["staged"].size(), 4u) << summary["staged"].dump();
  EXPECT_EQ(changeFor(summary["staged"], "a.txt")["status"], "M");
  EXPECT_EQ(changeFor(summary["staged"], "c.txt")["status"], "A");
  EXPECT_EQ(changeFor(summary["staged"], "d.txt")["status"], "D");
  const Json renamed = changeFor(summary["staged"], "e2.txt");
  EXPECT_EQ(renamed["status"], "R");
  EXPECT_EQ(renamed["origPath"], "e.txt");
  // Line stats are intentionally 0 in status (the UI uses diff/* for counts).
  EXPECT_EQ(changeFor(summary["staged"], "a.txt")["additions"], 0);

  ASSERT_EQ(summary["unstaged"].size(), 1u) << summary["unstaged"].dump();
  EXPECT_EQ(changeFor(summary["unstaged"], "b.txt")["status"], "M");
  EXPECT_EQ(summary["untracked"], Json::array({"untracked.txt"}));
  EXPECT_TRUE(summary["conflicted"].empty());
}

TEST(StatusService, SummaryReportsConflicts) {
  FixtureRepo fixture;
  fixture.writeFile("c.txt", "base\n");
  fixture.run("git add c.txt");
  commitTick(fixture, "base", 1);
  fixture.run("git checkout -q -b left");
  fixture.writeFile("c.txt", "left\n");
  fixture.run("git add c.txt");
  commitTick(fixture, "left", 2);
  fixture.run("git checkout -q main");
  fixture.writeFile("c.txt", "right\n");
  fixture.run("git add c.txt");
  commitTick(fixture, "right", 3);
  fixture.tryRun("git merge left");  // conflicts, exit != 0

  InteractiveSession session;
  const std::string repoId = discoverRepo(session, fixture.root());
  Json summary = statusSummary(session, 10, repoId);

  EXPECT_EQ(summary["branch"], "main");
  EXPECT_EQ(summary["conflicted"], Json::array({"c.txt"}));
  EXPECT_FALSE(hasPath(summary["staged"], "c.txt"));
  EXPECT_FALSE(hasPath(summary["unstaged"], "c.txt"));
}

TEST(StatusService, SummaryAheadBehindAgainstClonedUpstream) {
  FixtureRepo fixture;
  commitTick(fixture, "c1", 1);
  commitTick(fixture, "c2", 2);
  fixture.run("git clone --bare -q . upstream.git");
  fixture.run("git remote add origin upstream.git");
  fixture.run("git fetch -q origin");
  fixture.run("git branch -q --set-upstream-to=origin/main main");
  fixture.run("git reset -q --hard HEAD~1");  // behind 1
  commitTick(fixture, "c3", 3);               // ahead 1

  InteractiveSession session;
  const std::string repoId = discoverRepo(session, fixture.root());
  Json summary = statusSummary(session, 10, repoId);

  EXPECT_EQ(summary["branch"], "main");
  EXPECT_EQ(summary["upstream"], "origin/main");
  EXPECT_EQ(summary["ahead"], 1);
  EXPECT_EQ(summary["behind"], 1);
}

TEST(StatusService, SummaryUnbornHead) {
  struct UnbornRepo {
    std::filesystem::path root;
    UnbornRepo() {
      root = gg::testing::makeTempDir("gg-status-unborn-");
      gg::testing::runGit(root, "git init -q -b main");
      std::ofstream(root / "loose.txt", std::ios::binary) << "hi\n";
    }
    ~UnbornRepo() {
      std::error_code ec;
      std::filesystem::remove_all(root, ec);
    }
  } unborn;

  InteractiveSession session;
  const std::string repoId = discoverRepo(session, unborn.root);
  Json summary = statusSummary(session, 10, repoId);

  EXPECT_EQ(summary["branch"], "");
  EXPECT_FALSE(summary.contains("upstream"));
  EXPECT_EQ(summary["ahead"], 0);
  EXPECT_EQ(summary["behind"], 0);
  EXPECT_TRUE(summary["staged"].empty());
  EXPECT_TRUE(summary["unstaged"].empty());
  EXPECT_EQ(summary["untracked"], Json::array({"loose.txt"}));
}

TEST(StatusService, DiffCommitRootModifyAndRename) {
  FixtureRepo fixture;
  const std::string rootSha = rev(fixture, "HEAD");
  fixture.writeFile("README.md", "fixture\nmore\n");
  fixture.run("git add README.md");
  commitTick(fixture, "extend readme", 1);
  const std::string modifySha = rev(fixture, "HEAD");
  fixture.run("git mv README.md RENAMED.md");
  commitTick(fixture, "rename readme", 2);
  const std::string renameSha = rev(fixture, "HEAD");

  InteractiveSession session;
  const std::string repoId = discoverRepo(session, fixture.root());

  // Root commit diffs against the empty tree.
  Json root = session.request(req(10, "diff/commit", {{"repoId", repoId}, {"sha", rootSha}}));
  ASSERT_EQ(root["result"]["files"].size(), 1u) << root.dump();
  EXPECT_EQ(root["result"]["files"][0],
            Json({{"path", "README.md"},
                  {"status", "A"},
                  {"additions", 1},
                  {"deletions", 0}}));

  Json modify =
      session.request(req(11, "diff/commit", {{"repoId", repoId}, {"sha", modifySha}}));
  EXPECT_EQ(modify["result"]["files"][0],
            Json({{"path", "README.md"},
                  {"status", "M"},
                  {"additions", 1},
                  {"deletions", 0}}));

  Json rename =
      session.request(req(12, "diff/commit", {{"repoId", repoId}, {"sha", renameSha}}));
  ASSERT_EQ(rename["result"]["files"].size(), 1u) << rename.dump();
  EXPECT_EQ(rename["result"]["files"][0],
            Json({{"path", "RENAMED.md"},
                  {"status", "R"},
                  {"origPath", "README.md"},
                  {"additions", 0},
                  {"deletions", 0}}));

  Json bad = session.request(req(13, "diff/commit", {{"repoId", repoId}, {"sha", "deadbeef"}}));
  EXPECT_EQ(bad["error"]["code"], -32001);
}

TEST(StatusService, DiffRefsBetweenBranches) {
  FixtureRepo fixture;
  commitTick(fixture, "base", 1);
  fixture.run("git checkout -q -b feature");
  fixture.writeFile("feature.txt", "one\ntwo\nthree\n");
  fixture.writeFile("README.md", "fixture\nfeature edit\n");
  fixture.run("git add feature.txt README.md");
  commitTick(fixture, "feature work", 2);
  fixture.run("git checkout -q main");

  InteractiveSession session;
  const std::string repoId = discoverRepo(session, fixture.root());

  Json diff = session.request(
      req(10, "diff/refs", {{"repoId", repoId}, {"base", "main"}, {"head", "feature"}}));
  const Json& files = diff["result"]["files"];
  ASSERT_EQ(files.size(), 2u) << diff.dump();
  EXPECT_EQ(changeFor(files, "README.md")["status"], "M");
  EXPECT_EQ(changeFor(files, "README.md")["additions"], 1);
  EXPECT_EQ(changeFor(files, "README.md")["deletions"], 0);
  EXPECT_EQ(changeFor(files, "feature.txt")["status"], "A");
  EXPECT_EQ(changeFor(files, "feature.txt")["additions"], 3);

  // Reversed direction flips add to delete.
  Json reversed = session.request(
      req(11, "diff/refs", {{"repoId", repoId}, {"base", "feature"}, {"head", "main"}}));
  EXPECT_EQ(changeFor(reversed["result"]["files"], "feature.txt")["status"], "D");
}

TEST(StatusService, DiffFileHunksUnstagedAndStaged) {
  FixtureRepo fixture;
  std::string contents;
  for (int i = 1; i <= 10; ++i) contents += "l" + std::to_string(i) + "\n";
  fixture.writeFile("h.txt", contents);
  fixture.run("git add h.txt");
  commitTick(fixture, "seed", 1);
  std::string edited = contents;
  edited.replace(edited.find("l5\n"), 3, "L5-changed\n");
  fixture.writeFile("h.txt", edited);

  InteractiveSession session;
  const std::string repoId = discoverRepo(session, fixture.root());

  Json unstaged = session.request(
      req(10, "diff/fileHunks", {{"repoId", repoId}, {"path", "h.txt"}, {"staged", false}}));
  const Json& hunks = unstaged["result"]["hunks"];
  ASSERT_EQ(hunks.size(), 1u) << unstaged.dump();
  // The header keeps git's function-context suffix (here the nearest
  // preceding line matching the default function pattern).
  EXPECT_EQ(hunks[0]["header"], "@@ -2,7 +2,7 @@ l1");
  EXPECT_EQ(hunks[0]["oldStart"], 2);
  EXPECT_EQ(hunks[0]["oldLines"], 7);
  EXPECT_EQ(hunks[0]["newStart"], 2);
  EXPECT_EQ(hunks[0]["newLines"], 7);
  EXPECT_EQ(hunks[0]["lines"],
            Json::array({" l2", " l3", " l4", "-l5", "+L5-changed", " l6", " l7", " l8"}));

  // Nothing staged yet.
  Json stagedEmpty = session.request(
      req(11, "diff/fileHunks", {{"repoId", repoId}, {"path", "h.txt"}, {"staged", true}}));
  EXPECT_TRUE(stagedEmpty["result"]["hunks"].empty());

  fixture.run("git add h.txt");
  Json staged = session.request(
      req(12, "diff/fileHunks", {{"repoId", repoId}, {"path", "h.txt"}, {"staged", true}}));
  ASSERT_EQ(staged["result"]["hunks"].size(), 1u);
  EXPECT_EQ(staged["result"]["hunks"][0]["lines"], hunks[0]["lines"]);
  Json unstagedEmpty = session.request(
      req(13, "diff/fileHunks", {{"repoId", repoId}, {"path", "h.txt"}, {"staged", false}}));
  EXPECT_TRUE(unstagedEmpty["result"]["hunks"].empty());
}

TEST(StatusService, DiffHandlesBinaryFiles) {
  FixtureRepo fixture;
  const std::string binary1("\x00\x01\x02\x03\xff\xfe\x00payload", 14);
  fixture.writeFile("blob.bin", binary1);
  fixture.run("git add blob.bin");
  commitTick(fixture, "add binary", 1);

  InteractiveSession session;
  const std::string repoId = discoverRepo(session, fixture.root());

  Json commit =
      session.request(req(10, "diff/commit", {{"repoId", repoId}, {"sha", rev(fixture, "HEAD")}}));
  ASSERT_EQ(commit["result"]["files"].size(), 1u);
  EXPECT_EQ(commit["result"]["files"][0]["path"], "blob.bin");
  EXPECT_EQ(commit["result"]["files"][0]["status"], "A");
  EXPECT_EQ(commit["result"]["files"][0]["additions"], 0);
  EXPECT_EQ(commit["result"]["files"][0]["deletions"], 0);

  const std::string binary2("\x00\x01\x99\x03\xff\xfe\x00payload", 14);
  fixture.writeFile("blob.bin", binary2);
  Json hunks = session.request(
      req(11, "diff/fileHunks", {{"repoId", repoId}, {"path", "blob.bin"}, {"staged", false}}));
  EXPECT_TRUE(hunks["result"]["hunks"].empty());
}

// One file of git's own `--name-status -z` and `--numstat -z` output.
struct GitChange {
  std::string status;  // first letter only
  std::string path;
  std::string origPath;
  std::string additions;  // "-" for binary files
  std::string deletions;

  bool operator==(const GitChange&) const = default;
};

std::vector<std::string> splitNul(const std::string& text) {
  std::vector<std::string> fields;
  size_t pos = 0;
  while (pos < text.size()) {
    size_t end = text.find('\0', pos);
    if (end == std::string::npos) end = text.size();
    fields.push_back(text.substr(pos, end - pos));
    pos = end + 1;
  }
  return fields;
}

// git's answer for `args` (a `show <sha>` or `diff <base> <head>` command
// without output options): status, paths and line counts of every file.
std::vector<GitChange> gitChanges(const std::filesystem::path& root, const std::string& args) {
  std::vector<GitChange> changes;
  const auto statuses = splitNul(gitOut(root, args + " --format= --name-status -z"));
  for (size_t i = 0; i < statuses.size();) {
    GitChange change;
    change.status = statuses[i].substr(0, 1);
    if (change.status == "R" || change.status == "C") {
      change.origPath = statuses[i + 1];
      change.path = statuses[i + 2];
      i += 3;
    } else {
      change.path = statuses[i + 1];
      i += 2;
    }
    changes.push_back(std::move(change));
  }
  // --numstat -z: "<add>\t<del>\t<path>\0", or for a rename
  // "<add>\t<del>\t\0<old>\0<new>\0".
  const auto stats = splitNul(gitOut(root, args + " --format= --numstat -z"));
  for (size_t i = 0; i < stats.size();) {
    const std::string& head = stats[i];
    const size_t tab1 = head.find('\t');
    const size_t tab2 = head.find('\t', tab1 + 1);
    const std::string added = head.substr(0, tab1);
    const std::string deleted = head.substr(tab1 + 1, tab2 - tab1 - 1);
    std::string path = head.substr(tab2 + 1);
    i += 1;
    if (path.empty()) {
      path = stats[i + 1];
      i += 2;
    }
    for (auto& change : changes) {
      if (change.path == path && change.additions.empty()) {
        change.additions = added;
        change.deletions = deleted;
        break;
      }
    }
  }
  std::sort(changes.begin(), changes.end(),
            [](const GitChange& a, const GitChange& b) { return a.path < b.path; });
  return changes;
}

// The engine's FileChange list in the same shape.
std::vector<GitChange> engineChanges(const Json& files) {
  std::vector<GitChange> changes;
  for (const auto& file : files) {
    GitChange change;
    change.status = file["status"];
    change.path = file["path"];
    change.origPath = file.value("origPath", "");
    change.additions = std::to_string(file["additions"].get<int>());
    change.deletions = std::to_string(file["deletions"].get<int>());
    changes.push_back(std::move(change));
  }
  std::sort(changes.begin(), changes.end(),
            [](const GitChange& a, const GitChange& b) { return a.path < b.path; });
  return changes;
}

std::string numberedLines(const std::string& prefix, int count) {
  std::string text;
  for (int i = 0; i < count; ++i) text += prefix + " line " + std::to_string(i) + "\n";
  return text;
}

TEST(StatusService, DiffCommitPairsEveryRenameOfAMassMove) {
  FixtureRepo fixture;
  // More files than the default rename limit (1000), all moved at once, one
  // of them also edited.
  constexpr int kFiles = 1100;
  for (int i = 0; i < kFiles; ++i) {
    fixture.writeFile("src/f" + std::to_string(i) + ".txt",
                      numberedLines("file " + std::to_string(i), 10));
  }
  fixture.run("git add src");
  commitTick(fixture, "add many files", 1);
  fixture.run("git mv src lib");
  std::string edited = numberedLines("file 0", 10);
  edited.replace(edited.find("file 0 line 4"), 13, "file 0 line four");
  fixture.writeFile("lib/f0.txt", edited);
  fixture.run("git add lib/f0.txt");
  commitTick(fixture, "move everything", 2);

  InteractiveSession session;
  const std::string repoId = discoverRepo(session, fixture.root());
  Json moved =
      session.request(req(10, "diff/commit", {{"repoId", repoId}, {"sha", rev(fixture, "HEAD")}}));
  ASSERT_TRUE(moved.contains("result")) << moved.dump().substr(0, 500);
  const auto engine = engineChanges(moved["result"]["files"]);
  ASSERT_EQ(engine.size(), static_cast<size_t>(kFiles));
  for (const auto& change : engine) EXPECT_EQ(change.status, "R") << change.path;
  EXPECT_EQ(engine, gitChanges(fixture.root(), "show " + rev(fixture, "HEAD")));
  const Json f0 = changeFor(moved["result"]["files"], "lib/f0.txt");
  EXPECT_EQ(f0["origPath"], "src/f0.txt");
  EXPECT_EQ(f0["additions"], 1);
  EXPECT_EQ(f0["deletions"], 1);
}

TEST(StatusService, DiffRenameDetectionFollowsTheRepositoryConfig) {
  FixtureRepo fixture;
  fixture.writeFile("a.txt", numberedLines("alpha", 10));
  fixture.writeFile("b.txt", numberedLines("beta", 10));
  fixture.writeFile("c.txt", numberedLines("gamma", 10));
  fixture.run("git add a.txt b.txt c.txt");
  commitTick(fixture, "three files", 1);
  fixture.run("git mv a.txt a2.txt");
  fixture.run("git mv b.txt b2.txt");
  std::string edited = numberedLines("beta", 10);
  edited += "beta appended\n";
  fixture.writeFile("b2.txt", edited);
  fixture.run("git rm -q c.txt");
  fixture.run("git add b2.txt");
  commitTick(fixture, "rename and edit", 2);
  const std::string sha = rev(fixture, "HEAD");

  InteractiveSession session;
  const std::string repoId = discoverRepo(session, fixture.root());
  std::int64_t id = 10;
  const auto diffCommit = [&] {
    Json response = session.request(req(++id, "diff/commit", {{"repoId", repoId}, {"sha", sha}}));
    EXPECT_TRUE(response.contains("result")) << response.dump();
    return engineChanges(response["result"]["files"]);
  };

  // Default: the exact and the edited rename are both found.
  auto changes = diffCommit();
  EXPECT_EQ(changes, gitChanges(fixture.root(), "show " + sha));
  ASSERT_EQ(changes.size(), 3u);
  EXPECT_EQ(changes[0].status, "R");  // a2.txt
  EXPECT_EQ(changes[1].status, "R");  // b2.txt
  EXPECT_EQ(changes[1].origPath, "b.txt");
  EXPECT_EQ(changes[1].additions, "1");

  // Two sources for one destination exceed a limit of 1: only the exact
  // rename survives, as in git.
  fixture.run("git config diff.renameLimit 1");
  changes = diffCommit();
  EXPECT_EQ(changes, gitChanges(fixture.root(), "show " + sha));
  ASSERT_EQ(changes.size(), 4u);
  EXPECT_EQ(changes[0].status, "R");
  EXPECT_EQ(changes[1].status, "D");  // b.txt
  EXPECT_EQ(changes[2].status, "A");  // b2.txt

  fixture.run("git config diff.renames false");
  changes = diffCommit();
  EXPECT_EQ(changes, gitChanges(fixture.root(), "show " + sha));
  for (const auto& change : changes) EXPECT_NE(change.status, "R") << change.path;
}

TEST(StatusService, DiffRefsMatchesGitAcrossRenamesAndEdits) {
  FixtureRepo fixture;
  for (int i = 0; i < 6; ++i) {
    fixture.writeFile("dir/file" + std::to_string(i) + ".txt",
                      numberedLines("content " + std::to_string(i), 12));
  }
  fixture.run("git add dir");
  commitTick(fixture, "base", 1);
  fixture.run("git branch base");
  std::filesystem::create_directories(fixture.root() / "moved");
  fixture.run("git mv dir/file0.txt moved/file0.txt");
  fixture.run("git mv dir/file1.txt moved/renamed1.txt");
  std::string edited = numberedLines("content 2", 12);
  edited.replace(edited.find("content 2 line 3"), 16, "changed line");
  fixture.writeFile("dir/file2.txt", edited);
  fixture.run("git add dir/file2.txt");
  commitTick(fixture, "first", 2);
  fixture.run("git mv dir/file3.txt elsewhere.txt");
  fixture.writeFile("elsewhere.txt", numberedLines("content 3", 12) + "tail\n");
  fixture.run("git rm -q dir/file4.txt");
  fixture.writeFile("new.txt", "brand new\n");
  fixture.run("git add elsewhere.txt new.txt");
  commitTick(fixture, "second", 3);

  InteractiveSession session;
  const std::string repoId = discoverRepo(session, fixture.root());
  Json diff = session.request(
      req(10, "diff/refs", {{"repoId", repoId}, {"base", "base"}, {"head", "main"}}));
  ASSERT_TRUE(diff.contains("result")) << diff.dump();
  const auto engine = engineChanges(diff["result"]["files"]);
  EXPECT_EQ(engine, gitChanges(fixture.root(), "diff base main"));
  EXPECT_EQ(engine.size(), 6u);
}

TEST(StatusService, CommitDetailsCallsAnExactlyRenamedBinaryFileBinary) {
  FixtureRepo fixture;
  fixture.writeFile("image.bin", std::string("\x89PNG\x00\x01\x02\x03 data", 13));
  fixture.writeFile("notes.txt", "one\ntwo\n");
  fixture.run("git add image.bin notes.txt");
  commitTick(fixture, "add", 1);
  std::filesystem::create_directories(fixture.root() / "assets");
  std::filesystem::create_directories(fixture.root() / "docs");
  fixture.run("git mv image.bin assets/image.bin");
  fixture.run("git mv notes.txt docs/notes.txt");
  commitTick(fixture, "move", 2);

  InteractiveSession session;
  const std::string repoId = discoverRepo(session, fixture.root());
  Json details = session.request(req(10, "commit/details", {{"repoId", repoId}, {"sha", "HEAD"}}));
  ASSERT_TRUE(details.contains("result")) << details.dump();
  const Json& files = details["result"]["files"];
  ASSERT_EQ(files.size(), 2u) << details.dump();
  const Json image = changeFor(files, "assets/image.bin");
  EXPECT_EQ(image["status"], "R");
  EXPECT_EQ(image["origPath"], "image.bin");
  EXPECT_TRUE(image["binary"].get<bool>());
  EXPECT_EQ(image["additions"], 0);
  const Json notes = changeFor(files, "docs/notes.txt");
  EXPECT_EQ(notes["status"], "R");
  EXPECT_FALSE(notes["binary"].get<bool>());
  EXPECT_FALSE(notes.contains("statsUnavailable"));
}

// A `file://` URL for a local repository, as `git clone` takes it.
std::string fileUrl(const std::filesystem::path& path) {
  std::string generic = path.generic_string();
  if (generic.empty() || generic.front() != '/') generic.insert(0, "/");
  return "file://" + generic;
}

// A blobless partial clone of a three-commit repository: trees and commits
// are local, file contents only where something fetched them.
class PartialCloneFixture {
 public:
  PartialCloneFixture() {
    source_.writeFile("a.txt", "1\n2\n");
    source_.run("git add a.txt");
    commitTick(source_, "first", 1);
    source_.writeFile("a.txt", "1\n2\n3\n");
    source_.writeFile("b.txt", "bee\n");
    source_.run("git add a.txt b.txt");
    commitTick(source_, "second", 2);
    source_.writeFile("a.txt", "1\n2\n3\n4\n");
    source_.run("git add a.txt");
    commitTick(source_, "third", 3);
    source_.run("git config uploadpack.allowFilter true");
    parent_ = gg::testing::makeTempDir("gg-partial-");
    gg::testing::runGit(parent_, "git clone -q --filter=blob:none --no-checkout \"" +
                                     fileUrl(source_.root()) + "\" clone");
  }
  ~PartialCloneFixture() {
    std::error_code ec;
    std::filesystem::remove_all(parent_, ec);
  }

  const FixtureRepo& source() const { return source_; }
  std::filesystem::path root() const { return parent_ / "clone"; }
  // Objects the clone lacks.
  size_t missing() const {
    size_t count = 0;
    for (const auto& line :
         gg::testing::gitLines(root(), "rev-list --objects --missing=print --all")) {
      if (!line.empty() && line[0] == '?') ++count;
    }
    return count;
  }

 private:
  FixtureRepo source_;
  std::filesystem::path parent_;
};

TEST(StatusService, DiffInAPartialCloneFetchesTheBlobsItNeeds) {
  PartialCloneFixture partial;
  ASSERT_GT(partial.missing(), 0u);
  const std::string sha = rev(partial.source(), "HEAD~1");

  InteractiveSession session;
  const std::string repoId = discoverRepo(session, partial.root());
  Json diff = session.request(req(10, "diff/commit", {{"repoId", repoId}, {"sha", sha}}));
  ASSERT_TRUE(diff.contains("result")) << diff.dump();
  EXPECT_EQ(engineChanges(diff["result"]["files"]),
            gitChanges(partial.source().root(), "show " + sha));
  for (const auto& file : diff["result"]["files"]) EXPECT_FALSE(file.contains("statsUnavailable"));

  Json range = session.request(
      req(11, "diff/refs", {{"repoId", repoId}, {"base", "HEAD~2"}, {"head", "HEAD"}}));
  ASSERT_TRUE(range.contains("result")) << range.dump();
  EXPECT_EQ(engineChanges(range["result"]["files"]),
            gitChanges(partial.source().root(), "diff HEAD~2 HEAD"));
}

TEST(StatusService, DiffInAPartialCloneWithoutGitSaysStatsAreUnavailable) {
  PartialCloneFixture partial;
  const size_t missingBefore = partial.missing();
  ASSERT_GT(missingBefore, 0u);

  gg::testing::ScopedRestrictedMode restricted;
  InteractiveSession session;
  const std::string repoId = discoverRepo(session, partial.root());
  Json diff = session.request(req(10, "diff/commit", {{"repoId", repoId}, {"sha", "HEAD~1"}}));
  ASSERT_TRUE(diff.contains("result")) << diff.dump();
  const Json& files = diff["result"]["files"];
  ASSERT_EQ(files.size(), 2u) << diff.dump();
  for (const auto& file : files) {
    EXPECT_EQ(file["statsUnavailable"], true) << file.dump();
    EXPECT_EQ(file["additions"], 0);
    EXPECT_EQ(file["deletions"], 0);
  }

  Json details =
      session.request(req(11, "commit/details", {{"repoId", repoId}, {"sha", "HEAD~1"}}));
  ASSERT_TRUE(details.contains("result")) << details.dump();
  for (const auto& file : details["result"]["files"]) {
    EXPECT_EQ(file["statsUnavailable"], true) << file.dump();
  }

  Json content = session.request(
      req(12, "rev/fileAtRev", {{"repoId", repoId}, {"path", "a.txt"}, {"rev", "HEAD~1"}}));
  ASSERT_TRUE(content.contains("error")) << content.dump();
  EXPECT_NE(content["error"]["message"].get<std::string>().find("not available offline"),
            std::string::npos)
      << content.dump();
  // Nothing was downloaded.
  EXPECT_EQ(partial.missing(), missingBefore);
}

TEST(StatusService, FileAtRevInAPartialCloneFetchesTheBlob) {
  PartialCloneFixture partial;
  ASSERT_GT(partial.missing(), 0u);

  InteractiveSession session;
  const std::string repoId = discoverRepo(session, partial.root());
  Json content = session.request(
      req(10, "rev/fileAtRev", {{"repoId", repoId}, {"path", "a.txt"}, {"rev", "HEAD~2"}}));
  ASSERT_TRUE(content.contains("result")) << content.dump();
  EXPECT_EQ(content["result"]["contents"], "1\n2\n");

  Json missingPath = session.request(
      req(11, "rev/fileAtRev", {{"repoId", repoId}, {"path", "nope.txt"}, {"rev", "HEAD"}}));
  EXPECT_EQ(missingPath["error"]["code"], -32001);
}

TEST(StatusService, StageFilesStageAndUnstage) {
  FixtureRepo fixture;
  fixture.writeFile("a.txt", "one\n");
  fixture.writeFile("d.txt", "doomed\n");
  fixture.run("git add a.txt d.txt");
  commitTick(fixture, "seed", 1);
  fixture.writeFile("a.txt", "one\ntwo\n");
  fixture.writeFile("n.txt", "brand new\n");
  std::filesystem::remove(fixture.root() / "d.txt");

  InteractiveSession session;
  const std::string repoId = discoverRepo(session, fixture.root());

  Json stage = session.request(req(10, "stage/files",
                                   {{"repoId", repoId},
                                    {"paths", {"a.txt", "n.txt", "d.txt"}},
                                    {"action", "stage"}}));
  ASSERT_TRUE(stage.contains("result")) << stage.dump();

  Json summary = statusSummary(session, 11, repoId);
  EXPECT_EQ(changeFor(summary["staged"], "a.txt")["status"], "M");
  EXPECT_EQ(changeFor(summary["staged"], "n.txt")["status"], "A");
  EXPECT_EQ(changeFor(summary["staged"], "d.txt")["status"], "D");
  EXPECT_TRUE(summary["unstaged"].empty());
  EXPECT_TRUE(summary["untracked"].empty());
  // Parity: git sees the same staged set.
  EXPECT_EQ(gitOut(fixture.root(), "diff --cached --name-status"),
            "M\ta.txt\nD\td.txt\nA\tn.txt\n");

  Json unstage = session.request(req(12, "stage/files",
                                     {{"repoId", repoId},
                                      {"paths", {"a.txt", "n.txt", "d.txt"}},
                                      {"action", "unstage"}}));
  ASSERT_TRUE(unstage.contains("result")) << unstage.dump();

  Json after = statusSummary(session, 13, repoId);
  EXPECT_TRUE(after["staged"].empty());
  EXPECT_EQ(changeFor(after["unstaged"], "a.txt")["status"], "M");
  EXPECT_EQ(changeFor(after["unstaged"], "d.txt")["status"], "D");
  EXPECT_EQ(after["untracked"], Json::array({"n.txt"}));

  Json badAction = session.request(
      req(14, "stage/files", {{"repoId", repoId}, {"paths", {"a.txt"}}, {"action", "toggle"}}));
  EXPECT_EQ(badAction["error"]["code"], -32602);
}

TEST(StatusService, StageHunksStagesOnlySelectedHunk) {
  FixtureRepo fixture;
  std::string contents;
  for (int i = 1; i <= 20; ++i) {
    contents += (i < 10 ? "line0" : "line") + std::to_string(i) + "\n";
  }
  fixture.writeFile("hunky.txt", contents);
  fixture.run("git add hunky.txt");
  commitTick(fixture, "seed", 1);
  std::string edited = contents;
  edited.replace(edited.find("line02\n"), 7, "line02 EDITED\n");
  edited.replace(edited.find("line18\n"), 7, "line18 EDITED\n");
  fixture.writeFile("hunky.txt", edited);

  InteractiveSession session;
  const std::string repoId = discoverRepo(session, fixture.root());

  Json unstaged = session.request(
      req(10, "diff/fileHunks", {{"repoId", repoId}, {"path", "hunky.txt"}, {"staged", false}}));
  const Json& hunks = unstaged["result"]["hunks"];
  ASSERT_EQ(hunks.size(), 2u) << unstaged.dump();

  Json firstRange = {{"oldStart", hunks[0]["oldStart"]},
                     {"oldLines", hunks[0]["oldLines"]},
                     {"newStart", hunks[0]["newStart"]},
                     {"newLines", hunks[0]["newLines"]}};
  Json stage = session.request(req(11, "stage/hunks",
                                   {{"repoId", repoId},
                                    {"path", "hunky.txt"},
                                    {"action", "stage"},
                                    {"hunks", Json::array({firstRange})}}));
  ASSERT_TRUE(stage.contains("result")) << stage.dump();

  // The file is now both staged (hunk 1) and unstaged (hunk 2).
  Json summary = statusSummary(session, 12, repoId);
  EXPECT_EQ(changeFor(summary["staged"], "hunky.txt")["status"], "M");
  EXPECT_EQ(changeFor(summary["unstaged"], "hunky.txt")["status"], "M");

  // Parity via the CLI: the index diff holds exactly hunk 1, the worktree
  // diff exactly hunk 2.
  const std::string cached = gitOut(fixture.root(), "diff --cached");
  EXPECT_NE(cached.find("+line02 EDITED"), std::string::npos) << cached;
  EXPECT_EQ(cached.find("line18 EDITED"), std::string::npos) << cached;
  const std::string worktree = gitOut(fixture.root(), "diff");
  EXPECT_NE(worktree.find("+line18 EDITED"), std::string::npos) << worktree;
  EXPECT_EQ(worktree.find("line02 EDITED"), std::string::npos) << worktree;

  // Unstage the staged hunk again (ranges from a fresh staged diff).
  Json stagedHunks = session.request(
      req(13, "diff/fileHunks", {{"repoId", repoId}, {"path", "hunky.txt"}, {"staged", true}}));
  ASSERT_EQ(stagedHunks["result"]["hunks"].size(), 1u);
  const Json& staged0 = stagedHunks["result"]["hunks"][0];
  Json unstageReq = session.request(req(14, "stage/hunks",
                                        {{"repoId", repoId},
                                         {"path", "hunky.txt"},
                                         {"action", "unstage"},
                                         {"hunks",
                                          Json::array({{{"oldStart", staged0["oldStart"]},
                                                        {"oldLines", staged0["oldLines"]},
                                                        {"newStart", staged0["newStart"]},
                                                        {"newLines", staged0["newLines"]}}})}}));
  ASSERT_TRUE(unstageReq.contains("result")) << unstageReq.dump();
  EXPECT_EQ(gitOut(fixture.root(), "diff --cached"), "");
  Json after = statusSummary(session, 15, repoId);
  EXPECT_TRUE(after["staged"].empty());
  EXPECT_EQ(changeFor(after["unstaged"], "hunky.txt")["status"], "M");

  // Stale ranges are rejected instead of applying the wrong lines.
  Json stale = session.request(req(16, "stage/hunks",
                                   {{"repoId", repoId},
                                    {"path", "hunky.txt"},
                                    {"action", "stage"},
                                    {"hunks",
                                     Json::array({{{"oldStart", 999},
                                                   {"oldLines", 1},
                                                   {"newStart", 999},
                                                   {"newLines", 1}}})}}));
  EXPECT_EQ(stale["error"]["code"], -32001);
}

// --- Filter drivers and working-tree-encoding -----------------------------
// git runs filter drivers (git-lfs, git-crypt, nbstripout, custom
// clean/smudge) and working-tree-encoding when it stores content; libgit2 runs
// neither. These pin the engine to what `git add` stores and to the
// clean/dirty verdict `git status` gives.

std::string trimmed(std::string text) {
  while (!text.empty() && (text.back() == '\n' || text.back() == '\r')) text.pop_back();
  return text;
}

// The blob id the index holds for `path`.
std::string indexId(const FixtureRepo& fixture, const std::string& path) {
  return trimmed(gitOut(fixture.root(), "rev-parse :" + path));
}

// The blob id `git add` would store for the working-tree file: hash-object
// runs the same filter driver and working-tree-encoding.
std::string cleanedId(const FixtureRepo& fixture, const std::string& path) {
  return trimmed(gitOut(fixture.root(), "hash-object -- " + path));
}

// A clean filter that scrubs a secret: `git add` stores "token=REDACTED"
// whatever the working tree holds.
void configureScrubFilter(FixtureRepo& fixture) {
  fixture.run("git config filter.scrub.clean \"sed -e s/SECRET/REDACTED/\"");
  fixture.run("git config filter.scrub.smudge cat");
  fixture.run("git config filter.scrub.required true");
}

// A stand-in for Git LFS that needs no git-lfs install: the stored blob is a
// one-line digest of the content, much like an LFS pointer. Global config is
// isolated for the test, since a developer's `git lfs install` would
// otherwise route the "lfs" driver to the real git-lfs.
class FakeLfs {
 public:
  explicit FakeLfs(FixtureRepo& fixture)
      : globalConfig_("GIT_CONFIG_GLOBAL",
                      writeEmpty(fixture.root() / ".git" / "isolated-global-config")) {
    fixture.run("git config filter.lfs.clean \"git hash-object --stdin\"");
    fixture.run("git config filter.lfs.smudge cat");
  }

 private:
  static std::string writeEmpty(const std::filesystem::path& file) {
    std::ofstream(file, std::ios::binary).flush();
    return file.string();
  }
  gg::testing::ScopedEnv globalConfig_;
};

// ASCII `text` as UTF-16LE with a byte-order mark: the working-tree form of a
// file declared `working-tree-encoding=UTF-16LE-BOM`.
std::string utf16le(const std::string& text) {
  std::string out = "\xff\xfe";
  for (const char c : text) {
    out += c;
    out += '\0';
  }
  return out;
}

// Moves a file's mtime forward without changing its bytes, so the index's
// stat data no longer vouches for it and status has to look at the content.
void touch(const FixtureRepo& fixture, const std::string& path) {
  const auto file = fixture.root() / path;
  std::filesystem::last_write_time(
      file, std::filesystem::last_write_time(file) + std::chrono::seconds(5));
}

Json rangeOf(const Json& hunk) {
  return {{"oldStart", hunk["oldStart"]},
          {"oldLines", hunk["oldLines"]},
          {"newStart", hunk["newStart"]},
          {"newLines", hunk["newLines"]}};
}

Json fileHunks(InteractiveSession& session, std::int64_t id, const std::string& repoId,
               const std::string& path, bool staged) {
  return session.request(
      req(id, "diff/fileHunks", {{"repoId", repoId}, {"path", path}, {"staged", staged}}));
}

Json stageHunks(InteractiveSession& session, std::int64_t id, const std::string& repoId,
                const std::string& path, const std::string& action, Json ranges) {
  return session.request(
      req(id, "stage/hunks",
          {{"repoId", repoId}, {"path", path}, {"action", action}, {"hunks", std::move(ranges)}}));
}

Json stageFiles(InteractiveSession& session, std::int64_t id, const std::string& repoId,
                const std::vector<std::string>& paths, const std::string& action) {
  return session.request(
      req(id, "stage/files", {{"repoId", repoId}, {"paths", paths}, {"action", action}}));
}

TEST(StatusService, StageFilesRunsCleanFilter) {
  FixtureRepo fixture;
  configureScrubFilter(fixture);
  fixture.writeFile(".gitattributes", "*.env filter=scrub\n");
  fixture.writeFile("app.env", "token=SECRET\n");
  fixture.run("git add .gitattributes app.env");
  commitTick(fixture, "seed", 1);
  fixture.writeFile("app.env", "token=SECRET\nport=2\n");

  InteractiveSession session;
  const std::string repoId = discoverRepo(session, fixture.root());
  Json stage = stageFiles(session, 10, repoId, {"app.env"}, "stage");
  ASSERT_TRUE(stage.contains("result")) << stage.dump();

  // Parity with `git add app.env`: the index holds the cleaned bytes.
  EXPECT_EQ(gitOut(fixture.root(), "cat-file -p :app.env"), "token=REDACTED\nport=2\n");
  EXPECT_EQ(indexId(fixture, "app.env"), cleanedId(fixture, "app.env"));
  EXPECT_EQ(gitOut(fixture.root(), "diff --name-only"), "");
}

TEST(StatusService, StageFilesAppliesWorkingTreeEncoding) {
  FixtureRepo fixture;
  fixture.writeFile(".gitattributes", "*.txt working-tree-encoding=UTF-16LE-BOM\n");
  fixture.writeFile("notes.txt", utf16le("hello\nworld\n"));
  fixture.run("git add .gitattributes notes.txt");
  commitTick(fixture, "seed", 1);
  fixture.writeFile("notes.txt", utf16le("hello\nthere\n"));

  InteractiveSession session;
  const std::string repoId = discoverRepo(session, fixture.root());
  Json stage = stageFiles(session, 10, repoId, {"notes.txt"}, "stage");
  ASSERT_TRUE(stage.contains("result")) << stage.dump();

  // git stores UTF-8; the UTF-16 bytes exist only in working trees.
  EXPECT_EQ(gitOut(fixture.root(), "cat-file -p :notes.txt"), "hello\nthere\n");
  EXPECT_EQ(indexId(fixture, "notes.txt"), cleanedId(fixture, "notes.txt"));
}

TEST(StatusService, StageFilesStoresPointerForLfsFilter) {
  FixtureRepo fixture;
  FakeLfs lfs(fixture);
  fixture.writeFile(".gitattributes", "*.bin filter=lfs -text\n");
  fixture.run("git add .gitattributes");
  commitTick(fixture, "track bin", 1);
  fixture.writeFile("big.bin", std::string(300000, '\x01'));

  InteractiveSession session;
  const std::string repoId = discoverRepo(session, fixture.root());
  Json stage = stageFiles(session, 10, repoId, {"big.bin"}, "stage");
  ASSERT_TRUE(stage.contains("result")) << stage.dump();

  EXPECT_EQ(indexId(fixture, "big.bin"), cleanedId(fixture, "big.bin"));
  const std::string size = trimmed(gitOut(fixture.root(), "cat-file -s :big.bin"));
  EXPECT_LT(std::stoul(size.empty() ? "0" : size), 100u)
      << "index holds " << size << " bytes instead of a pointer";
}

TEST(StatusService, StageFilesKeepsGitLfsPointer) {
  FixtureRepo fixture;
  if (gitOut(fixture.root(), "lfs version").rfind("git-lfs/", 0) != 0) {
    GTEST_SKIP() << "git-lfs is not installed";
  }
  fixture.run("git lfs install --local");
  fixture.writeFile(".gitattributes", "*.bin filter=lfs diff=lfs merge=lfs -text\n");
  fixture.run("git add .gitattributes");
  commitTick(fixture, "track bin", 1);
  fixture.writeFile("big.bin", std::string(300000, '\x01'));

  InteractiveSession session;
  const std::string repoId = discoverRepo(session, fixture.root());
  Json stage = stageFiles(session, 10, repoId, {"big.bin"}, "stage");
  ASSERT_TRUE(stage.contains("result")) << stage.dump();

  // `git add big.bin` stores a ~130-byte pointer, never the 300 kB payload.
  const std::string staged = gitOut(fixture.root(), "cat-file -p :big.bin");
  EXPECT_EQ(staged.rfind("version https://git-lfs.github.com/spec/v1\n", 0), 0u)
      << "index holds " << staged.size() << " bytes instead of an LFS pointer";
}

// Stage All sends what the last status listed. A path that has since left
// both the index and the working tree has nothing to stage and must not stop
// the others, which `git add` would do for a pathspec matching nothing.
TEST(StatusService, StageFilesSkipsPathsThatMatchNothing) {
  FixtureRepo fixture;
  fixture.writeFile("a.txt", "one\n");
  fixture.writeFile("old.txt", "old\n");
  fixture.writeFile("gone.txt", "gone\n");
  fixture.run("git add a.txt old.txt gone.txt");
  commitTick(fixture, "seed", 1);
  fixture.writeFile("a.txt", "one\ntwo\n");
  fixture.writeFile("new.txt", "new\n");
  std::filesystem::remove(fixture.root() / "old.txt");

  InteractiveSession session;
  const std::string repoId = discoverRepo(session, fixture.root());
  Json summary = statusSummary(session, 10, repoId);
  ASSERT_TRUE(hasPath(summary["unstaged"], "a.txt")) << summary.dump();
  ASSERT_EQ(summary["untracked"], Json::array({"new.txt"})) << summary.dump();
  // Meanwhile the untracked file is deleted and gone.txt's removal is staged.
  std::filesystem::remove(fixture.root() / "new.txt");
  fixture.run("git rm -q gone.txt");

  Json stage =
      stageFiles(session, 11, repoId, {"a.txt", "new.txt", "gone.txt", "old.txt"}, "stage");
  ASSERT_TRUE(stage.contains("result")) << stage.dump();
  EXPECT_EQ(gitOut(fixture.root(), "diff --cached --name-status"),
            "M\ta.txt\nD\tgone.txt\nD\told.txt\n");
}

// `git add` holds index.lock while its clean filters run, and a killed git
// leaves the lock behind. Cancelling stage/files therefore lets a running
// `git add` finish instead of locking the repository for every git tool.
TEST(StatusService, CancelledStageFilesLeavesNoIndexLock) {
  FixtureRepo fixture;
  fixture.writeFile(".gitattributes", "*.bin filter=held\n");
  fixture.writeFile("a.bin", "one\n");
  fixture.run("git add .gitattributes a.bin");
  commitTick(fixture, "seed", 1);
  // From here the clean filter holds `git add` until .git/release exists.
  fixture.writeFile(".git/held-clean.sh",
                    "while [ ! -f .git/release ]; do :; done\n"
                    "cat\n");
  fixture.run("git config filter.held.clean \"sh .git/held-clean.sh\"");
  fixture.run("git config filter.held.smudge cat");
  fixture.writeFile("a.bin", "two\n");

  InteractiveSession session;
  const std::string repoId = discoverRepo(session, fixture.root());
  const auto lock = fixture.root() / ".git" / "index.lock";
  bool sawLock = false;
  std::thread canceller([&] {
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(30);
    while (!std::filesystem::exists(lock) && std::chrono::steady_clock::now() < deadline) {
      std::this_thread::sleep_for(std::chrono::milliseconds(5));
    }
    sawLock = std::filesystem::exists(lock);
    session.notify({{"jsonrpc", "2.0"}, {"method", "$/cancelRequest"}, {"params", {{"id", 10}}}});
    // Time for the cancellation to land while git is still held.
    std::this_thread::sleep_for(std::chrono::milliseconds(300));
    fixture.writeFile(".git/release", "");
  });
  Json stage = stageFiles(session, 10, repoId, {"a.bin"}, "stage");
  canceller.join();
  ASSERT_TRUE(sawLock) << "git add never took index.lock: " << stage.dump();

  EXPECT_FALSE(std::filesystem::exists(lock)) << stage.dump();
  EXPECT_EQ(gitOut(fixture.root(), "cat-file -p :a.bin"), "two\n");
  EXPECT_EQ(gitOut(fixture.root(), "status --porcelain"), "M  a.bin\n");
}

TEST(StatusService, HunksOfFilteredFileAreGitsHunks) {
  FixtureRepo fixture;
  configureScrubFilter(fixture);
  fixture.writeFile(".gitattributes", "*.env filter=scrub\n");
  fixture.writeFile("app.env", "token=SECRET\nport=1\n");
  fixture.run("git add .gitattributes app.env");
  commitTick(fixture, "seed", 1);
  fixture.writeFile("app.env", "token=SECRET\nport=2\n");

  InteractiveSession session;
  const std::string repoId = discoverRepo(session, fixture.root());
  Json hunks = fileHunks(session, 10, repoId, "app.env", false);
  ASSERT_EQ(hunks["result"]["hunks"].size(), 1u) << hunks.dump();
  // The port edit is the only change git sees; the scrubbed line is context
  // in its cleaned form, never the working tree's secret.
  const Json& hunk = hunks["result"]["hunks"][0];
  EXPECT_EQ(hunk["lines"], Json::array({" token=REDACTED", "-port=1", "+port=2"}));

  Json stage = stageHunks(session, 11, repoId, "app.env", "stage", Json::array({rangeOf(hunk)}));
  ASSERT_TRUE(stage.contains("result")) << stage.dump();
  EXPECT_EQ(gitOut(fixture.root(), "cat-file -p :app.env"), "token=REDACTED\nport=2\n");
  EXPECT_EQ(gitOut(fixture.root(), "diff --name-only"), "");

  // The staged side was already clean; unstaging reverses the same hunk.
  Json staged = fileHunks(session, 12, repoId, "app.env", true);
  ASSERT_EQ(staged["result"]["hunks"].size(), 1u) << staged.dump();
  Json unstage = stageHunks(session, 13, repoId, "app.env", "unstage",
                            Json::array({rangeOf(staged["result"]["hunks"][0])}));
  ASSERT_TRUE(unstage.contains("result")) << unstage.dump();
  EXPECT_EQ(gitOut(fixture.root(), "cat-file -p :app.env"), "token=REDACTED\nport=1\n");
}

TEST(StatusService, StageHunksAppliesWorkingTreeEncoding) {
  FixtureRepo fixture;
  fixture.writeFile(".gitattributes", "*.txt working-tree-encoding=UTF-16LE-BOM\n");
  std::string contents;
  for (int i = 1; i <= 20; ++i) contents += "line" + std::to_string(100 + i) + "\n";
  fixture.writeFile("notes.txt", utf16le(contents));
  fixture.run("git add .gitattributes notes.txt");
  commitTick(fixture, "seed", 1);
  std::string edited = contents;
  edited.replace(edited.find("line102\n"), 8, "line102 EDITED\n");
  edited.replace(edited.find("line118\n"), 8, "line118 EDITED\n");
  fixture.writeFile("notes.txt", utf16le(edited));

  InteractiveSession session;
  const std::string repoId = discoverRepo(session, fixture.root());
  Json hunks = fileHunks(session, 10, repoId, "notes.txt", false);
  ASSERT_EQ(hunks["result"]["hunks"].size(), 2u) << hunks.dump();
  // UTF-8 lines, as git diffs them, not UTF-16 bytes.
  EXPECT_EQ(
      hunks["result"]["hunks"][0]["lines"],
      Json::array({" line101", "-line102", "+line102 EDITED", " line103", " line104", " line105"}));

  Json stage = stageHunks(session, 11, repoId, "notes.txt", "stage",
                          Json::array({rangeOf(hunks["result"]["hunks"][0])}));
  ASSERT_TRUE(stage.contains("result")) << stage.dump();
  std::string expected = contents;
  expected.replace(expected.find("line102\n"), 8, "line102 EDITED\n");
  // UTF-8 in the index, holding the first edit only.
  EXPECT_EQ(gitOut(fixture.root(), "cat-file -p :notes.txt"), expected);
}

TEST(StatusService, StageHunksStagesNewFilteredFileCleaned) {
  FixtureRepo fixture;
  configureScrubFilter(fixture);
  fixture.writeFile(".gitattributes", "*.env filter=scrub\n");
  fixture.run("git add .gitattributes");
  commitTick(fixture, "seed", 1);
  fixture.writeFile("new.env", "token=SECRET\nport=1\n");

  InteractiveSession session;
  const std::string repoId = discoverRepo(session, fixture.root());
  Json hunks = fileHunks(session, 10, repoId, "new.env", false);
  ASSERT_EQ(hunks["result"]["hunks"].size(), 1u) << hunks.dump();
  EXPECT_EQ(hunks["result"]["hunks"][0]["lines"], Json::array({"+token=REDACTED", "+port=1"}));

  Json stage = stageHunks(session, 11, repoId, "new.env", "stage",
                          Json::array({rangeOf(hunks["result"]["hunks"][0])}));
  ASSERT_TRUE(stage.contains("result")) << stage.dump();
  EXPECT_EQ(gitOut(fixture.root(), "cat-file -p :new.env"), "token=REDACTED\nport=1\n");
}

TEST(StatusService, StageHunksRefusesLfsPointer) {
  FixtureRepo fixture;
  FakeLfs lfs(fixture);
  fixture.writeFile(".gitattributes", "*.csv filter=lfs\n");
  fixture.writeFile("data.csv", "a,b\n1,2\n");
  fixture.run("git add .gitattributes data.csv");
  commitTick(fixture, "seed", 1);
  const std::string before = indexId(fixture, "data.csv");
  fixture.writeFile("data.csv", "a,b\n1,2\n3,4\n");

  InteractiveSession session;
  const std::string repoId = discoverRepo(session, fixture.root());
  // git's own view: the pointer changed, nothing else.
  Json hunks = fileHunks(session, 10, repoId, "data.csv", false);
  ASSERT_EQ(hunks["result"]["hunks"].size(), 1u) << hunks.dump();
  EXPECT_EQ(hunks["result"]["hunks"][0]["oldLines"], 1);

  Json stage = stageHunks(session, 11, repoId, "data.csv", "stage",
                          Json::array({rangeOf(hunks["result"]["hunks"][0])}));
  ASSERT_TRUE(stage.contains("error")) << stage.dump();
  EXPECT_EQ(stage["error"]["code"], -32011);
  EXPECT_NE(stage["error"]["message"].get<std::string>().find("Git LFS"), std::string::npos);
  EXPECT_EQ(indexId(fixture, "data.csv"), before);

  // The whole file still stages, as the pointer `git add` writes.
  Json whole = stageFiles(session, 12, repoId, {"data.csv"}, "stage");
  ASSERT_TRUE(whole.contains("result")) << whole.dump();
  EXPECT_EQ(indexId(fixture, "data.csv"), cleanedId(fixture, "data.csv"));
}

TEST(StatusService, StageHunksRejectsSubmodule) {
  FixtureRepo library;
  library.writeFile("lib.txt", "one\n");
  library.run("git add lib.txt");
  commitTick(library, "lib one", 1);

  FixtureRepo fixture;
  fixture.run("git -c protocol.file.allow=always submodule --quiet add \"" +
              library.root().generic_string() + "\" sub");
  commitTick(fixture, "add submodule", 2);
  gg::testing::runGit(fixture.root() / "sub",
                      "git -c user.name=F -c user.email=f@example.invalid commit -q "
                      "--allow-empty -m moved");

  InteractiveSession session;
  const std::string repoId = discoverRepo(session, fixture.root());
  // A gitlink has no text hunks.
  Json hunks = fileHunks(session, 10, repoId, "sub", false);
  ASSERT_TRUE(hunks.contains("result")) << hunks.dump();
  EXPECT_TRUE(hunks["result"]["hunks"].empty()) << hunks.dump();

  // Asking to stage one anyway fails cleanly instead of taking the engine
  // down with the index lock held.
  Json stage = stageHunks(
      session, 11, repoId, "sub", "stage",
      Json::array({{{"oldStart", 1}, {"oldLines", 1}, {"newStart", 1}, {"newLines", 1}}}));
  ASSERT_TRUE(stage.contains("error")) << stage.dump();
  EXPECT_EQ(stage["error"]["code"], -32011);
  EXPECT_FALSE(std::filesystem::exists(fixture.root() / ".git" / "index.lock"));
  Json summary = statusSummary(session, 12, repoId);
  EXPECT_EQ(changeFor(summary["unstaged"], "sub")["status"], "M");
}

TEST(StatusService, SummaryIgnoresTouchedFilteredFiles) {
  FixtureRepo fixture;
  configureScrubFilter(fixture);
  FakeLfs lfs(fixture);
  fixture.writeFile(".gitattributes",
                    "*.env filter=scrub\n*.bin filter=lfs -text\n"
                    "*.txt working-tree-encoding=UTF-16LE-BOM\n");
  fixture.writeFile("app.env", "token=SECRET\n");
  fixture.writeFile("edited.env", "token=SECRET\nport=1\n");
  fixture.writeFile("big.bin", std::string(5000, '\x02'));
  fixture.writeFile("notes.txt", utf16le("hello\n"));
  fixture.run("git add .gitattributes app.env edited.env big.bin notes.txt");
  commitTick(fixture, "seed", 1);
  // Same bytes, new mtimes: only content can settle these.
  for (const char* path : {"app.env", "big.bin", "notes.txt"}) touch(fixture, path);
  fixture.writeFile("edited.env", "token=SECRET\nport=2\n");

  InteractiveSession session;
  const std::string repoId = discoverRepo(session, fixture.root());
  Json summary = statusSummary(session, 10, repoId);
  // A filtered file with a real change is still reported.
  ASSERT_EQ(summary["unstaged"].size(), 1u) << summary.dump();
  EXPECT_EQ(changeFor(summary["unstaged"], "edited.env")["status"], "M");
  EXPECT_EQ(gitOut(fixture.root(), "status --porcelain"), " M edited.env\n");
}

// The content recheck of filtered files must not hide a change of the
// executable bit, which git reports and stages whatever the content.
TEST(StatusService, SummaryKeepsModeChangeOfFilteredFiles) {
#ifdef _WIN32
  GTEST_SKIP() << "Windows checkouts have no executable bit (core.fileMode=false)";
#endif
  FixtureRepo fixture;
  configureScrubFilter(fixture);
  fixture.writeFile(".gitattributes",
                    "*.env filter=scrub\n*.txt working-tree-encoding=UTF-16LE-BOM\n");
  fixture.writeFile("app.env", "token=SECRET\n");
  fixture.writeFile("notes.txt", utf16le("hello\n"));
  fixture.run("git add .gitattributes app.env notes.txt");
  commitTick(fixture, "seed", 1);
  for (const char* path : {"app.env", "notes.txt"}) {
    std::filesystem::permissions(fixture.root() / path, std::filesystem::perms::owner_exec,
                                 std::filesystem::perm_options::add);
  }
  ASSERT_EQ(gitOut(fixture.root(), "status --porcelain"), " M app.env\n M notes.txt\n");

  InteractiveSession session;
  const std::string repoId = discoverRepo(session, fixture.root());
  Json summary = statusSummary(session, 10, repoId);
  ASSERT_EQ(summary["unstaged"].size(), 2u) << summary.dump();
  EXPECT_EQ(changeFor(summary["unstaged"], "app.env")["status"], "M");
  EXPECT_EQ(changeFor(summary["unstaged"], "notes.txt")["status"], "M");

  // Stage All then records the new mode.
  Json stage = stageFiles(session, 11, repoId, {"app.env", "notes.txt"}, "stage");
  ASSERT_TRUE(stage.contains("result")) << stage.dump();
  EXPECT_EQ(gitOut(fixture.root(), "diff --cached --summary"),
            " mode change 100644 => 100755 app.env\n mode change 100644 => 100755 notes.txt\n");
}

TEST(StatusService, PathsAreLiteralNotGlobs) {
  FixtureRepo fixture;
  fixture.writeFile("app/[id]/page.tsx", "x\ny\nz\n");
  fixture.writeFile("app/i/page.tsx", "x\ny\nz\n");
  fixture.run("git add app");
  commitTick(fixture, "routes", 1);
  // `[id]` as a glob matches `i`: only the sibling changes.
  fixture.writeFile("app/i/page.tsx", "x\nY\nz\n");

  InteractiveSession session;
  const std::string repoId = discoverRepo(session, fixture.root());
  Json hunks = fileHunks(session, 10, repoId, "app/[id]/page.tsx", false);
  ASSERT_TRUE(hunks.contains("result")) << hunks.dump();
  EXPECT_TRUE(hunks["result"]["hunks"].empty()) << hunks.dump();

  Json hunkStage = stageHunks(
      session, 11, repoId, "app/[id]/page.tsx", "stage",
      Json::array({{{"oldStart", 1}, {"oldLines", 3}, {"newStart", 1}, {"newLines", 3}}}));
  EXPECT_TRUE(hunkStage.contains("error")) << hunkStage.dump();
  Json fileStage = stageFiles(session, 12, repoId, {"app/[id]/page.tsx"}, "stage");
  ASSERT_TRUE(fileStage.contains("result")) << fileStage.dump();
  EXPECT_EQ(gitOut(fixture.root(), "diff --cached --name-only"), "");

  // With both staged, unstaging the bracketed route leaves the sibling.
  fixture.writeFile("app/[id]/page.tsx", "x\ny\nZ\n");
  Json both = stageFiles(session, 13, repoId, {"app/[id]/page.tsx", "app/i/page.tsx"}, "stage");
  ASSERT_TRUE(both.contains("result")) << both.dump();
  Json unstage = stageFiles(session, 14, repoId, {"app/[id]/page.tsx"}, "unstage");
  ASSERT_TRUE(unstage.contains("result")) << unstage.dump();
  EXPECT_EQ(gitOut(fixture.root(), "diff --cached --name-only"), "app/i/page.tsx\n");
}

TEST(StatusService, SparseCheckoutLeavesOutOfConeFilesAlone) {
  FixtureRepo fixture;
  fixture.writeFile("keep/k.txt", "keep\n");
  fixture.writeFile("other/f1.txt", "one\n");
  fixture.writeFile("other/deep/d.txt", "deep\n");
  fixture.run("git add keep other");
  commitTick(fixture, "seed", 1);
  fixture.run("git sparse-checkout set --cone keep");
  ASSERT_FALSE(std::filesystem::exists(fixture.root() / "other" / "f1.txt"));
  fixture.writeFile("keep/k.txt", "keep\nedited\n");

  InteractiveSession session;
  const std::string repoId = discoverRepo(session, fixture.root());
  // Out-of-cone files are absent by design, not deleted.
  Json summary = statusSummary(session, 10, repoId);
  ASSERT_EQ(summary["unstaged"].size(), 1u) << summary.dump();
  EXPECT_EQ(changeFor(summary["unstaged"], "keep/k.txt")["status"], "M");

  // The commit palette's "Stage All" stages what status listed, and only
  // that: no deletion of the out-of-cone tree.
  std::vector<std::string> stageable;
  for (const auto& change : summary["unstaged"]) stageable.push_back(change["path"]);
  Json stage = stageFiles(session, 11, repoId, stageable, "stage");
  ASSERT_TRUE(stage.contains("result")) << stage.dump();
  EXPECT_EQ(gitOut(fixture.root(), "diff --cached --name-status"), "M\tkeep/k.txt\n");

  // Naming an out-of-cone path explicitly is refused before anything changes.
  Json sparse = stageFiles(session, 12, repoId, {"other/f1.txt"}, "stage");
  ASSERT_TRUE(sparse.contains("error")) << sparse.dump();
  EXPECT_NE(sparse["error"]["message"].get<std::string>().find("sparse"), std::string::npos);
  EXPECT_EQ(gitOut(fixture.root(), "diff --cached --name-status"), "M\tkeep/k.txt\n");

  // Nor does it have hunks: like `git diff`, the absent file is no deletion.
  Json hunks = fileHunks(session, 13, repoId, "other/f1.txt", false);
  ASSERT_TRUE(hunks.contains("result")) << hunks.dump();
  EXPECT_TRUE(hunks["result"]["hunks"].empty()) << hunks.dump();
  Json hunkStage = stageHunks(
      session, 14, repoId, "other/f1.txt", "stage",
      Json::array({{{"oldStart", 1}, {"oldLines", 1}, {"newStart", 0}, {"newLines", 0}}}));
  EXPECT_TRUE(hunkStage.contains("error")) << hunkStage.dump();
  EXPECT_EQ(gitOut(fixture.root(), "diff --cached --name-status"), "M\tkeep/k.txt\n");
}

TEST(StatusService, DirtySubmoduleIsNotStageable) {
  FixtureRepo library;
  library.writeFile("lib.txt", "one\n");
  library.run("git add lib.txt");
  commitTick(library, "lib one", 1);

  FixtureRepo fixture;
  fixture.run("git -c protocol.file.allow=always submodule --quiet add \"" +
              library.root().generic_string() + "\" sub");
  commitTick(fixture, "add submodule", 2);
  // Local edits inside the submodule: nothing the parent can stage.
  fixture.writeFile("sub/lib.txt", "one\nlocal\n");
  fixture.writeFile("sub/scratch.txt", "untracked\n");

  InteractiveSession session;
  const std::string repoId = discoverRepo(session, fixture.root());
  Json summary = statusSummary(session, 10, repoId);
  EXPECT_TRUE(summary["unstaged"].empty()) << summary.dump();
  EXPECT_TRUE(summary["untracked"].empty()) << summary.dump();

  // A new commit in the submodule is a change the parent records.
  gg::testing::runGit(fixture.root() / "sub",
                      "git -c user.name=F -c user.email=f@example.invalid commit -q -a -m local");
  Json moved = statusSummary(session, 11, repoId);
  EXPECT_EQ(changeFor(moved["unstaged"], "sub")["status"], "M");
  Json stage = stageFiles(session, 12, repoId, {"sub"}, "stage");
  ASSERT_TRUE(stage.contains("result")) << stage.dump();
  EXPECT_EQ(gitOut(fixture.root(), "diff --cached --name-only"), "sub\n");
}

TEST(StatusService, StageFilesHandlesNonAsciiNames) {
  FixtureRepo fixture;
  const std::filesystem::path file = fixture.root() / std::filesystem::path(u8"caf\u00e9.txt");
  std::ofstream(file, std::ios::binary) << "one\n";
  fixture.run("git add -A");
  commitTick(fixture, "seed", 1);
  std::ofstream(file, std::ios::binary | std::ios::trunc) << "one\ntwo\n";

  InteractiveSession session;
  const std::string repoId = discoverRepo(session, fixture.root());
  const std::string name = "caf\xc3\xa9.txt";
  Json stage = stageFiles(session, 10, repoId, {name}, "stage");
  ASSERT_TRUE(stage.contains("result")) << stage.dump();
  // Modified, not deleted: the path reached git as UTF-8.
  EXPECT_EQ(gitOut(fixture.root(), "-c core.quotePath=false diff --cached --name-status"),
            "M\t" + name + "\n");
}

// Points the process temp directory at `dir` for the scope: TMPDIR on POSIX,
// TMP and TEMP on Windows, set through the wide API so a non-ASCII directory
// survives.
class ScopedTempDir {
 public:
  explicit ScopedTempDir(const std::filesystem::path& dir) {
#ifdef _WIN32
    for (const wchar_t* name : {L"TMP", L"TEMP"}) {
      const wchar_t* old = _wgetenv(name);
      saved_.emplace_back(name, old ? std::optional<std::wstring>(old) : std::nullopt);
      _wputenv_s(name, dir.wstring().c_str());
    }
#else
    const char* old = std::getenv("TMPDIR");
    saved_ = old ? std::optional<std::string>(old) : std::nullopt;
    ::setenv("TMPDIR", dir.c_str(), 1);
#endif
  }
  ~ScopedTempDir() {
#ifdef _WIN32
    for (const auto& [name, value] : saved_) _wputenv_s(name.c_str(), value ? value->c_str() : L"");
#else
    if (saved_) {
      ::setenv("TMPDIR", saved_->c_str(), 1);
    } else {
      ::unsetenv("TMPDIR");
    }
#endif
  }
  ScopedTempDir(const ScopedTempDir&) = delete;
  ScopedTempDir& operator=(const ScopedTempDir&) = delete;

 private:
#ifdef _WIN32
  std::vector<std::pair<std::wstring, std::optional<std::wstring>>> saved_;
#else
  std::optional<std::string> saved_;
#endif
};

TEST(StatusService, StageHunksUnderNonAsciiTempDir) {
  FixtureRepo fixture;
  configureScrubFilter(fixture);
  fixture.writeFile(".gitattributes", "*.env filter=scrub\n");
  fixture.writeFile("app.env", "token=SECRET\nport=1\n");
  fixture.writeFile("plain.txt", "a\nb\n");
  fixture.run("git add .gitattributes app.env plain.txt");
  commitTick(fixture, "seed", 1);
  fixture.writeFile("app.env", "token=SECRET\nport=2\n");
  fixture.writeFile("plain.txt", "a\nB\n");
  const std::filesystem::path temp =
      fixture.root() / ".git" / std::filesystem::path(u8"t\u00ebmp-\u6e29");
  std::filesystem::create_directories(temp);

  InteractiveSession session;
  const std::string repoId = discoverRepo(session, fixture.root());
  {
    // Both paths that hand git a patch file: staging a filtered file's hunk
    // and unstaging any hunk.
    ScopedTempDir scoped(temp);
    Json hunks = fileHunks(session, 10, repoId, "app.env", false);
    ASSERT_EQ(hunks["result"]["hunks"].size(), 1u) << hunks.dump();
    Json stage = stageHunks(session, 11, repoId, "app.env", "stage",
                            Json::array({rangeOf(hunks["result"]["hunks"][0])}));
    ASSERT_TRUE(stage.contains("result")) << stage.dump();

    Json plain = fileHunks(session, 12, repoId, "plain.txt", false);
    ASSERT_EQ(plain["result"]["hunks"].size(), 1u) << plain.dump();
    Json stagePlain = stageHunks(session, 13, repoId, "plain.txt", "stage",
                                 Json::array({rangeOf(plain["result"]["hunks"][0])}));
    ASSERT_TRUE(stagePlain.contains("result")) << stagePlain.dump();
    Json staged = fileHunks(session, 14, repoId, "plain.txt", true);
    ASSERT_EQ(staged["result"]["hunks"].size(), 1u) << staged.dump();
    Json unstage = stageHunks(session, 15, repoId, "plain.txt", "unstage",
                              Json::array({rangeOf(staged["result"]["hunks"][0])}));
    ASSERT_TRUE(unstage.contains("result")) << unstage.dump();
  }
  EXPECT_EQ(gitOut(fixture.root(), "diff --cached --name-only"), "app.env\n");
}

TEST(StatusService, StageFilesSplitsLongPathLists) {
  FixtureRepo fixture;
  // Enough path bytes to need several git invocations on any platform.
  std::vector<std::string> paths;
  for (int i = 0; i < 300; ++i) {
    paths.push_back("batch/" + std::string(70, 'p') + "-" + std::to_string(i) + ".txt");
    fixture.writeFile(paths.back(), std::to_string(i) + "\n");
  }

  InteractiveSession session;
  const std::string repoId = discoverRepo(session, fixture.root());
  Json stage = stageFiles(session, 10, repoId, paths, "stage");
  ASSERT_TRUE(stage.contains("result")) << stage.dump();
  EXPECT_EQ(gg::testing::gitLines(fixture.root(), "diff --cached --name-only").size(),
            paths.size());
}

}  // namespace
}  // namespace gg
