// Unit tests for the rebase editor shims: todo rewriting from a plan and
// ordered message consumption via the control file.

#include "exec/sequence_editor.h"

#include <gtest/gtest.h>
#include <nlohmann/json.hpp>

#include <filesystem>
#include <fstream>
#include <sstream>
#include <string>

namespace gg::exec {
namespace {

using Json = nlohmann::json;
namespace fs = std::filesystem;

class ShimFiles {
 public:
  ShimFiles() {
    dir_ = fs::temp_directory_path() /
           ("gg-seq-editor-" +
            std::to_string(::testing::UnitTest::GetInstance()->random_seed()) + "-" +
            std::to_string(counter()++));
    fs::create_directories(dir_);
  }
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

  std::string read(const std::string& name) const {
    std::ifstream in(dir_ / name, std::ios::binary);
    std::ostringstream buffer;
    buffer << in.rdbuf();
    return buffer.str();
  }

 private:
  static int& counter() {
    static int value = 0;
    return value;
  }
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
  EXPECT_EQ(files.read("todo"),
            "pick 2222222 second subject\n"
            "reword 1111111 first subject\n");
}

TEST(SequenceEditor, OmittedTodoShaIsDropped) {
  ShimFiles files;
  const Json plan = Json::array({planEntry("pick", "3333333"), planEntry("pick", "1111111")});
  const std::string control = files.write("control.json", Json{{"plan", plan}}.dump());
  const std::string todo = files.write("todo", kTodo);

  EXPECT_EQ(runSequenceEditor(control, todo), 0);
  EXPECT_EQ(files.read("todo"),
            "pick 3333333 third subject\n"
            "pick 1111111 first subject\n");
}

TEST(SequenceEditor, MalformedInputAbortsWithoutRewriting) {
  ShimFiles files;
  const std::string todo = files.write("todo", kTodo);

  // Unparseable control file.
  const std::string garbage = files.write("garbage.json", "not json");
  EXPECT_EQ(runSequenceEditor(garbage, todo), 1);

  // Plan referencing a sha git did not offer.
  const Json unknown = Json::array({planEntry("pick", "9999999")});
  const std::string unknownControl = files.write("unknown.json", Json{{"plan", unknown}}.dump());
  EXPECT_EQ(runSequenceEditor(unknownControl, todo), 1);

  // Unknown plan action.
  const Json badAction = Json::array({planEntry("explode", "1111111")});
  const std::string badControl = files.write("bad.json", Json{{"plan", badAction}}.dump());
  EXPECT_EQ(runSequenceEditor(badControl, todo), 1);

  EXPECT_EQ(files.read("todo"), kTodo);  // untouched on every failure
}

TEST(SequenceEditor, MessageEditorConsumesMessagesInPlanOrder) {
  ShimFiles files;
  const Json plan = Json::array(
      {Json{{"action", "reword"}, {"sha", std::string(40, '1')}, {"message", "first message"}},
       Json{{"action", "pick"}, {"sha", std::string(40, '2')}},
       Json{{"action", "squash"}, {"sha", std::string(40, '3')}, {"message", "second message"}}});
  const std::string control =
      files.write("control.json", Json{{"plan", plan}, {"consumed", 0}}.dump());

  const std::string msg = files.write("msg", "original\n");
  EXPECT_EQ(runMessageEditor(control, msg), 0);
  EXPECT_EQ(files.read("msg"), "first message\n");

  files.write("msg", "original again\n");
  EXPECT_EQ(runMessageEditor(control, msg), 0);
  EXPECT_EQ(files.read("msg"), "second message\n");

  // No messages left: the file stays as git prepared it.
  files.write("msg", "keep me\n");
  EXPECT_EQ(runMessageEditor(control, msg), 0);
  EXPECT_EQ(files.read("msg"), "keep me\n");
}

}  // namespace
}  // namespace gg::exec
