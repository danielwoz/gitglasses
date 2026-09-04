// Regression tests for four ways a client or a hostile repository could crash
// or subvert the engine. Each of these was reproducible against the binary
// before the corresponding guard was added.

#include <gtest/gtest.h>
#include <nlohmann/json.hpp>

#include <sstream>
#include <string>

#include "exec/git_process.h"
#include "rpc/dispatcher.h"
#include "rpc/framing.h"
#include "server.h"
#include "test_fixtures.h"
#include "test_session.h"

namespace gg {
namespace {

using Json = nlohmann::json;
using gg::testing::FixtureRepo;
using gg::testing::initRequest;
using gg::testing::responseFor;
using gg::testing::runSession;

std::string frame(const std::string& payload) {
  return "Content-Length: " + std::to_string(payload.size()) + "\r\n\r\n" + payload;
}

// --- Invalid UTF-8 in an outbound message -----------------------------------
//
// nlohmann's default dump() throws type_error.316 on bytes that are not valid
// UTF-8. That call is reached from inside catch handlers, so the throw escaped
// and aborted the process. Git hands us such bytes routinely: hook output,
// refnames and remote URLs written by other tools.

TEST(Hardening, DumpForWireReplacesInvalidUtf8InsteadOfThrowing) {
  const std::string invalid = "bad byte: \xe9\xff caf\xe9";
  Json message = {{"jsonrpc", "2.0"}, {"error", {{"message", invalid}}}};

  std::string wire;
  ASSERT_NO_THROW(wire = rpc::dumpForWire(message));
  // dumpForWire uses ensure_ascii=false, so U+FFFD is emitted as its raw
  // UTF-8 bytes rather than a \ufffd escape.
  EXPECT_NE(wire.find("\xef\xbf\xbd"), std::string::npos)
      << "invalid sequences should become U+FFFD, got: " << wire;

  // The result must itself be parseable, or the client cannot read the error.
  EXPECT_FALSE(Json::parse(wire, nullptr, /*allow_exceptions=*/false).is_discarded());
}

TEST(Hardening, DumpForWireLeavesValidUtf8Alone) {
  Json message = {{"message", "café ☕"}};
  EXPECT_NE(rpc::dumpForWire(message).find("café ☕"), std::string::npos);
}

// --- Deeply nested JSON -----------------------------------------------------
//
// nlohmann's parser recurses once per level; ~20k levels overflowed the stack
// and segfaulted before any handler ran.

TEST(Hardening, DeeplyNestedPayloadIsRejectedNotParsed) {
  const int depth = rpc::kMaxParseDepth + 100;
  std::string body = R"({"jsonrpc":"2.0","id":1,"method":"initialize","params":)";
  body += std::string(depth, '[') + std::string(depth, ']') + "}";

  std::istringstream in(frame(body));
  std::ostringstream out;
  ASSERT_EQ(runServer(in, out), 0);

  const std::string response = out.str();
  EXPECT_NE(response.find("nesting too deep"), std::string::npos) << response;
}

TEST(Hardening, NestingWithinTheLimitStillParses) {
  // A depth the parser handles comfortably must not be rejected.
  std::string params = std::string(8, '[') + std::string(8, ']');
  std::string body =
      R"({"jsonrpc":"2.0","id":1,"method":"initialize","params":)" + params + "}";

  std::istringstream in(frame(body));
  std::ostringstream out;
  ASSERT_EQ(runServer(in, out), 0);
  EXPECT_EQ(out.str().find("nesting too deep"), std::string::npos) << out.str();
}

// --- Attacker-controlled Content-Length -------------------------------------
//
// The payload buffer was sized from the header before a single body byte was
// read, so a large value allocated gigabytes.

TEST(Hardening, OversizedContentLengthIsRefusedBeforeAllocating) {
  std::istringstream in("Content-Length: 999999999999\r\n\r\n");
  rpc::FrameReader reader(in);
  EXPECT_FALSE(reader.read().has_value());
}

TEST(Hardening, FrameAtTheLimitIsStillAccepted) {
  const std::string payload(1024, 'x');
  std::istringstream in(frame(payload));
  rpc::FrameReader reader(in);
  auto got = reader.read();
  ASSERT_TRUE(got.has_value());
  EXPECT_EQ(got->size(), payload.size());
}

// --- Argument injection into git argv ---------------------------------------
//
// Refnames, remotes and paths reach argv as positionals. A value beginning
// with '-' is parsed as an option wherever it appears, turning a data field
// into an arbitrary-command primitive (--upload-pack=) or a file write
// (--output=). Refnames come from the repository, so a hostile repo suffices.

TEST(Hardening, LooksLikeGitOptionIdentifiesLeadingDash) {
  EXPECT_TRUE(exec::looksLikeGitOption("--upload-pack=touch /tmp/x"));
  EXPECT_TRUE(exec::looksLikeGitOption("-c"));
  EXPECT_FALSE(exec::looksLikeGitOption("main"));
  EXPECT_FALSE(exec::looksLikeGitOption("feature/-dash-inside"));
  EXPECT_FALSE(exec::looksLikeGitOption(""));
}

TEST(Hardening, OptionLookingRemoteIsRejectedByFetch) {
  FixtureRepo fixture;
  auto messages = runSession({
      initRequest(),
      {{"jsonrpc", "2.0"},
       {"id", 2},
       {"method", "repo/discover"},
       {"params", {{"path", fixture.root().string()}}}},
      {{"jsonrpc", "2.0"},
       {"id", 3},
       {"method", "mutate/fetch"},
       {"params",
        {{"repoId", "r1"}, {"remote", "--upload-pack=touch /tmp/gg_should_not_exist"}}}},
  });

  const Json response = responseFor(messages, 3);
  ASSERT_TRUE(response.contains("error")) << response.dump();
  EXPECT_EQ(response["error"]["code"], static_cast<int>(ErrorCode::InvalidParams));
}

TEST(Hardening, OptionLookingRefIsRejectedBySwitch) {
  FixtureRepo fixture;
  auto messages = runSession({
      initRequest(),
      {{"jsonrpc", "2.0"},
       {"id", 2},
       {"method", "repo/discover"},
       {"params", {{"path", fixture.root().string()}}}},
      {{"jsonrpc", "2.0"},
       {"id", 3},
       {"method", "mutate/switch"},
       {"params", {{"repoId", "r1"}, {"ref", "--output=/tmp/gg_should_not_exist"}}}},
  });

  const Json response = responseFor(messages, 3);
  ASSERT_TRUE(response.contains("error")) << response.dump();
  EXPECT_EQ(response["error"]["code"], static_cast<int>(ErrorCode::InvalidParams));
}

}  // namespace
}  // namespace gg
