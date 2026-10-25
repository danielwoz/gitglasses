// Restricted Mode end to end: an engine serving an untrusted repository runs
// none of the programs that repository's config, attributes or hooks name. It
// still serves blame and the libgit2-backed reads, and refuses everything that
// would run git or change the repository with the Restricted error.

#include <gtest/gtest.h>
#include <nlohmann/json.hpp>

#include <algorithm>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <string>
#include <utility>
#include <vector>

#include "test_fixtures.h"
#include "test_session.h"

namespace gg {
namespace {

using Json = nlohmann::json;
using gg::testing::FixtureRepo;
using gg::testing::InteractiveSession;
using gg::testing::ScopedRestrictedMode;

TEST(RestrictedMode, InitializeReportsRestrictedWithoutGitCli) {
  ScopedRestrictedMode restricted;
  InteractiveSession session;
  Json init = session.request(gg::testing::initRequest(1));
  ASSERT_TRUE(init.contains("result")) << init.dump();
  const Json caps = init["result"]["capabilities"];
  EXPECT_EQ(caps.value("restricted", false), true);
  EXPECT_EQ(caps.value("gitCli", true), false);
}

TEST(RestrictedMode, FullEngineReportsUnrestricted) {
  InteractiveSession session;
  Json init = session.request(gg::testing::initRequest(1));
  ASSERT_TRUE(init.contains("result")) << init.dump();
  EXPECT_EQ(init["result"]["capabilities"].value("restricted", true), false);
}

#ifndef _WIN32

constexpr int kRestricted = -32004;

Json req(std::int64_t id, const std::string& method, Json params) {
  return {{"jsonrpc", "2.0"}, {"id", id}, {"method", method}, {"params", std::move(params)}};
}

std::string readFile(const std::filesystem::path& path) {
  std::ifstream in(path, std::ios::binary);
  std::ostringstream buffer;
  buffer << in.rdbuf();
  return buffer.str();
}

// A repository whose config, attributes and hooks each name a command that
// drops a marker file when it runs: core.fsmonitor, a clean/smudge filter and
// a textconv driver applied to every path, and the hooks git runs around
// commits, checkouts, merges, rebases and pushes. Planted after the fixture's
// own commits, so setting it up runs none of them.
class PlantedRepo {
 public:
  PlantedRepo() {
    fixture_.writeFile("a.txt", "one\ntwo\n");
    fixture_.run("git add a.txt");
    fixture_.commit("add a");
    fixture_.run("git branch other");

    markers_ = fixture_.root().string() + "-markers";
    std::filesystem::create_directories(markers_);
    const std::string m = markers_.string();
    std::ofstream config(fixture_.root() / ".git" / "config", std::ios::app);
    config << "[core]\n\tfsmonitor = \"touch " << m << "/fsmonitor; false #\"\n"
           << "[filter \"planted\"]\n"
           << "\tclean = \"touch " << m << "/clean; cat\"\n"
           << "\tsmudge = \"touch " << m << "/smudge; cat\"\n"
           << "[diff \"planted\"]\n\ttextconv = \"touch " << m << "/textconv; cat\"\n";
    config.close();
    fixture_.writeFile(".gitattributes", "* filter=planted diff=planted\n");
    for (const char* hook : {"pre-commit", "commit-msg", "post-commit", "post-checkout",
                             "post-merge", "pre-rebase", "pre-push", "reference-transaction"}) {
      const std::filesystem::path path = fixture_.root() / ".git" / "hooks" / hook;
      std::filesystem::create_directories(path.parent_path());
      fixture_.writeFile(std::string(".git/hooks/") + hook,
                         "#!/bin/sh\ntouch " + m + "/hook-" + hook + "\n");
      std::filesystem::permissions(path, std::filesystem::perms::owner_all);
    }
  }

  ~PlantedRepo() {
    std::error_code ec;
    std::filesystem::remove_all(markers_, ec);
  }

  const std::filesystem::path& root() const { return fixture_.root(); }

