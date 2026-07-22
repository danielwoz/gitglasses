// Contract tests: the real engine's responses are validated against the JSON
// Schemas emitted by the TypeScript protocol package
// (packages/protocol/protocol.schema.json), so the two sides cannot drift
// apart silently. The artifact path is injected via GG_PROTOCOL_SCHEMA_PATH.

#include <gtest/gtest.h>
#include <nlohmann/json.hpp>

#include <fstream>
#include <regex>
#include <string>
#include <vector>

#include "test_fixtures.h"
#include "test_session.h"

#ifndef GG_PROTOCOL_SCHEMA_PATH
#error "GG_PROTOCOL_SCHEMA_PATH must point at packages/protocol/protocol.schema.json"
#endif

namespace gg {
namespace {

using Json = nlohmann::json;
using gg::testing::FixtureRepo;
using gg::testing::InteractiveSession;

// --- Focused JSON Schema validator -----------------------------------------
// Covers the subset TypeBox emits for this protocol: type, required,
// properties, additionalProperties (boolean or schema), patternProperties,
// enum, const, items, anyOf. Deliberately not a general draft-compliant
// validator; unknown keywords are ignored.

bool matchesType(const std::string& type, const Json& value) {
  if (type == "object") return value.is_object();
  if (type == "array") return value.is_array();
  if (type == "string") return value.is_string();
  if (type == "number") return value.is_number();
  if (type == "integer") return value.is_number_integer();
  if (type == "boolean") return value.is_boolean();
  if (type == "null") return value.is_null();
  return false;
}

void validate(const Json& schema, const Json& value, const std::string& path,
              std::vector<std::string>& errors) {
  if (schema.is_boolean()) {
    if (!schema.get<bool>()) errors.push_back(path + ": schema forbids any value");
    return;
  }
  if (!schema.is_object()) {
    errors.push_back(path + ": malformed schema " + schema.dump());
    return;
  }
  if (schema.contains("anyOf")) {
    for (const auto& option : schema["anyOf"]) {
      std::vector<std::string> optionErrors;
      validate(option, value, path, optionErrors);
      if (optionErrors.empty()) return;
    }
    errors.push_back(path + ": no anyOf variant matched " + value.dump());
    return;
  }
  if (schema.contains("const") && value != schema["const"]) {
    errors.push_back(path + ": expected const " + schema["const"].dump() + ", got " +
                     value.dump());
    return;
  }
  if (schema.contains("enum")) {
    bool found = false;
    for (const auto& candidate : schema["enum"]) found = found || candidate == value;
    if (!found) {
      errors.push_back(path + ": " + value.dump() + " not in enum " + schema["enum"].dump());
      return;
    }
  }
  if (schema.contains("type")) {
    const std::string type = schema["type"].get<std::string>();
    if (!matchesType(type, value)) {
      errors.push_back(path + ": expected type '" + type + "', got " + value.dump());
      return;
    }
  }
  if (value.is_object()) {
    for (const auto& required : schema.value("required", Json::array())) {
      if (!value.contains(required.get<std::string>())) {
        errors.push_back(path + ": missing required property '" +
                         required.get<std::string>() + "'");
      }
    }
    const Json properties = schema.value("properties", Json::object());
    const Json patternProperties = schema.value("patternProperties", Json::object());
    for (const auto& [key, member] : value.items()) {
      const std::string memberPath = path + "/" + key;
      if (properties.contains(key)) {
        validate(properties[key], member, memberPath, errors);
        continue;
      }
      bool matchedPattern = false;
      for (const auto& [pattern, subSchema] : patternProperties.items()) {
        if (std::regex_search(key, std::regex(pattern))) {
          validate(subSchema, member, memberPath, errors);
          matchedPattern = true;
        }
      }
      if (matchedPattern) continue;
      if (schema.contains("additionalProperties")) {
        const Json& additional = schema["additionalProperties"];
        if (additional.is_boolean() && !additional.get<bool>()) {
          errors.push_back(path + ": unexpected property '" + key + "'");
        } else if (additional.is_object()) {
          validate(additional, member, memberPath, errors);
        }
      }
    }
  }
  if (value.is_array() && schema.contains("items")) {
    for (size_t i = 0; i < value.size(); ++i) {
      validate(schema["items"], value[i], path + "/" + std::to_string(i), errors);
    }
  }
}

// --- Schema artifact access -------------------------------------------------

const Json& schemaDoc() {
  static const Json doc = [] {
    std::ifstream in(GG_PROTOCOL_SCHEMA_PATH);
    if (!in.good()) {
      ADD_FAILURE() << "cannot open schema artifact: " << GG_PROTOCOL_SCHEMA_PATH
                    << " (run `pnpm --filter @gitglasses/protocol build`)";
      return Json::object();
    }
    return Json::parse(in);
  }();
  return doc;
}

Json methodSchema(const std::string& method, const std::string& kind) {
  const Json& doc = schemaDoc();
  if (!doc.contains("methods") || !doc["methods"].contains(method)) {
    ADD_FAILURE() << "schema artifact has no method '" << method << "'";
    return Json::object();
  }
  return doc["methods"][method][kind];
}

Json notificationSchema(const std::string& method) {
  const Json& doc = schemaDoc();
  if (!doc.contains("notifications") || !doc["notifications"].contains(method)) {
    ADD_FAILURE() << "schema artifact has no notification '" << method << "'";
    return Json::object();
  }
  return doc["notifications"][method]["params"];
}

void expectValid(const Json& schema, const Json& value, const std::string& label) {
  std::vector<std::string> errors;
  validate(schema, value, label, errors);
  std::string joined;
  for (const auto& error : errors) joined += "  " + error + "\n";
  EXPECT_TRUE(errors.empty()) << "schema violations:\n"
                              << joined << "value: " << value.dump(2);
}

std::vector<std::string> errorsFor(const Json& schema, const Json& value) {
  std::vector<std::string> errors;
  validate(schema, value, "value", errors);
  return errors;
}

Json req(std::int64_t id, const std::string& method, Json params) {
  return {{"jsonrpc", "2.0"}, {"id", id}, {"method", method}, {"params", std::move(params)}};
}

// Sends the request, requires a result (not an error), validates both the
// params we sent and the result the engine produced against the artifact.
Json checkedRequest(InteractiveSession& session, std::int64_t id, const std::string& method,
                    Json params) {
  expectValid(methodSchema(method, "params"), params, method + ".params");
  Json response = session.request(req(id, method, std::move(params)));
  EXPECT_TRUE(response.contains("result")) << method << " failed: " << response.dump();
  if (!response.contains("result")) return Json::object();
  expectValid(methodSchema(method, "result"), response["result"], method + ".result");
  return response["result"];
}

// --- Tests -------------------------------------------------------------------

// The mini validator must actually reject violations, or the contract tests
// would pass vacuously.
TEST(ProtocolContract, ValidatorRejectsViolations) {
  const Json object = Json::parse(R"({
    "type": "object",
    "additionalProperties": false,
    "required": ["name", "count"],
    "properties": {
      "name": {"type": "string"},
      "count": {"type": "number"},
      "kind": {"anyOf": [{"const": "a", "type": "string"}, {"const": "b", "type": "string"}]},
      "tags": {"type": "array", "items": {"type": "string"}}
    }
  })");

