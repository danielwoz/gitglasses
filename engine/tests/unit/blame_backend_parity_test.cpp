// Parity tests between the CLI (`git blame --incremental`) and libgit2 blame
// backends. Line -> sha attribution must be identical on rename-free
// histories (linear edits, multi-commit files, uncommitted lines, rev blame).
// The one documented tolerance is rename-boundary attribution: libgit2
// follows clean whole-file renames (and matches the CLI on this fixture),
// but its similarity-based pairing may attribute rename+edit or copy cases
// to the renaming commit instead of the true origin, which is accepted.

#include "services/blame/blame_service.h"

#include <git2.h>
#include <gtest/gtest.h>

#include <filesystem>
#include <map>
#include <optional>
#include <set>
#include <string>
#include <vector>

#include "core/git2.h"
#include "test_fixtures.h"

namespace gg::services {
namespace {

using LineMap = std::map<std::uint32_t, std::string>;

struct BlameBackendParityTest : ::testing::Test {
  core::LibGit2 libgit2;
  gg::testing::FixtureRepo fixture;
  cache::BlameCache blameCache;
  BlameService service{blameCache};

  Result<BlameSummary> blame(BlameRequest request, BlameBackend backend,
                             std::vector<exec::BlameHunk>* hunks) {
    request.forceBackend = backend;
    auto repo = core::Repo::open(fixture.root().string());
    EXPECT_TRUE(repo.ok());
    return service.blame(repo.value(), request, CancelToken(), [&](const exec::BlameHunk& h) {
      if (hunks) hunks->push_back(h);
    });
  }

  LineMap attribution(const BlameRequest& request, BlameBackend backend) {
    std::vector<exec::BlameHunk> hunks;
    auto summary = blame(request, backend, &hunks);
    EXPECT_TRUE(summary.ok()) << (summary.ok() ? "" : summary.error().message);
    LineMap lines;
    for (const auto& h : hunks) {
      for (std::uint32_t l = h.resultLine; l < h.resultLine + h.lineCount; ++l) {
        lines[l] = h.sha;
      }
    }
    return lines;
  }

  std::string revSha(const std::string& rev) {
    auto repo = core::Repo::open(fixture.root().string());
    EXPECT_TRUE(repo.ok());
    git_object* obj = nullptr;
    EXPECT_EQ(git_revparse_single(&obj, repo.value().raw(), rev.c_str()), 0);
    char hex[GIT_OID_HEXSZ + 1] = {};
    git_oid_fmt(hex, git_object_id(obj));
    git_object_free(obj);
    return hex;
  }

