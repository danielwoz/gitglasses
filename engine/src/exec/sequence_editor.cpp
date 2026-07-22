#include "exec/sequence_editor.h"

#include <nlohmann/json.hpp>
#include <unistd.h>

#include <cstdint>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <string>
#include <vector>

namespace gg::exec {

namespace {

using Json = nlohmann::json;

std::string& argv0Fallback() {
  static std::string value;
  return value;
}

std::optional<std::string> readFile(const std::string& path) {
  std::ifstream in(path, std::ios::binary);
  if (!in) return std::nullopt;
  std::ostringstream buffer;
  buffer << in.rdbuf();
  return buffer.str();
}

bool writeFile(const std::string& path, const std::string& contents) {
  std::ofstream out(path, std::ios::binary | std::ios::trunc);
  if (!out) return false;
  out << contents;
  out.flush();
  return static_cast<bool>(out);
}

// The control file carries {"plan": RebaseEntry[], "consumed": n}.
std::optional<Json> readControl(const std::string& path) {
  const auto text = readFile(path);
  if (!text) return std::nullopt;
  Json parsed = Json::parse(*text, nullptr, /*allow_exceptions=*/false);
  if (parsed.is_discarded() || !parsed.is_object() || !parsed.contains("plan") ||
      !parsed["plan"].is_array()) {
    return std::nullopt;
  }
  return parsed;
}

bool knownAction(const std::string& action) {
  return action == "pick" || action == "reword" || action == "squash" || action == "fixup" ||
         action == "drop" || action == "edit";
}

// True when one sha is a (non-empty) prefix of the other: the todo carries
// abbreviated shas while the plan carries full ones.
bool shaMatches(const std::string& todoSha, const std::string& planSha) {
  if (todoSha.empty() || planSha.empty()) return false;
  const std::string& shorter = todoSha.size() <= planSha.size() ? todoSha : planSha;
  const std::string& longer = todoSha.size() <= planSha.size() ? planSha : todoSha;
  return longer.compare(0, shorter.size(), shorter) == 0;
}

}  // namespace

void setSelfPathFallback(const char* argv0) {
  if (argv0) argv0Fallback() = argv0;
}

std::string selfExePath() {
  char buffer[4096];
  const ssize_t n = ::readlink("/proc/self/exe", buffer, sizeof(buffer) - 1);
  if (n > 0) return std::string(buffer, static_cast<size_t>(n));
  std::error_code ec;
  const std::filesystem::path absolute = std::filesystem::absolute(argv0Fallback(), ec);
  return ec ? argv0Fallback() : absolute.string();
}

std::optional<int> maybeRunEditorShim(int argc, char** argv) {
  if (argc != 4) return std::nullopt;
  const std::string mode = argv[1];
  if (mode == "--edit-sequence") return runSequenceEditor(argv[2], argv[3]);
  if (mode == "--edit-message") return runMessageEditor(argv[2], argv[3]);
  return std::nullopt;
}

int runSequenceEditor(const std::string& controlPath, const std::string& todoPath) {
  const auto control = readControl(controlPath);
  const auto todoText = readFile(todoPath);
  if (!control || !todoText) return 1;

  // Collect the generated "pick <sha> <subject>" lines. Any other todo
  // command means the todo has a shape this rewrite does not understand, so
  // fail and let git abort untouched.
  struct TodoLine {
    std::string sha;
    std::string rest;
  };
  std::vector<TodoLine> todoLines;
  std::istringstream in(*todoText);
  std::string line;
  while (std::getline(in, line)) {
    if (!line.empty() && line.back() == '\r') line.pop_back();
    if (line.empty() || line[0] == '#') continue;
    std::istringstream fields(line);
    std::string command, sha;
    fields >> command >> sha;
    if (command != "pick" || sha.empty()) return 1;
    std::string rest;
    std::getline(fields, rest);
    if (!rest.empty() && rest.front() == ' ') rest.erase(0, 1);
    todoLines.push_back({std::move(sha), std::move(rest)});
  }

  std::string rewritten;
  for (const auto& entry : (*control)["plan"]) {
    if (!entry.is_object()) return 1;
    const std::string action = entry.value("action", "");
    const std::string sha = entry.value("sha", "");
    if (!knownAction(action) || sha.empty()) return 1;
    const TodoLine* match = nullptr;
    for (const auto& todo : todoLines) {
      if (shaMatches(todo.sha, sha)) {
        match = &todo;
        break;
      }
    }
    if (!match) return 1;  // plan references a commit git did not offer
    if (action == "drop") continue;
    rewritten += action + " " + match->sha;
    if (!match->rest.empty()) rewritten += " " + match->rest;
    rewritten += "\n";
  }
  // Todo shas absent from the plan stay out of `rewritten`: the plan is the
  // full authoritative list, so omission means drop.
  return writeFile(todoPath, rewritten) ? 0 : 1;
}

int runMessageEditor(const std::string& controlPath, const std::string& msgPath) {
  auto control = readControl(controlPath);
  if (!control) return 0;  // keep git's default message rather than aborting
  const std::int64_t consumed = control->value("consumed", std::int64_t{0});
  std::int64_t seen = 0;
  for (const auto& entry : (*control)["plan"]) {
    if (!entry.is_object()) continue;
    const std::string action = entry.value("action", "");
    const std::string message = entry.value("message", "");
    if ((action != "reword" && action != "squash") || message.empty()) continue;
    if (seen++ < consumed) continue;
    std::string contents = message;
    if (contents.back() != '\n') contents += '\n';
    if (!writeFile(msgPath, contents)) return 1;
    (*control)["consumed"] = consumed + 1;
    writeFile(controlPath, control->dump());
    return 0;
  }
  return 0;  // no pending message: keep the file git prepared
}

}  // namespace gg::exec
