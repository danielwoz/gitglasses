// End-to-end tests: drive the full server loop (framing + dispatcher +
// registry) over in-memory streams, exactly as a client process would over
// stdio.

#include "server.h"

#include <gtest/gtest.h>
#include <nlohmann/json.hpp>

#include <sstream>
#include <vector>

#include "test_fixtures.h"

namespace gg {
namespace {

using Json = nlohmann::json;

std::string frame(const Json& message) {
  const std::string payload = message.dump();
  return "Content-Length: " + std::to_string(payload.size()) + "\r\n\r\n" + payload;
}

std::vector<Json> parseFrames(const std::string& output) {
  std::vector<Json> messages;
  size_t pos = 0;
  while ((pos = output.find("\r\n\r\n", pos)) != std::string::npos) {
    const size_t lengthPos = output.rfind("Content-Length:", pos);
    const size_t length = std::stoul(output.substr(lengthPos + 15, pos - lengthPos - 15));
    pos += 4;
    messages.push_back(Json::parse(output.substr(pos, length)));
    pos += length;
  }
  return messages;
}

Json responseFor(const std::vector<Json>& messages, std::int64_t id) {
  for (const auto& m : messages) {
    if (m.contains("id") && m["id"] == id) return m;
  }
  ADD_FAILURE() << "no response for id " << id;
  return {};
}

// Runs a full session: sends the given requests, closes stdin, returns all
// engine responses.
std::vector<Json> runSession(const std::vector<Json>& requests) {
  std::string input;
  for (const auto& r : requests) input += frame(r);
  std::istringstream in(input);
  std::ostringstream out;
  EXPECT_EQ(runServer(in, out), 0);
  return parseFrames(out.str());
}

Json initRequest(std::int64_t id = 1) {
  return {{"jsonrpc", "2.0"},
          {"id", id},
          {"method", "initialize"},
          {"params", {{"protocolVersion", "0.1.0"}}}};
}

TEST(Server, InitializeHandshake) {
  auto messages = runSession({initRequest()});
  Json response = responseFor(messages, 1);
  EXPECT_EQ(response["result"]["protocolVersion"], "0.1.0");
  EXPECT_TRUE(response["result"].contains("engineVersion"));
}

TEST(Server, InitializeRejectsProtocolMismatch) {
  auto messages = runSession({{{"jsonrpc", "2.0"},
                               {"id", 1},
                               {"method", "initialize"},
                               {"params", {{"protocolVersion", "99.0.0"}}}}});
  Json response = responseFor(messages, 1);
  EXPECT_EQ(response["error"]["code"], -32600);
}

TEST(Server, ExitsCleanlyOnStdinClose) {
  // No shutdown request: closing stdin alone must end the loop (exit code 0
  // asserted inside runSession).
  auto messages = runSession({initRequest()});
  EXPECT_FALSE(messages.empty());
}

TEST(Server, DiscoverListAndState) {
  gg::testing::FixtureRepo fixture;

  auto messages = runSession({
      initRequest(1),
      {{"jsonrpc", "2.0"},
       {"id", 2},
       {"method", "repo/discover"},
       {"params", {{"path", fixture.root().string()}}}},
      {{"jsonrpc", "2.0"}, {"id", 3}, {"method", "repo/list"}},
      {{"jsonrpc", "2.0"},
       {"id", 4},
       {"method", "repo/state"},
       {"params", {{"repoId", "r1"}}}},
      {{"jsonrpc", "2.0"}, {"id", 5}, {"method", "shutdown"}},
  });

  Json discover = responseFor(messages, 2);
  EXPECT_EQ(discover["result"]["repoId"], "r1");
  EXPECT_EQ(discover["result"]["bare"], false);

  Json list = responseFor(messages, 3);
  EXPECT_EQ(list["result"]["repos"].size(), 1u);

  Json state = responseFor(messages, 4);
  EXPECT_EQ(state["result"]["head"]["branch"], "main");
  EXPECT_EQ(state["result"]["head"]["oid"].get<std::string>().size(), 40u);
  EXPECT_EQ(state["result"]["head"]["unborn"], false);
}

TEST(Server, DiscoverOutsideRepoReturnsError) {
  auto messages = runSession({
      initRequest(1),
      {{"jsonrpc", "2.0"},
       {"id", 2},
       {"method", "repo/discover"},
       {"params", {{"path", std::filesystem::temp_directory_path().string()}}}},
  });
  Json response = responseFor(messages, 2);
  EXPECT_EQ(response["error"]["code"], -32000);
}

}  // namespace
}  // namespace gg
