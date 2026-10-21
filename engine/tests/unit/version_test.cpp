// The engine ships inside the extension and reports that release's version:
// both --version and the initialize handshake must agree with the version in
// extension/package.json (injected via GG_EXTENSION_MANIFEST_PATH).

#include <gtest/gtest.h>
#include <nlohmann/json.hpp>

#include <fstream>
#include <string>

#include "test_session.h"
#include "version.h"

#ifndef GG_EXTENSION_MANIFEST_PATH
#error "GG_EXTENSION_MANIFEST_PATH must point at extension/package.json"
#endif

namespace gg {
namespace {

using Json = nlohmann::json;

std::string extensionVersion() {
  std::ifstream in(GG_EXTENSION_MANIFEST_PATH);
  EXPECT_TRUE(in.good()) << "cannot read " << GG_EXTENSION_MANIFEST_PATH;
  return Json::parse(in).at("version").get<std::string>();
}

TEST(Version, MatchesTheExtensionManifest) { EXPECT_EQ(std::string(kVersion), extensionVersion()); }

TEST(Version, InitializeReportsTheExtensionVersion) {
  auto messages = gg::testing::runSession({gg::testing::initRequest()});
  Json response = gg::testing::responseFor(messages, 1);
  EXPECT_EQ(response["result"]["engineVersion"], extensionVersion());
}

}  // namespace
}  // namespace gg
