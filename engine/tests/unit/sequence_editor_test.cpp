// Unit tests for the rebase editor shims: todo rewriting from a plan, and
// commit messages looked up by the commit git is stopped at.

#include "exec/sequence_editor.h"

#include <gtest/gtest.h>
#include <nlohmann/json.hpp>

#include <filesystem>
#include <fstream>
#include <sstream>
#include <string>

#include "test_fixtures.h"

namespace gg::exec {
namespace {

using Json = nlohmann::json;
namespace fs = std::filesystem;

class ShimFiles {
 public:
  ShimFiles() { dir_ = gg::testing::makeTempDir("gg-seq-editor-"); }
  ~ShimFiles() {
    std::error_code ec;
    fs::remove_all(dir_, ec);
  }

  std::string write(const std::string& name, const std::string& contents) {
    const fs::path file = dir_ / name;
    std::ofstream out(file, std::ios::binary | std::ios::trunc);
    out << contents;
    EXPECT_TRUE(out.flush().good());
    return file.string();
  }

  const fs::path& dir() const { return dir_; }

  std::string read(const std::string& name) const {
    std::ifstream in(dir_ / name, std::ios::binary);
    std::ostringstream buffer;
    buffer << in.rdbuf();
    return buffer.str();
  }

 private:
  fs::path dir_;
};

const char* kTodo =
    "pick 1111111 first subject\n"
    "pick 2222222 second subject\n"
    "pick 3333333 third subject\n"
    "\n"
    "# Rebase instructions follow\n";

Json planEntry(const std::string& action, const std::string& shortSha) {
  // Plans carry full shas; the todo abbreviates. Repeat to 40 chars.
  std::string full;
  while (full.size() < 40) full += shortSha.substr(0, 1);
  return {{"action", action}, {"sha", shortSha.substr(0, 7) + full.substr(7)}, {"summary", "s"}};
}

TEST(SequenceEditor, RewritesTodoInPlanOrderWithMappedActions) {
  ShimFiles files;
  const Json plan = Json::array({planEntry("pick", "2222222"), planEntry("reword", "1111111"),
                                 planEntry("drop", "3333333")});
  const std::string control = files.write("control.json", Json{{"plan", plan}}.dump());
  const std::string todo = files.write("todo", kTodo);

  EXPECT_EQ(runSequenceEditor(control, todo), 0);
  // Dropped commits stay in the todo as explicit drops, so git's
  // missing-commit check never mistakes them for accidents.
  EXPECT_EQ(files.read("todo"),
            "pick 2222222 second subject\n"
            "reword 1111111 first subject\n"
            "drop 3333333 third subject\n");
  // The plan is kept beside the todo for a rebase resumed after a stop.
  const Json persisted = Json::parse(files.read(kPersistedPlanName));
  EXPECT_EQ(persisted["plan"], plan);
  EXPECT_EQ(persisted["rebaseDir"], files.dir().string());
}

// A commit the plan does not list was made after the plan: dropping it would
// lose work, so the rebase is refused instead.
TEST(SequenceEditor, TodoCommitMissingFromThePlanRefuses) {
  ShimFiles files;
  const Json plan = Json::array({planEntry("pick", "3333333"), planEntry("pick", "1111111")});
  const std::string control = files.write("control.json", Json{{"plan", plan}}.dump());
  const std::string todo = files.write("todo", kTodo);

  EXPECT_EQ(runSequenceEditor(control, todo), 1);
  EXPECT_EQ(files.read("todo"), kTodo);
  const std::string error = Json::parse(files.read("control.json")).value("error", "");
  EXPECT_NE(error.find("2222222 (second subject)"), std::string::npos) << error;
  EXPECT_NE(error.find("Reload the plan"), std::string::npos) << error;
}

TEST(SequenceEditor, MalformedInputAbortsWithoutRewriting) {
  ShimFiles files;
  const std::string todo = files.write("todo", kTodo);

  // Unparseable control file.
  const std::string garbage = files.write("garbage.json", "not json");
  EXPECT_EQ(runSequenceEditor(garbage, todo), 1);

  // Plan referencing a sha git did not offer, e.g. a merge commit.
  const Json unknown = Json::array({planEntry("pick", "9999999"), planEntry("pick", "1111111"),
                                    planEntry("pick", "2222222"), planEntry("pick", "3333333")});
  const std::string unknownControl = files.write("unknown.json", Json{{"plan", unknown}}.dump());
  EXPECT_EQ(runSequenceEditor(unknownControl, todo), 1);
  const std::string error = Json::parse(files.read("unknown.json")).value("error", "");
  EXPECT_NE(error.find("9999999"), std::string::npos) << error;
  EXPECT_NE(error.find("will not replay"), std::string::npos) << error;

  // Unknown plan action.
  const Json badAction = Json::array({planEntry("explode", "1111111")});
  const std::string badControl = files.write("bad.json", Json{{"plan", badAction}}.dump());
  EXPECT_EQ(runSequenceEditor(badControl, todo), 1);

  // The same commit twice.
  const Json twice = Json::array({planEntry("pick", "1111111"), planEntry("pick", "1111111"),
                                  planEntry("pick", "2222222"), planEntry("pick", "3333333")});
  const std::string twiceControl = files.write("twice.json", Json{{"plan", twice}}.dump());
  EXPECT_EQ(runSequenceEditor(twiceControl, todo), 1);

  EXPECT_EQ(files.read("todo"), kTodo);  // untouched on every failure
}

TEST(SequenceEditor, ReadsAbbreviatedCommandsAndCustomCommentChar) {
  ShimFiles files;
  const Json plan = Json::array(
      {planEntry("pick", "1111111"), planEntry("squash", "2222222"), planEntry("pick", "3333333")});
  const std::string control =
      files.write("control.json", Json{{"plan", plan}, {"commentChar", ";"}}.dump());
  const std::string todo = files.write("todo",
                                       "p 1111111 first subject\n"
                                       "p 2222222 second subject\n"
                                       "  pick 3333333 third subject\n"
                                       "\n"
                                       "; Rebase instructions follow\n"
                                       "noop\n");

  EXPECT_EQ(runSequenceEditor(control, todo), 0);
  EXPECT_EQ(files.read("todo"),
            "pick 1111111 first subject\n"
            "squash 2222222 second subject\n"
            "pick 3333333 third subject\n");
}

TEST(SequenceEditor, UnsupportedTodoLineRefusesNamingTheLine) {
  ShimFiles files;
  const Json plan = Json::array({planEntry("pick", "1111111")});
  const std::string control = files.write("control.json", Json{{"plan", plan}}.dump());
  const std::string todoText = "pick 1111111 first subject\nexec make test\n";
  const std::string todo = files.write("todo", todoText);

  EXPECT_EQ(runSequenceEditor(control, todo), 1);
  EXPECT_EQ(files.read("todo"), todoText);
  const std::string error = Json::parse(files.read("control.json")).value("error", "");
  EXPECT_NE(error.find("'exec make test'"), std::string::npos) << error;
}

// rebase.updateRefs=true puts update-ref lines after the commits that stacked
// branches point at; each must keep following its commit.
TEST(SequenceEditor, UpdateRefLinesFollowTheirCommit) {
  ShimFiles files;
  const std::string todoText =
      "pick 1111111 first subject\n"
      "update-ref refs/heads/stack-a\n"
      "\n"
      "pick 2222222 second subject\n"
      "u refs/heads/stack-b\n"
      "pick 3333333 third subject\n";

  {
    // Reordered: each ref moves with its commit.
    const Json plan = Json::array(
        {planEntry("pick", "2222222"), planEntry("pick", "1111111"), planEntry("pick", "3333333")});
    const std::string control = files.write("control.json", Json{{"plan", plan}}.dump());
    const std::string todo = files.write("todo", todoText);
    EXPECT_EQ(runSequenceEditor(control, todo), 0);
    EXPECT_EQ(files.read("todo"),
              "pick 2222222 second subject\n"
              "update-ref refs/heads/stack-b\n"
              "pick 1111111 first subject\n"
              "update-ref refs/heads/stack-a\n"
              "pick 3333333 third subject\n");
  }
  {
    // Dropped: stack-b stays where its commit was, after the first commit.
    const Json plan = Json::array(
        {planEntry("pick", "1111111"), planEntry("drop", "2222222"), planEntry("pick", "3333333")});
    const std::string control = files.write("control.json", Json{{"plan", plan}}.dump());
    const std::string todo = files.write("todo", todoText);
    EXPECT_EQ(runSequenceEditor(control, todo), 0);
    EXPECT_EQ(files.read("todo"),
              "pick 1111111 first subject\n"
              "update-ref refs/heads/stack-a\n"
              "update-ref refs/heads/stack-b\n"
              "pick 3333333 third subject\n"
              "drop 2222222 second subject\n");
  }
  {
    // Squashed into: stack-a waits for the combined commit.
    const Json plan = Json::array({planEntry("pick", "1111111"), planEntry("fixup", "2222222"),
                                   planEntry("pick", "3333333")});
    const std::string control = files.write("control.json", Json{{"plan", plan}}.dump());
    const std::string todo = files.write("todo", todoText);
    EXPECT_EQ(runSequenceEditor(control, todo), 0);
    EXPECT_EQ(files.read("todo"),
              "pick 1111111 first subject\n"
              "fixup 2222222 second subject\n"
              "update-ref refs/heads/stack-a\n"
              "update-ref refs/heads/stack-b\n"
              "pick 3333333 third subject\n");
  }
}

// Writes a plan control file plus the rebase state git keeps: `done` lists
// the commands git has started, the last being the one it asks a message for.
std::string messageControl(ShimFiles& files, const Json& plan, const std::string& done) {
  fs::create_directories(files.dir() / "rebase-merge");
  files.write("rebase-merge/done", done);
  return files.write(
      "control.json",
      Json{{"plan", plan}, {"rebaseDir", (files.dir() / "rebase-merge").string()}}.dump());
}

Json messageEntry(const std::string& action, char shaChar, const std::string& message = "") {
  Json entry = {{"action", action}, {"sha", std::string(40, shaChar)}, {"summary", "s"}};
  if (!message.empty()) entry["message"] = message;
  return entry;
}

std::string doneLine(const std::string& command, char shaChar) {
  return command + " " + std::string(40, shaChar) + " subject\n";
}

// Messages are keyed by the commit git is at, not by how many times git
// asked: a squash without a message still opens git's editor.
TEST(SequenceEditor, MessageEditorAnswersForTheCommitGitIsAt) {
  ShimFiles files;
  const Json plan = Json::array({messageEntry("pick", 'a'), messageEntry("squash", 'b'),
                                 messageEntry("reword", 'c', "C reworded")});

  // At the squash: no message in the plan, so git's combined message stands.
  std::string control =
      messageControl(files, plan, doneLine("pick", 'a') + doneLine("squash", 'b'));
  const std::string msg = files.write("COMMIT_EDITMSG", "combined A and B\n");
  EXPECT_EQ(runMessageEditor(control, msg), 0);
  EXPECT_EQ(files.read("COMMIT_EDITMSG"), "combined A and B\n");

  // At the reword: its own message.
  control = messageControl(
      files, plan, doneLine("pick", 'a') + doneLine("squash", 'b') + doneLine("reword", 'c'));
  files.write("COMMIT_EDITMSG", "commit C\n");
  EXPECT_EQ(runMessageEditor(control, msg), 0);
  EXPECT_EQ(files.read("COMMIT_EDITMSG"), "C reworded\n");
}

TEST(SequenceEditor, MessageEditorUsesTheLatestSquashMessageOfAChain) {
  ShimFiles files;
  const Json plan = Json::array({messageEntry("pick", 'a'), messageEntry("squash", 'b', "A and B"),
                                 messageEntry("drop", 'x'), messageEntry("fixup", 'c'),
                                 messageEntry("squash", 'd'), messageEntry("pick", 'e')});
  const std::string control = messageControl(files, plan,
                                             doneLine("pick", 'a') + doneLine("squash", 'b') +
                                                 doneLine("fixup", 'c') + doneLine("squash", 'd'));
  const std::string msg = files.write("COMMIT_EDITMSG", "git's combination\n");
  EXPECT_EQ(runMessageEditor(control, msg), 0);
  EXPECT_EQ(files.read("COMMIT_EDITMSG"), "A and B\n");
}

TEST(SequenceEditor, MessageEditorLeavesOtherStopsAlone) {
  ShimFiles files;
  const Json plan = Json::array({messageEntry("pick", 'a'), messageEntry("edit", 'b'),
                                 messageEntry("reword", 'c', "unused here")});
  const std::string msg = files.write("COMMIT_EDITMSG", "keep me\n");

  // A pick resumed after a conflict.
  std::string control = messageControl(files, plan, doneLine("pick", 'a'));
  EXPECT_EQ(runMessageEditor(control, msg), 0);
  EXPECT_EQ(files.read("COMMIT_EDITMSG"), "keep me\n");

  // An amend at an edit stop.
  control = messageControl(files, plan, doneLine("pick", 'a') + doneLine("edit", 'b'));
  EXPECT_EQ(runMessageEditor(control, msg), 0);
  EXPECT_EQ(files.read("COMMIT_EDITMSG"), "keep me\n");

  // No rebase state at all.
  const std::string bare = files.write("bare.json", Json{{"plan", plan}}.dump());
  EXPECT_EQ(runMessageEditor(bare, msg), 0);
  EXPECT_EQ(files.read("COMMIT_EDITMSG"), "keep me\n");
}

}  // namespace
}  // namespace gg::exec