  EXPECT_TRUE(errorsFor(object, Json{{"name", "x"}, {"count", 3}}).empty());
  EXPECT_FALSE(errorsFor(object, Json{{"name", "x"}}).empty()) << "missing required";
  EXPECT_FALSE(errorsFor(object, Json{{"name", 7}, {"count", 3}}).empty()) << "wrong type";
  EXPECT_FALSE(errorsFor(object, Json{{"name", "x"}, {"count", 3}, {"extra", 1}}).empty())
      << "additionalProperties";
  EXPECT_FALSE(errorsFor(object, Json{{"name", "x"}, {"count", 3}, {"kind", "c"}}).empty())
      << "anyOf/const";
  EXPECT_TRUE(errorsFor(object, Json{{"name", "x"}, {"count", 3}, {"kind", "b"}}).empty());
  EXPECT_FALSE(
      errorsFor(object, Json{{"name", "x"}, {"count", 3}, {"tags", Json::array({1})}}).empty())
      << "array items";

  const Json record = Json::parse(R"({
    "type": "object",
    "patternProperties": {"^(.*)$": {"type": "number"}}
  })");
  EXPECT_TRUE(errorsFor(record, Json{{"a", 1}, {"b", 2}}).empty());
  EXPECT_FALSE(errorsFor(record, Json{{"a", "no"}}).empty()) << "patternProperties";
}