  // Names of the markers the planted commands have dropped so far.
  std::vector<std::string> ran() const {
    std::vector<std::string> names;
    for (const auto& entry : std::filesystem::directory_iterator(markers_)) {
      names.push_back(entry.path().filename().string());
    }
    return names;
  }

 private:
  FixtureRepo fixture_;
  std::filesystem::path markers_;
};

// The commit main points at, read from the ref file so no git runs.
std::string headCommit(const std::filesystem::path& root) {
  std::string sha = readFile(root / ".git" / "refs" / "heads" / "main");
  while (!sha.empty() && (sha.back() == '\n' || sha.back() == '\r')) sha.pop_back();
  return sha;
}

std::string discover(InteractiveSession& session, const std::filesystem::path& root) {
  Json discovered = session.request(req(2, "repo/discover", {{"path", root.string()}}));
  EXPECT_TRUE(discovered.contains("result")) << discovered.dump();
  return discovered["result"].value("repoId", "");
}

// The control: an unrestricted engine runs the planted commands on an ordinary
// blame, so their absence below is the mode's doing.
TEST(RestrictedMode, PlantedCommandsRunInAFullEngine) {
  PlantedRepo planted;
  InteractiveSession session;
  session.request(gg::testing::initRequest(1));
  const std::string repoId = discover(session, planted.root());
  Json blame = session.request(
      req(3, "blame/file", {{"repoId", repoId}, {"path", "a.txt"}, {"streamId", "full"}}));
  ASSERT_TRUE(blame.contains("result")) << blame.dump();
  const std::vector<std::string> ran = planted.ran();
  EXPECT_NE(std::find(ran.begin(), ran.end(), "clean"), ran.end());
  EXPECT_NE(std::find(ran.begin(), ran.end(), "textconv"), ran.end());
}

TEST(RestrictedMode, ReadsRunNothingTheRepositoryConfigures) {
  PlantedRepo planted;
  ScopedRestrictedMode restricted;
  InteractiveSession session;
  session.request(gg::testing::initRequest(1));
  const std::string repoId = discover(session, planted.root());

  // Working-tree blame, the same with unsaved editor contents, and blame at a
  // revision: the three ways the extension asks for blame.
  Json clean = session.request(
      req(3, "blame/file", {{"repoId", repoId}, {"path", "a.txt"}, {"streamId", "clean"}}));
  ASSERT_TRUE(clean.contains("result")) << clean.dump();
  EXPECT_EQ(clean["result"].value("totalLines", 0), 2);
  EXPECT_FALSE(clean["result"].value("commits", Json::object()).empty());

  session.notify({{"jsonrpc", "2.0"},
                  {"method", "doc/didChange"},
                  {"params",
                   {{"repoId", repoId},
                    {"path", "a.txt"},
                    {"version", 2},
                    {"contents", "one\ntwo\nthree\n"}}}});
  Json dirty = session.request(
      req(4, "blame/file", {{"repoId", repoId}, {"path", "a.txt"}, {"streamId", "dirty"}}));
  ASSERT_TRUE(dirty.contains("result")) << dirty.dump();
  EXPECT_EQ(dirty["result"].value("totalLines", 0), 3);

  Json atRev = session.request(
      req(5, "blame/file",
          {{"repoId", repoId}, {"path", "a.txt"}, {"rev", "HEAD"}, {"streamId", "rev"}}));
  ASSERT_TRUE(atRev.contains("result")) << atRev.dump();

  const std::string head = headCommit(planted.root());
  const std::vector<std::pair<std::string, Json>> reads = {
      {"status/summary", {{"repoId", repoId}}},
      {"diff/fileHunks", {{"repoId", repoId}, {"path", "a.txt"}, {"staged", false}}},
      {"diff/commit", {{"repoId", repoId}, {"sha", "HEAD"}}},
      {"commit/details", {{"repoId", repoId}, {"sha", "HEAD"}}},
      {"commit/provenance", {{"repoId", repoId}, {"shas", {head}}}},
      {"notes/read", {{"repoId", repoId}, {"shas", {head}}}},
      {"graph/rows", {{"repoId", repoId}, {"limit", 10}}},
      {"graph/find", {{"repoId", repoId}, {"query", "a"}}},
      {"log/commits", {{"repoId", repoId}, {"limit", 10}}},
      {"log/compare", {{"repoId", repoId}, {"base", "HEAD"}, {"head", "HEAD"}}},
      {"rev/fileAtRev", {{"repoId", repoId}, {"path", "a.txt"}, {"rev", "HEAD"}}},
      {"refs/list", {{"repoId", repoId}}},
      {"repo/state", {{"repoId", repoId}}},
      {"worktree/list", {{"repoId", repoId}}},
      {"worktree/status", {{"repoId", repoId}, {"path", planted.root().string()}}},
  };
  std::int64_t id = 10;
  for (const auto& [method, params] : reads) {
    Json response = session.request(req(id++, method, params));
    EXPECT_TRUE(response.contains("result")) << method << ": " << response.dump();
  }

  EXPECT_TRUE(planted.ran().empty()) << "planted command ran: " << planted.ran().front();
}

TEST(RestrictedMode, RefusesWhatWouldRunGitOrChangeTheRepository) {
  PlantedRepo planted;
  const std::string indexBefore = readFile(planted.root() / ".git" / "index");
  const std::string headBefore = readFile(planted.root() / ".git" / "refs" / "heads" / "main");
  ScopedRestrictedMode restricted;
  InteractiveSession session;
  session.request(gg::testing::initRequest(1));
  const std::string repoId = discover(session, planted.root());

  const std::vector<std::pair<std::string, Json>> refused = {
      {"mutate/commit", {{"repoId", repoId}, {"message", "x"}}},
      {"mutate/switch", {{"repoId", repoId}, {"ref", "other"}}},
      {"mutate/merge", {{"repoId", repoId}, {"ref", "other"}}},
      {"mutate/reset", {{"repoId", repoId}, {"ref", "HEAD"}, {"mode", "hard"}}},
      {"mutate/fetch", {{"repoId", repoId}}},
      {"mutate/pull", {{"repoId", repoId}}},
      {"mutate/push", {{"repoId", repoId}}},
      {"stage/files", {{"repoId", repoId}, {"action", "stage"}, {"paths", {"a.txt"}}}},
      {"stage/hunks",
       {{"repoId", repoId}, {"path", "a.txt"}, {"action", "stage"}, {"hunks", Json::array()}}},
      {"stash/push", {{"repoId", repoId}}},
      {"worktree/add", {{"repoId", repoId}, {"path", "elsewhere"}, {"ref", "other"}}},
      {"rebase/preview", {{"repoId", repoId}, {"upstream", "other"}}},
      {"rebase/start", {{"repoId", repoId}, {"upstream", "other"}}},
      {"history/file", {{"repoId", repoId}, {"path", "a.txt"}}},
      {"history/line", {{"repoId", repoId}, {"path", "a.txt"}, {"startLine", 1}, {"endLine", 1}}},
      {"patch/create", {{"repoId", repoId}, {"source", {{"kind", "wip"}}}}},
      {"patch/apply", {{"repoId", repoId}, {"envelope", Json::object()}}},
      {"notes/addFetchRefspec", {{"repoId", repoId}, {"remote", "origin"}}},
  };
  std::int64_t id = 10;
  for (const auto& [method, params] : refused) {
    Json response = session.request(req(id++, method, params));
    ASSERT_TRUE(response.contains("error")) << method << ": " << response.dump();
    EXPECT_EQ(response["error"].value("code", 0), kRestricted) << method;
    EXPECT_NE(response["error"].value("message", "").find("Restricted Mode"), std::string::npos)
        << method;
  }

  EXPECT_TRUE(planted.ran().empty()) << "planted command ran: " << planted.ran().front();
  EXPECT_EQ(readFile(planted.root() / ".git" / "index"), indexBefore);
  EXPECT_EQ(readFile(planted.root() / ".git" / "refs" / "heads" / "main"), headBefore);
}

#endif  // !_WIN32

}  // namespace
}  // namespace gg
