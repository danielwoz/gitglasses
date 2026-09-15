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

#include "util/result.h"

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
// enum, const, items, anyOf, and the value constraints (minimum, maximum,
// minLength, minItems, pattern). Deliberately not a general draft-compliant
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
  if (value.is_array()) {
    if (schema.contains("items")) {
      for (size_t i = 0; i < value.size(); ++i) {
        validate(schema["items"], value[i], path + "/" + std::to_string(i), errors);
      }
    }
    if (schema.contains("minItems") && value.size() < schema["minItems"].get<size_t>()) {
      errors.push_back(path + ": needs at least " + schema["minItems"].dump() + " items");
    }
  }
  if (value.is_string()) {
    const std::string text = value.get<std::string>();
    if (schema.contains("minLength") && text.size() < schema["minLength"].get<size_t>()) {
      errors.push_back(path + ": shorter than minLength " + schema["minLength"].dump());
    }
    if (schema.contains("maxLength") && text.size() > schema["maxLength"].get<size_t>()) {
      errors.push_back(path + ": longer than maxLength " + schema["maxLength"].dump());
    }
    if (schema.contains("pattern") &&
        !std::regex_search(text, std::regex(schema["pattern"].get<std::string>()))) {
      errors.push_back(path + ": " + value.dump() + " does not match " +
                       schema["pattern"].dump());
    }
  }
  if (value.is_number()) {
    const double number = value.get<double>();
    if (schema.contains("minimum") && number < schema["minimum"].get<double>()) {
      errors.push_back(path + ": below minimum " + schema["minimum"].dump());
    }
    if (schema.contains("maximum") && number > schema["maximum"].get<double>()) {
      errors.push_back(path + ": above maximum " + schema["maximum"].dump());
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

// The opposite direction: sends params the schema forbids and requires the
// engine to refuse them with InvalidParams. checkedRequest only validates what
// it sends, so it cannot catch the engine accepting input the schema rules
// out; without this a constraint could be added to the schema that nothing
// enforces.
void rejectedRequest(InteractiveSession& session, std::int64_t id, const std::string& method,
                     Json params, const std::string& what) {
  const Json schema = methodSchema(method, "params");
  ASSERT_FALSE(errorsFor(schema, params).empty())
      << what << ": the schema accepts these params, so the case proves nothing: "
      << params.dump();
  const Json response = session.request(req(id, method, std::move(params)));
  ASSERT_TRUE(response.contains("error"))
      << what << ": engine accepted params the schema forbids: " << response.dump();
  EXPECT_EQ(response["error"]["code"], static_cast<int>(ErrorCode::InvalidParams))
      << what << ": " << response["error"].dump();
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

  // The value constraints this protocol relies on: without these the negative
  // contract cases below would send schema-valid params and prove nothing.
  const Json bounded = Json::parse(R"({"type": "integer", "minimum": 1, "maximum": 10})");
  EXPECT_TRUE(errorsFor(bounded, Json(5)).empty());
  EXPECT_FALSE(errorsFor(bounded, Json(0)).empty()) << "minimum";
  EXPECT_FALSE(errorsFor(bounded, Json(11)).empty()) << "maximum";
  EXPECT_FALSE(errorsFor(bounded, Json(1.5)).empty()) << "integer";

  const Json text = Json::parse(R"({"type": "string", "minLength": 1, "pattern": "^[^-]"})");
  EXPECT_TRUE(errorsFor(text, Json("main")).empty());
  EXPECT_FALSE(errorsFor(text, Json("")).empty()) << "minLength";
  EXPECT_FALSE(errorsFor(text, Json("--force")).empty()) << "pattern";

  const Json list = Json::parse(R"({"type": "array", "minItems": 1})");
  EXPECT_TRUE(errorsFor(list, Json::array({1})).empty());
  EXPECT_FALSE(errorsFor(list, Json::array()).empty()) << "minItems";
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

  Json log = checkedRequest(session, 8, "log/commits", {{"repoId", repoId}});
  EXPECT_FALSE(log.value("commits", Json::array()).empty());
  checkedRequest(session, 9, "history/file",
                 {{"repoId", repoId}, {"path", "src/main.txt"}, {"limit", 10}});
  checkedRequest(session, 10, "history/line",
                 {{"repoId", repoId}, {"path", "src/main.txt"}, {"startLine", 1},
                  {"endLine", 2}});
  checkedRequest(session, 11, "diff/commit",
                 {{"repoId", repoId}, {"sha", log["commits"][0]["sha"]}});
  checkedRequest(session, 12, "diff/refs",
                 {{"repoId", repoId}, {"base", "feature"}, {"head", "main"}});
  Json hunks = checkedRequest(session, 13, "diff/fileHunks",
                              {{"repoId", repoId}, {"path", "src/main.txt"}});
  EXPECT_FALSE(hunks.value("hunks", Json::array()).empty());
  checkedRequest(session, 14, "stash/list", {{"repoId", repoId}});
  checkedRequest(session, 15, "worktree/list", {{"repoId", repoId}});
  checkedRequest(session, 16, "remote/list", {{"repoId", repoId}});
  checkedRequest(session, 17, "repo/list", Json::object());
  checkedRequest(session, 18, "rebase/preview", {{"repoId", repoId}, {"upstream", "feature"}});

  Json search = checkedRequest(
      session, 19, "search/commits",
      {{"repoId", repoId}, {"streamId", "contract-search"}, {"query", {{"text", "main"}}}});
  EXPECT_GE(search.value("total", 0), 1);

  Json file = checkedRequest(session, 20, "rev/fileAtRev",
                             {{"repoId", repoId}, {"path", "src/main.txt"}, {"rev", "HEAD"}});
  EXPECT_EQ(file.value("contents", ""), "one\ntwo\n");
  EXPECT_FALSE(file.value("truncated", true));
  EXPECT_FALSE(file.value("binary", true));

  checkedRequest(session, 21, "patch/create",
                 {{"repoId", repoId}, {"source", {{"kind", "wip"}}}});
}

// The engine must refuse what the schema forbids. Every case here is params
// the validator above rejects; the engine has to reject them too, or the
// constraint exists only on paper.
TEST(ProtocolContract, EngineRejectsParamsTheSchemaForbids) {
  FixtureRepo fixture;
  fixture.writeFile("src/main.txt", "one\ntwo\n");
  fixture.run("git add src/main.txt");
  fixture.commit("add main");

  InteractiveSession session;
  checkedRequest(session, 1, "initialize",
                 {{"protocolVersion", schemaDoc().value("protocolVersion", "")}});
  Json discovered =
      checkedRequest(session, 2, "repo/discover", {{"path", fixture.root().string()}});
  ASSERT_TRUE(discovered.contains("repoId"));
  const std::string repoId = discovered["repoId"].get<std::string>();

  std::int64_t id = 100;
  const auto reject = [&](const std::string& method, Json params, const std::string& what) {
    rejectedRequest(session, ++id, method, std::move(params), what);
  };

  // Empty arrays where the engine needs at least one element.
  reject("mutate/cherryPick", {{"repoId", repoId}, {"shas", Json::array()}}, "empty shas");
  reject("stage/files", {{"repoId", repoId}, {"action", "stage"}, {"paths", Json::array()}},
         "empty paths");
  reject("stage/hunks",
         {{"repoId", repoId}, {"path", "src/main.txt"}, {"action", "stage"},
          {"hunks", Json::array()}},
         "empty hunks");

  // Page sizes outside [1, MAX_LIMIT], and non-integers that would truncate.
  reject("log/commits", {{"repoId", repoId}, {"limit", 0}}, "zero limit");
  reject("log/commits", {{"repoId", repoId}, {"limit", -5}}, "negative limit");
  reject("log/commits", {{"repoId", repoId}, {"limit", 1.5}}, "fractional limit");
  reject("graph/rows", {{"repoId", repoId}, {"limit", 100001}}, "limit above the ceiling");

  // Line numbers and indices are 1- and 0-based integers.
  reject("history/line",
         {{"repoId", repoId}, {"path", "src/main.txt"}, {"startLine", 0}, {"endLine", 2}},
         "startLine below 1");
  reject("history/line",
         {{"repoId", repoId}, {"path", "src/main.txt"}, {"startLine", 1.5}, {"endLine", 2}},
         "fractional startLine");
  reject("stash/apply", {{"repoId", repoId}, {"index", -1}, {"pop", false}},
         "negative stash index");
  reject("patch/create", {{"repoId", repoId}, {"source", {{"kind", "stash"}, {"index", -1}}}},
         "negative source stash index");
  reject("stage/hunks",
         {{"repoId", repoId},
          {"path", "src/main.txt"},
          {"action", "stage"},
          {"hunks", Json::array({{{"oldStart", -1}, {"oldLines", 1}, {"newStart", 1},
                                  {"newLines", 1}}})}},
         "negative hunk offset");

  // Values that git would parse as options if they reached its argv.
  reject("mutate/branchCreate", {{"repoId", repoId}, {"name", "--force"}}, "option-like name");
  reject("mutate/branchCreate",
         {{"repoId", repoId}, {"name", "ok"}, {"startPoint", "-x"}}, "option-like startPoint");
  reject("mutate/reset", {{"repoId", repoId}, {"ref", "-x"}, {"mode", "soft"}},
         "option-like ref");
  reject("mutate/revert", {{"repoId", repoId}, {"shas", Json::array({"-x"})}},
         "option-like sha");
  reject("rebase/preview", {{"repoId", repoId}, {"upstream", "--output=/dev/null"}},
         "option-like rebase upstream");
  reject("rebase/start",
         {{"repoId", repoId}, {"upstream", "--output=/dev/null"}, {"plan", Json::array()}},
         "option-like rebase upstream");
  reject("worktree/add",
         {{"repoId", repoId}, {"path", "/tmp/gg-contract-wt"}, {"ref", "HEAD"},
          {"createBranch", "-x"}},
         "option-like createBranch");

  // Empty strings never stand in for an omitted value.
  reject("mutate/fetch", {{"repoId", repoId}, {"remote", ""}}, "empty remote");
  reject("stash/push", {{"repoId", repoId}, {"message", ""}}, "empty stash message");
  reject("patch/create",
         {{"repoId", repoId}, {"source", {{"kind", "wip"}}}, {"summary", ""}},
         "empty patch summary");
  reject("mutate/commit", {{"repoId", repoId}, {"message", ""}}, "empty commit message");
  reject("blame/file", {{"repoId", repoId}, {"path", ""}, {"streamId", "s"}}, "empty path");
  reject("search/commits", {{"repoId", repoId}, {"streamId", ""}}, "empty streamId");
  reject("diff/commit", {{"repoId", repoId}, {"sha", ""}}, "empty sha");

  // Required members the engine will not guess.
  reject("stash/apply", {{"repoId", repoId}, {"index", 0}}, "missing pop");
  reject("blame/file", {{"repoId", repoId}, {"path", "src/main.txt"}}, "missing streamId");
  reject("history/line", {{"repoId", repoId}, {"path", "src/main.txt"}, {"startLine", 1}},
         "missing endLine");

  // Patch envelopes without a diff, and rebase steps without a commit.
  reject("patch/apply",
         {{"repoId", repoId},
          {"envelope",
           {{"format", "gitglasses-patch"},
            {"version", 1},
            {"baseSha", std::string(40, 'a')},
            {"summary", "empty"},
            {"patch", ""},
            {"createdAtIso", "2026-01-01T00:00:00Z"}}}},
         "empty patch text");
  reject("rebase/start",
         {{"repoId", repoId},
          {"upstream", "HEAD"},
          {"plan", Json::array({{{"action", "pick"}, {"sha", ""}, {"summary", "x"}}})}},
         "rebase step without a sha");

  // Payload caps are bounded on both sides.
  reject("rev/fileAtRev",
         {{"repoId", repoId}, {"path", "src/main.txt"}, {"rev", "HEAD"}, {"maxBytes", 0}},
         "zero maxBytes");
  reject("rev/fileAtRev",
         {{"repoId", repoId},
          {"path", "src/main.txt"},
          {"rev", "HEAD"},
          {"maxBytes", 64 * 1024 * 1024}},
         "maxBytes above the ceiling");
}

}  // namespace
}  // namespace gg