// Drift guard: the engine's protocol version must equal the artifact's, and
// its initialize response must match the schema.
TEST(ProtocolContract, ProtocolVersionMatchesSchemaArtifact) {
  ASSERT_TRUE(schemaDoc().contains("protocolVersion"));
  const std::string artifactVersion = schemaDoc()["protocolVersion"].get<std::string>();

  InteractiveSession session;
  // Initializing with the artifact's version must succeed: the engine rejects
  // mismatched protocol versions.
  Json result =
      checkedRequest(session, 1, "initialize", {{"protocolVersion", artifactVersion}});
  EXPECT_EQ(result.value("protocolVersion", ""), artifactVersion);
}

// Drift guard: real responses from a live engine session validate against the
// schemas the TypeScript side was generated from.
TEST(ProtocolContract, EngineResponsesMatchSchemas) {
  FixtureRepo fixture;
  fixture.writeFile("src/main.txt", "one\ntwo\n");
  fixture.run("git add src/main.txt");
  fixture.commit("add main");
  fixture.run("git tag v1.0");
  fixture.run("git branch feature");
  // Dirty state so status/summary and the wip graph row have content.
  fixture.writeFile("src/main.txt", "one\ntwo\nthree\n");
  fixture.writeFile("staged.txt", "staged\n");
  fixture.run("git add staged.txt");
  fixture.writeFile("untracked.txt", "untracked\n");

  InteractiveSession session;
  const std::string version = schemaDoc().value("protocolVersion", "");
  checkedRequest(session, 1, "initialize", {{"protocolVersion", version}});

  Json discovered =
      checkedRequest(session, 2, "repo/discover", {{"path", fixture.root().string()}});
  ASSERT_TRUE(discovered.contains("repoId"));
  const std::string repoId = discovered["repoId"].get<std::string>();

  checkedRequest(session, 3, "repo/state", {{"repoId", repoId}});
  checkedRequest(session, 4, "status/summary", {{"repoId", repoId}});

  Json blame = checkedRequest(
      session, 5, "blame/file",
      {{"repoId", repoId}, {"path", "README.md"}, {"streamId", "contract-blame"}});
  EXPECT_FALSE(blame.value("commits", Json::object()).empty());

  // The blame stream's hunk notifications arrive before its response and are
  // collected by the session; validate them too.
  bool sawHunks = false;
  for (const auto& notification : session.notifications) {
    if (notification.value("method", "") != "blame/hunks") continue;
    sawHunks = true;
    expectValid(notificationSchema("blame/hunks"), notification["params"],
                "blame/hunks.params");
  }
  EXPECT_TRUE(sawHunks) << "expected at least one blame/hunks notification";

  Json graph = checkedRequest(session, 6, "graph/rows",
                              {{"repoId", repoId},
                               {"limit", 100},
                               {"include", {{"stashes", true}, {"wip", true}}}});
  EXPECT_FALSE(graph.value("rows", Json::array()).empty());

  Json refs = checkedRequest(session, 7, "refs/list", {{"repoId", repoId}});
  EXPECT_FALSE(refs.value("branches", Json::array()).empty());
  EXPECT_FALSE(refs.value("tags", Json::array()).empty());
}

}  // namespace
}  // namespace gg
