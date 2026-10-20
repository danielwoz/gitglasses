// blame/file over a live session: which editor buffer a blame describes when
// the client pushes buffers through doc/didChange.

#include <gtest/gtest.h>

#include <cstdint>
#include <optional>
#include <string>

#include "test_fixtures.h"
#include "test_session.h"

namespace gg {
namespace {

using gg::testing::FixtureRepo;
using gg::testing::InteractiveSession;
using gg::testing::Json;

Json req(std::int64_t id, const std::string& method, Json params) {
  return {{"jsonrpc", "2.0"}, {"id", id}, {"method", method}, {"params", std::move(params)}};
}

Json note(const std::string& method, Json params) {
  return {{"jsonrpc", "2.0"}, {"method", method}, {"params", std::move(params)}};
}

struct BlameSessionTest : ::testing::Test {
  FixtureRepo fixture;
  InteractiveSession session;
  std::string repoId;
  std::int64_t nextId = 10;

  void open() {
    session.request(gg::testing::initRequest(1));
    Json discovered = session.request(req(2, "repo/discover", {{"path", fixture.root().string()}}));
    repoId = discovered["result"].value("repoId", "");
    ASSERT_FALSE(repoId.empty()) << discovered.dump();
  }

  void push(const std::string& path, const std::string& contents, std::int64_t version) {
    session.notify(
        note("doc/didChange",
             {{"repoId", repoId}, {"path", path}, {"contents", contents}, {"version", version}}));
  }

  Json blame(const std::string& path, std::optional<std::int64_t> docVersion) {
    Json params = {{"repoId", repoId}, {"path", path}, {"streamId", "s" + std::to_string(nextId)}};
    if (docVersion) params["docVersion"] = *docVersion;
    Json response = session.request(req(nextId++, "blame/file", std::move(params)));
    EXPECT_TRUE(response.contains("result")) << response.dump();
    return response.value("result", Json::object());
  }
};

std::string numberedLines(int count) {
  std::string text;
  for (int i = 0; i < count; ++i) {
    text +=
        "line " + std::to_string(i) + " of a file large enough to be parsed off the read loop\n";
  }
  return text;
}

// Each pushed buffer is the one the blame right behind it describes, also
// when the buffer is big enough to be parsed on a worker.
TEST_F(BlameSessionTest, BlamesTheBufferPushedAheadOfTheRequest) {
  const std::string base = numberedLines(20000);
  ASSERT_GT(base.size(), 1024u * 1024u);
  fixture.writeFile("big.txt", base);
  fixture.writeFile("small.txt", "one\ntwo\n");
  fixture.run("git add big.txt small.txt");
  fixture.commit("add files");
  open();

  for (const std::string path : {"big.txt", "small.txt"}) {
    const std::string committed = path == "big.txt" ? base : "one\ntwo\n";
    const int committedLines = path == "big.txt" ? 20000 : 2;
    std::string prefix;
    for (std::int64_t version = 1; version <= 6; ++version) {
      prefix += "inserted " + std::to_string(version) + "\n";
      push(path, prefix + committed, version);
      const Json result = blame(path, version);
      EXPECT_EQ(result.value("docVersion", std::int64_t{-2}), version) << path;
      EXPECT_EQ(result.value("totalLines", 0), committedLines + version) << path << " v" << version;
    }
  }
}

// docVersion -1 asks for the file on disk: a buffer pushed earlier (and not
// yet closed) must not stand in for it, while a request without docVersion
// keeps blaming the pushed buffer.
TEST_F(BlameSessionTest, DiskVersionIgnoresAPushedBuffer) {
  fixture.writeFile("notes.txt", "one\ntwo\n");
  fixture.run("git add notes.txt");
  fixture.commit("add notes");
  open();

  push("notes.txt", "zero\none\ntwo\n", 4);
  Json pushed = blame("notes.txt", std::nullopt);
  EXPECT_EQ(pushed.value("totalLines", 0), 3);
  EXPECT_EQ(pushed.value("docVersion", std::int64_t{-2}), 4);

  // Saved elsewhere with different contents; the pushed buffer is stale.
  fixture.writeFile("notes.txt", "one\ntwo\nthree\nfour\n");
  Json disk = blame("notes.txt", -1);
  EXPECT_EQ(disk.value("totalLines", 0), 4);
  EXPECT_EQ(disk.value("docVersion", std::int64_t{-2}), -1);

  // A version that never reached the engine is reported as such.
  Json missing = blame("notes.txt", 9);
  EXPECT_EQ(missing.value("docVersion", std::int64_t{-2}), 4);

  session.notify(note("doc/didClose", {{"repoId", repoId}, {"path", "notes.txt"}}));
  Json closed = blame("notes.txt", std::nullopt);
  EXPECT_EQ(closed.value("totalLines", 0), 4);
  EXPECT_EQ(closed.value("docVersion", std::int64_t{-2}), -1);
}

TEST_F(BlameSessionTest, ReportsLfsAndAcceptsOptions) {
  fixture.writeFile(".gitattributes", "*.csv filter=lfs diff=lfs merge=lfs -text\n");
  fixture.writeFile("data.csv",
                    "version https://git-lfs.github.com/spec/v1\n"
                    "oid sha256:1111111111111111111111111111111111111111111111111111111111111111\n"
                    "size 12\n");
  fixture.run("git add .gitattributes data.csv");
  fixture.commit("add data");
  open();

  Json params = {{"repoId", repoId},
                 {"path", "data.csv"},
                 {"streamId", "lfs"},
                 {"options", {{"ignoreWhitespace", true}, {"moves", "withinFile"}}}};
  Json response = session.request(req(50, "blame/file", params));
  ASSERT_TRUE(response.contains("result")) << response.dump();
  EXPECT_TRUE(response["result"].value("lfs", false));
  EXPECT_EQ(response["result"].value("totalLines", 0), 3);
}

}  // namespace
}  // namespace gg
