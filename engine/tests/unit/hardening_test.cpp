// Tests for the guards that keep a client or a hostile repository from
// crashing or subverting the engine: outbound encoding, parse limits, frame
// sizing, git argv construction, param typing and temp-file handling.

#include <gtest/gtest.h>
#include <nlohmann/json.hpp>

#include <filesystem>
#include <sstream>
#include <string>

#include "exec/git_process.h"
#include "rpc/dispatcher.h"
#include "rpc/framing.h"
#include "server.h"
#include "util/temp_file.h"
#include "test_fixtures.h"
#include "test_session.h"

namespace gg {
namespace {

using Json = nlohmann::json;
using gg::testing::FixtureRepo;
using gg::testing::initRequest;
using gg::testing::InteractiveSession;
using gg::testing::responseFor;
using gg::testing::runSession;

std::string frame(const std::string& payload) {
  return "Content-Length: " + std::to_string(payload.size()) + "\r\n\r\n" + payload;
}

// --- Invalid UTF-8 in an outbound message -----------------------------------
//
// nlohmann's default dump() throws type_error.316 on bytes that are not valid
// UTF-8, and it is called from inside catch handlers, where a throw escapes to
// the thread entry. Git hands us such bytes routinely: hook output, refnames
// and remote URLs written by other tools.

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
// nlohmann's parser recurses once per level, so a payload of ~20k levels
// overflows the stack before any handler runs.

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
// The payload buffer is sized from the header before any body byte is read, so
// the header value is capped at kMaxFrameBytes first.

TEST(Hardening, OversizedContentLengthIsRefusedBeforeAllocating) {
  std::istringstream in("Content-Length: 999999999999\r\n\r\n");
  rpc::FrameReader reader(in);
  EXPECT_FALSE(reader.read().has_value());
}

TEST(Hardening, FrameWithinTheLimitIsAccepted) {
  const std::string payload(1024, 'x');
  std::istringstream in(frame(payload));
  rpc::FrameReader reader(in);
  auto got = reader.read();
  ASSERT_TRUE(got.has_value());
  EXPECT_EQ(got->size(), payload.size());
}

// --- Argument injection into git argv ---------------------------------------
//
// Values that reach argv as positionals are rejected when they begin with '-'
// (see exec::looksLikeGitOption), and the subcommands that accept one get a
// "--" separator.

TEST(Hardening, LooksLikeGitOptionIdentifiesLeadingDash) {
  EXPECT_TRUE(exec::looksLikeGitOption("--upload-pack=touch /tmp/x"));
  EXPECT_TRUE(exec::looksLikeGitOption("-c"));
  EXPECT_FALSE(exec::looksLikeGitOption("main"));
  EXPECT_FALSE(exec::looksLikeGitOption("feature/-dash-inside"));
  EXPECT_FALSE(exec::looksLikeGitOption(""));
}

TEST(Hardening, OptionLookingRemoteIsRejectedByFetch) {
  FixtureRepo fixture;
  // mutate/fetch runs on the network lane, so it is sent only after the
  // repo id it addresses exists.
  InteractiveSession session;
  session.request(initRequest());
  session.request({{"jsonrpc", "2.0"},
                   {"id", 2},
                   {"method", "repo/discover"},
                   {"params", {{"path", fixture.root().string()}}}});

  const Json response =
      session.request({{"jsonrpc", "2.0"},
                       {"id", 3},
                       {"method", "mutate/fetch"},
                       {"params",
                        {{"repoId", "r1"},
                         {"remote", "--upload-pack=touch /tmp/gg_should_not_exist"}}}});
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

// --- Param type errors ------------------------------------------------------
//
// nlohmann's value()/get<>() throw type_error on a wrong-typed field. The
// dispatcher catches it as InvalidParams and strips the library's
// "[json.exception...]" prefix, which tells a client nothing actionable.

TEST(Hardening, WronglyTypedParamIsInvalidParamsNotInternal) {
  auto messages = runSession({
      {{"jsonrpc", "2.0"},
       {"id", 1},
       {"method", "initialize"},
       {"params", {{"protocolVersion", 1}}}},
  });

  const Json response = responseFor(messages, 1);
  ASSERT_TRUE(response.contains("error")) << response.dump();
  EXPECT_EQ(response["error"]["code"], static_cast<int>(ErrorCode::InvalidParams));
  const std::string message = response["error"]["message"];
  EXPECT_EQ(message.find("json.exception"), std::string::npos)
      << "library noise should not reach the client: " << message;
  EXPECT_NE(message.find("must be string"), std::string::npos) << message;
}

// --- Temp files -------------------------------------------------------------
//
// Patch and blame-contents files hold the user's source in a world-readable
// shared directory. TempFile narrows their permissions before any content
// lands and removes them on every exit path, including cancellation.

TEST(Hardening, TempFileIsOwnerOnlyAndRemovedOnScopeExit) {
  std::string path;
  {
    auto file = util::TempFile::create("secret diff\n", "gg-test-", ".patch");
    ASSERT_TRUE(static_cast<bool>(file));
    path = file.value().path();

#ifndef _WIN32
    // POSIX only. Windows has no permission bits to narrow: its
    // std::filesystem maps only the read-only attribute and synthesizes the
    // rest as fully set, so asserting them would fail regardless of what the
    // code did. Access there is governed by ACLs, and %TEMP% is already
    // per-user, so the exposure this guards against does not arise.
    const auto perms = std::filesystem::status(path).permissions();
    EXPECT_EQ(perms & std::filesystem::perms::group_all, std::filesystem::perms::none);
    EXPECT_EQ(perms & std::filesystem::perms::others_all, std::filesystem::perms::none);
#endif
    EXPECT_TRUE(std::filesystem::exists(path));
  }
  EXPECT_FALSE(std::filesystem::exists(path)) << "temp file outlived its scope";
}

}  // namespace
}  // namespace gg