  void commitFile(const std::string& contents, const std::string& message) {
    fixture.writeFile("file.txt", contents);
    fixture.run("git add file.txt");
    fixture.commit(message);
  }
};

TEST_F(BlameBackendParityTest, LinearEditsMatch) {
  commitFile("a1\na2\na3\na4\n", "c1");
  commitFile("a1\nb2\na3\na4\n", "c2");
  commitFile("a1\nb2\na3\nc4\n", "c3");

  const LineMap cli = attribution({.path = "file.txt"}, BlameBackend::Cli);
  const LineMap lg2 = attribution({.path = "file.txt"}, BlameBackend::LibGit2);
  EXPECT_EQ(cli, lg2);

  std::set<std::string> shas;
  for (const auto& [line, sha] : cli) shas.insert(sha);
  EXPECT_EQ(shas.size(), 3u);  // the three edits attribute distinctly
}

TEST_F(BlameBackendParityTest, MultiCommitInsertionsAndDeletionsMatch) {
  commitFile("one\ntwo\nthree\n", "base");
  commitFile("one\ninserted\ntwo\nthree\n", "insert middle");
  commitFile("one\ninserted\nthree\nfour\nfive\n", "delete and append");

  const LineMap cli = attribution({.path = "file.txt"}, BlameBackend::Cli);
  const LineMap lg2 = attribution({.path = "file.txt"}, BlameBackend::LibGit2);
  ASSERT_EQ(cli.size(), 5u);
  EXPECT_EQ(cli, lg2);
}

TEST_F(BlameBackendParityTest, UncommittedLinesMatch) {
  commitFile("one\ntwo\n", "base");
  fixture.writeFile("file.txt", "one\ntwo\nnew line\n");  // dirty, not committed

  const LineMap cli = attribution({.path = "file.txt"}, BlameBackend::Cli);
  const LineMap lg2 = attribution({.path = "file.txt"}, BlameBackend::LibGit2);
  EXPECT_EQ(cli, lg2);
  ASSERT_EQ(lg2.count(3), 1u);
  EXPECT_EQ(lg2.at(3), exec::kUncommittedSha);
  EXPECT_NE(lg2.at(1), exec::kUncommittedSha);
}

TEST_F(BlameBackendParityTest, RevBlameMatches) {
  commitFile("one\ntwo\n", "first");
  commitFile("one\ntwo changed\n", "second");
  commitFile("one changed\ntwo changed\n", "third");

  const BlameRequest request{.path = "file.txt", .rev = std::string("HEAD~1")};
  const LineMap cli = attribution(request, BlameBackend::Cli);
  const LineMap lg2 = attribution(request, BlameBackend::LibGit2);
  ASSERT_EQ(cli.size(), 2u);
  EXPECT_EQ(cli, lg2);
  for (const auto& [line, sha] : lg2) EXPECT_NE(sha, exec::kUncommittedSha);
  // At HEAD~1 line 1 still belongs to "first".
  EXPECT_EQ(lg2.at(1), revSha("HEAD~2"));
  EXPECT_EQ(lg2.at(2), revSha("HEAD~1"));
}

// Dirty-buffer blame through git_blame_buffer: the buffer's extra line is
// uncommitted, everything else keeps its committed attribution, matching the
// CLI's `--contents` behaviour.
TEST_F(BlameBackendParityTest, DirtyBufferMatchesAndAttributesUncommitted) {
  commitFile("one\ntwo\nthree\n", "base");

  const BlameRequest request{.path = "file.txt",
                             .contents = std::string("one\ntwo\nunsaved\nthree\n")};
  const LineMap cli = attribution(request, BlameBackend::Cli);
  const LineMap lg2 = attribution(request, BlameBackend::LibGit2);
  EXPECT_EQ(cli, lg2);
  ASSERT_EQ(lg2.size(), 4u);
  EXPECT_EQ(lg2.at(3), exec::kUncommittedSha);
  EXPECT_NE(lg2.at(1), exec::kUncommittedSha);
  EXPECT_NE(lg2.at(4), exec::kUncommittedSha);
}

TEST_F(BlameBackendParityTest, RenameAttributionWithinDocumentedTolerance) {
  commitFile("l1\nl2\nl3\n", "create");
  commitFile("l1\nl2 edited\nl3\n", "edit before rename");
  fixture.run("git mv file.txt moved.txt");
  fixture.commit("rename");
  fixture.writeFile("moved.txt", "l1\nl2 edited\nl3 edited\n");
  fixture.run("git add moved.txt");
  fixture.commit("edit after rename");

  const std::string renameSha = revSha("HEAD~1");
  const std::string afterRenameSha = revSha("HEAD");
  const LineMap cli = attribution({.path = "moved.txt"}, BlameBackend::Cli);
  const LineMap lg2 = attribution({.path = "moved.txt"}, BlameBackend::LibGit2);
  ASSERT_EQ(cli.size(), 3u);
  ASSERT_EQ(lg2.size(), 3u);

  // The CLI follows the whole-file rename: pre-rename lines keep their
  // original commits.
  EXPECT_EQ(cli.at(1), revSha("HEAD~3"));
  EXPECT_EQ(cli.at(2), revSha("HEAD~2"));
  EXPECT_EQ(cli.at(3), afterRenameSha);

  // Lines touched after the rename must attribute identically in both
  // backends; pre-rename lines may fall back to the renaming commit under
  // libgit2 (documented rename-boundary tolerance), but nothing else.
  EXPECT_EQ(lg2.at(3), afterRenameSha);
  for (const auto& [line, sha] : lg2) {
    EXPECT_TRUE(sha == cli.at(line) || sha == renameSha)
        << "line " << line << " attributed to " << sha << " (cli: " << cli.at(line)
        << ", rename commit: " << renameSha << ")";
  }
}

// The cache key carries a backend marker, so a result computed by one backend
// is never replayed for the other.
TEST_F(BlameBackendParityTest, CacheEntriesDoNotCrossBackends) {
  commitFile("one\ntwo\n", "base");

  auto cliFirst = blame({.path = "file.txt"}, BlameBackend::Cli, nullptr);
  ASSERT_TRUE(cliFirst.ok()) << cliFirst.error().message;
  EXPECT_FALSE(cliFirst.value().fromCache);

  auto cliSecond = blame({.path = "file.txt"}, BlameBackend::Cli, nullptr);
  ASSERT_TRUE(cliSecond.ok());
  EXPECT_TRUE(cliSecond.value().fromCache);

  // Same file, same OIDs — but the CLI-cached entry must not serve libgit2.
  auto lg2First = blame({.path = "file.txt"}, BlameBackend::LibGit2, nullptr);
  ASSERT_TRUE(lg2First.ok()) << lg2First.error().message;
  EXPECT_FALSE(lg2First.value().fromCache);

  auto lg2Second = blame({.path = "file.txt"}, BlameBackend::LibGit2, nullptr);
  ASSERT_TRUE(lg2Second.ok());
  EXPECT_TRUE(lg2Second.value().fromCache);
}

// Two files with the same contents in the same commit share a blob but not a
// history: each must be blamed for its own, whichever is asked first.
TEST_F(BlameBackendParityTest, IdenticalFilesKeepTheirOwnHistory) {
  fixture.writeFile("a.txt", "same\ncontent\n");
  fixture.run("git add a.txt");
  fixture.run("git -c user.name=Alice -c user.email=alice@example.invalid commit -q -m \"add a\"");
  fixture.writeFile("b.txt", "same\ncontent\n");
  fixture.run("git add b.txt");
  fixture.run("git -c user.name=Bob -c user.email=bob@example.invalid commit -q -m \"add b\"");

  const std::vector<std::optional<std::string>> revs = {std::nullopt, std::string("HEAD")};
  for (const BlameBackend backend : {BlameBackend::Cli, BlameBackend::LibGit2}) {
    for (const auto& order :
         {std::vector<std::string>{"a.txt", "b.txt"}, std::vector<std::string>{"b.txt", "a.txt"}}) {
      for (const auto& rev : revs) {
        cache::BlameCache freshCache;
        BlameService fresh{freshCache};
        for (const std::string& path : order) {
          BlameRequest request{.path = path, .rev = rev};
          request.forceBackend = backend;
          std::vector<exec::BlameHunk> hunks;
          auto repo = core::Repo::open(fixture.root().string());
          ASSERT_TRUE(repo.ok());
          auto summary = fresh.blame(repo.value(), request, CancelToken(),
                                     [&](const exec::BlameHunk& h) { hunks.push_back(h); });
          ASSERT_TRUE(summary.ok()) << summary.error().message;
          EXPECT_FALSE(summary.value().fromCache) << path;
          const std::string expected = path == "a.txt" ? "Alice" : "Bob";
          for (const auto& [sha, commit] : summary.value().result->commits) {
            EXPECT_EQ(commit.author.name, expected) << path;
          }
          for (const auto& h : hunks) EXPECT_EQ(h.path, path);
        }
      }
    }
  }
}

// Both backends map names through .mailmap, as `git blame` does, and an edit
// to it is not hidden by the cache.
TEST_F(BlameBackendParityTest, MailmapAppliesToBothBackends) {
  commitFile("one\ntwo\n", "base");
  fixture.writeFile(".mailmap",
                    "Canonical Name <canonical@example.invalid> <fixture@example.invalid>\n");
  for (const BlameBackend backend : {BlameBackend::Cli, BlameBackend::LibGit2}) {
    auto summary = blame({.path = "file.txt"}, backend, nullptr);
    ASSERT_TRUE(summary.ok()) << summary.error().message;
    for (const auto& [sha, commit] : summary.value().result->commits) {
      EXPECT_EQ(commit.author.name, "Canonical Name");
      EXPECT_EQ(commit.author.email, "canonical@example.invalid");
    }
  }

  fixture.writeFile(".mailmap", "");
  for (const BlameBackend backend : {BlameBackend::Cli, BlameBackend::LibGit2}) {
    auto summary = blame({.path = "file.txt"}, backend, nullptr);
    ASSERT_TRUE(summary.ok()) << summary.error().message;
    EXPECT_FALSE(summary.value().fromCache);
    for (const auto& [sha, commit] : summary.value().result->commits) {
      EXPECT_EQ(commit.author.name, "Fixture");
    }
  }
}

TEST_F(BlameBackendParityTest, IgnoreWhitespaceMatches) {
  commitFile("a b\nc d\n", "write");
  commitFile("a  b\nc d\n", "respace");
  BlameRequest request{.path = "file.txt"};
  request.options.ignoreWhitespace = true;
  const LineMap cli = attribution(request, BlameBackend::Cli);
  const LineMap lg2 = attribution(request, BlameBackend::LibGit2);
  EXPECT_EQ(cli, lg2);
  ASSERT_EQ(lg2.size(), 2u);
  EXPECT_EQ(lg2.at(1), revSha("HEAD~1"));
}

// A clean CRLF checkout of LF blobs (core.autocrlf) is committed content, for
// the in-process backend as much as for git.
TEST_F(BlameBackendParityTest, CrlfCheckoutIsNotUncommitted) {
  commitFile("one\ntwo\nthree\n", "base");
  fixture.run("git config core.autocrlf true");
  std::filesystem::remove(fixture.root() / "file.txt");
  fixture.run("git checkout -- file.txt");
  ASSERT_EQ(gg::testing::gitCapture(fixture.root(), "status --porcelain"), "");

  const LineMap cli = attribution({.path = "file.txt"}, BlameBackend::Cli);
  const LineMap lg2 = attribution({.path = "file.txt"}, BlameBackend::LibGit2);
  EXPECT_EQ(cli, lg2);
  ASSERT_EQ(lg2.size(), 3u);
  for (const auto& [line, sha] : lg2) EXPECT_EQ(sha, revSha("HEAD")) << "line " << line;

  // An editor buffer keeps the CRLF endings too.
  const BlameRequest dirty{.path = "file.txt",
                           .contents = std::string("one\r\ntwo\r\nadded\r\nthree\r\n")};
  const LineMap dirtyCli = attribution(dirty, BlameBackend::Cli);
  const LineMap dirtyLg2 = attribution(dirty, BlameBackend::LibGit2);
  EXPECT_EQ(dirtyCli, dirtyLg2);
  ASSERT_EQ(dirtyLg2.size(), 4u);
  EXPECT_EQ(dirtyLg2.at(1), revSha("HEAD"));
  EXPECT_EQ(dirtyLg2.at(3), exec::kUncommittedSha);
}

// A line's previous revision is the parent the commit changed it from, when
// the file was there. Lines from the commit that added the file, root commit
// or not, have none: there is no earlier version to open or diff against.
TEST_F(BlameBackendParityTest, PreviousRevisionMatchesTheCli) {
  commitFile("one\ntwo\n", "root");
  const std::string root = revSha("HEAD");
  commitFile("one\ntwo changed\n", "change");
  fixture.writeFile("added.txt", "new\n");
  fixture.run("git add added.txt");
  fixture.commit("add a file");

  using Previous = std::map<std::uint32_t, std::optional<std::string>>;
  const auto previousOf = [&](const std::string& path, BlameBackend backend) {
    std::vector<exec::BlameHunk> hunks;
    auto summary = blame({.path = path}, backend, &hunks);
    EXPECT_TRUE(summary.ok()) << (summary.ok() ? "" : summary.error().message);
    Previous lines;
    for (const auto& h : hunks) {
      EXPECT_EQ(h.previousSha.has_value(), h.previousPath.has_value());
      if (h.previousPath) {
        EXPECT_EQ(*h.previousPath, path);
      }
      for (std::uint32_t l = h.resultLine; l < h.resultLine + h.lineCount; ++l) {
        lines[l] = h.previousSha;
      }
    }
    return lines;
  };

  for (const BlameBackend backend : {BlameBackend::Cli, BlameBackend::LibGit2}) {
    const Previous file = previousOf("file.txt", backend);
    ASSERT_EQ(file.size(), 2u);
    EXPECT_EQ(file.at(1), std::nullopt);  // the root commit's line
    EXPECT_EQ(file.at(2), std::optional<std::string>(root));
    const Previous added = previousOf("added.txt", backend);
    ASSERT_EQ(added.size(), 1u);
    EXPECT_EQ(added.at(1), std::nullopt);
  }
}

}  // namespace
}  // namespace gg::services
