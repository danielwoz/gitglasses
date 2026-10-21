#include "exec/sequence_editor.h"

#include <nlohmann/json.hpp>

#ifdef _WIN32
#include "exec/win_unicode.h"
// After windows.h, which win_unicode.h includes.
#include <shellapi.h>
#else
#include <unistd.h>
#ifdef __APPLE__
#include <mach-o/dyld.h>

#include <cstring>
#endif
#endif

#include <filesystem>
#include <fstream>
#include <sstream>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "util/utf8_path.h"

namespace gg::exec {

namespace {

using Json = nlohmann::json;

std::string& argv0Fallback() {
  static std::string value;
  return value;
}

std::optional<std::string> readFile(const std::string& path) {
  std::ifstream in(util::pathFromUtf8(path), std::ios::binary);
  if (!in) return std::nullopt;
  std::ostringstream buffer;
  buffer << in.rdbuf();
  return buffer.str();
}

bool writeFile(const std::string& path, const std::string& contents) {
  std::ofstream out(util::pathFromUtf8(path), std::ios::binary | std::ios::trunc);
  if (!out) return false;
  out << contents;
  out.flush();
  return static_cast<bool>(out);
}

// The control file carries {"plan": RebaseEntry[], "commentChar": c} and
// collects "rebaseDir" and "error" from the sequence editor.
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

// The actions a plan entry may carry, which are also the todo commands that
// name a commit.
bool knownAction(const std::string& action) {
  return action == "pick" || action == "reword" || action == "squash" || action == "fixup" ||
         action == "drop" || action == "edit";
}

// The full name of a todo command, which rebase.abbreviateCommands shortens
// to its first letter.
std::string fullCommand(const std::string& command) {
  static constexpr std::pair<std::string_view, std::string_view> kAbbreviations[] = {
      {"p", "pick"},  {"r", "reword"}, {"e", "edit"},  {"s", "squash"},
      {"f", "fixup"}, {"d", "drop"},   {"x", "exec"},  {"b", "break"},
      {"l", "label"}, {"t", "reset"},  {"m", "merge"}, {"u", "update-ref"}};
  for (const auto& [shortName, name] : kAbbreviations) {
    if (command == shortName) return std::string(name);
  }
  return command;
}

// True when one sha is a (non-empty) prefix of the other: the todo carries
// abbreviated shas while the plan carries full ones.
bool shaMatches(const std::string& todoSha, const std::string& planSha) {
  if (todoSha.empty() || planSha.empty()) return false;
  const std::string& shorter = todoSha.size() <= planSha.size() ? todoSha : planSha;
  const std::string& longer = todoSha.size() <= planSha.size() ? planSha : todoSha;
  return longer.compare(0, shorter.size(), shorter) == 0;
}

// "abc1234 (subject)" for messages that name a commit.
std::string describe(const std::string& sha, const std::string& subject) {
  const std::string shortSha = sha.substr(0, 7);
  return subject.empty() ? shortSha : shortSha + " (" + subject + ")";
}

// A commit line of git's todo, with the update-ref lines that followed it.
struct TodoCommit {
  std::string sha;
  std::string rest;  // subject (and anything else git wrote after the sha)
  std::vector<std::string> refs;
  bool planned = false;
};

}  // namespace

void setSelfPathFallback(const char* argv0) {
  if (argv0) argv0Fallback() = argv0;
}

std::string selfExePath() {
#ifdef _WIN32
  std::wstring buffer(MAX_PATH, L'\0');
  for (;;) {
    const DWORD n = GetModuleFileNameW(nullptr, buffer.data(),
                                       static_cast<DWORD>(buffer.size()));
    if (n == 0) break;
    if (n < buffer.size()) {
      buffer.resize(n);
      return wideToUtf8(buffer);
    }
    buffer.resize(buffer.size() * 2);  // path was truncated; retry larger
  }
#elif defined(__APPLE__)
  // _NSGetExecutablePath yields the launch path (possibly relative or with
  // symlinks); canonicalize so git can invoke the shim from any directory.
  uint32_t size = 0;
  ::_NSGetExecutablePath(nullptr, &size);
  std::string buffer(size, '\0');
  if (::_NSGetExecutablePath(buffer.data(), &size) == 0) {
    buffer.resize(std::strlen(buffer.c_str()));
    std::error_code canonEc;
    const std::filesystem::path canonical = std::filesystem::canonical(buffer, canonEc);
    return canonEc ? buffer : canonical.string();
  }
#else
  char buffer[4096];
  const ssize_t n = ::readlink("/proc/self/exe", buffer, sizeof(buffer) - 1);
  if (n > 0) return std::string(buffer, static_cast<size_t>(n));
#endif
  std::error_code ec;
  const std::filesystem::path absolute = std::filesystem::absolute(argv0Fallback(), ec);
  return ec ? argv0Fallback() : absolute.string();
}

std::optional<int> maybeRunEditorShim(int argc, char** argv) {
  if (argc != 4) return std::nullopt;
  const std::string mode = argv[1];
  if (mode != "--edit-sequence" && mode != "--edit-message") return std::nullopt;
  std::string control = argv[2];
  std::string target = argv[3];
#ifdef _WIN32
  // The C runtime hands argv over in the ANSI code page; the wide command
  // line keeps a path with characters outside it intact.
  int count = 0;
  if (LPWSTR* wide = CommandLineToArgvW(GetCommandLineW(), &count)) {
    if (count == 4) {
      control = wideToUtf8(wide[2]);
      target = wideToUtf8(wide[3]);
    }
    LocalFree(wide);
  }
#endif
  if (mode == "--edit-sequence") return runSequenceEditor(control, target);
  return runMessageEditor(control, target);
}

int runSequenceEditor(const std::string& controlPath, const std::string& todoPath) {
  auto control = readControl(controlPath);
  const auto todoText = readFile(todoPath);
  if (!control) return 1;
  // Records why the rebase was refused, for the engine to report in place of
  // git's generic "problem with the editor".
  const auto fail = [&](const std::string& reason) {
    (*control)["error"] = reason;
    writeFile(controlPath, control->dump());
    return 1;
  };
  if (!todoText) return fail("cannot read git's rebase todo");

  const std::string commentChar = control->value("commentChar", "#");
  std::vector<TodoCommit> commits;
  // update-ref lines ahead of every commit: they record the rebase's base.
  std::vector<std::string> leadingRefs;
  std::istringstream in(*todoText);
  std::string line;
  while (std::getline(in, line)) {
    if (!line.empty() && line.back() == '\r') line.pop_back();
    const size_t start = line.find_first_not_of(" \t");
    if (start == std::string::npos) continue;
    const std::string_view content = std::string_view(line).substr(start);
    if (content.front() == '#' || content.rfind(commentChar, 0) == 0) continue;
    std::istringstream fields{std::string(content)};
    std::string word;
    fields >> word;
    const std::string command = fullCommand(word);
    if (command == "noop") continue;
    if (knownAction(command)) {
      std::string sha;
      fields >> sha;
      // `fixup -C <sha>` / `fixup -c <sha>` carry a flag before the sha.
      if (command == "fixup" && (sha == "-C" || sha == "-c")) fields >> sha;
      if (sha.empty()) return fail("cannot read git's rebase todo line '" + line + "'");
      std::string rest;
      std::getline(fields, rest);
      if (!rest.empty() && rest.front() == ' ') rest.erase(0, 1);
      commits.push_back({std::move(sha), std::move(rest), {}, false});
      continue;
    }
    if (command == "update-ref") {
      std::string ref;
      fields >> ref;
      if (ref.empty()) return fail("cannot read git's rebase todo line '" + line + "'");
      (commits.empty() ? leadingRefs : commits.back().refs).push_back(std::move(ref));
      continue;
    }
    return fail("git's rebase todo has a line the rebase editor does not support: '" + line + "'");
  }

  struct Step {
    std::string action;
    size_t todo;
  };
  std::vector<Step> steps;
  for (const auto& entry : (*control)["plan"]) {
    if (!entry.is_object()) return fail("the rebase plan has a malformed entry");
    const std::string action = entry.value("action", "");
    const std::string sha = entry.value("sha", "");
    if (!knownAction(action) || sha.empty()) {
      return fail("the rebase plan has an entry without a valid action and commit");
    }
    std::optional<size_t> match;
    for (size_t i = 0; i < commits.size(); ++i) {
      if (shaMatches(commits[i].sha, sha)) {
        match = i;
        break;
      }
    }
    if (!match) {
      return fail("the plan lists " + describe(sha, entry.value("summary", "")) +
                  ", which git will not replay: it is a merge commit or its change is "
                  "already upstream. Reload the plan.");
    }
    if (commits[*match].planned) {
      return fail("the plan lists " + describe(sha, entry.value("summary", "")) + " twice");
    }
    commits[*match].planned = true;
    steps.push_back({action, *match});
  }
  for (const auto& commit : commits) {
    if (!commit.planned) {
      return fail("the branch has " + describe(commit.sha, commit.rest) +
                  ", which the plan does not list; it was probably committed after the plan "
                  "was made. Reload the plan so it is not lost.");
    }
  }

  std::string rewritten;
  std::string drops;
  std::vector<std::string> pendingRefs = leadingRefs;
  const auto flushRefs = [&] {
    for (const auto& ref : pendingRefs) rewritten += "update-ref " + ref + "\n";
    pendingRefs.clear();
  };
  const auto todoLine = [](const std::string& action, const TodoCommit& commit) {
    return action + " " + commit.sha + (commit.rest.empty() ? "" : " " + commit.rest) + "\n";
  };
  for (const auto& step : steps) {
    const TodoCommit& commit = commits[step.todo];
    if (step.action == "drop") {
      // Written last, so git's missing-commit check sees every commit; a ref
      // that pointed at the dropped commit stays with the one before it.
      drops += todoLine("drop", commit);
    } else {
      // A ref waits out a squash/fixup chain so it ends up on the combined
      // commit rather than on an intermediate one.
      if (step.action != "squash" && step.action != "fixup") flushRefs();
      rewritten += todoLine(step.action, commit);
    }
    pendingRefs.insert(pendingRefs.end(), commit.refs.begin(), commit.refs.end());
  }
  flushRefs();
  rewritten += drops;

  const std::filesystem::path rebaseDir = util::pathFromUtf8(todoPath).parent_path();
  (*control)["rebaseDir"] = util::utf8FromPath(rebaseDir);
  control->erase("error");
  const std::string persisted = control->dump();
  if (!writeFile(util::utf8FromPath(rebaseDir / kPersistedPlanName), persisted) ||
      !writeFile(controlPath, persisted)) {
    return fail("cannot save the rebase plan next to git's rebase state");
  }
  return writeFile(todoPath, rewritten) ? 0 : fail("cannot write git's rebase todo");
}

int runMessageEditor(const std::string& controlPath, const std::string& msgPath) {
  const auto control = readControl(controlPath);
  if (!control) return 0;  // keep git's message rather than aborting

  // git records each todo command it has started in rebase-merge/done; the
  // last one is the commit this message is for.
  const std::string rebaseDir = control->value("rebaseDir", "");
  const std::filesystem::path done =
      rebaseDir.empty() ? util::pathFromUtf8(msgPath).parent_path() / "rebase-merge" / "done"
                        : util::pathFromUtf8(rebaseDir) / "done";
  const auto doneText = readFile(util::utf8FromPath(done));
  if (!doneText) return 0;
  std::string current;
  std::istringstream in(*doneText);
  std::string line;
  while (std::getline(in, line)) {
    if (!line.empty() && line.back() == '\r') line.pop_back();
    const size_t start = line.find_first_not_of(" \t");
    if (start == std::string::npos || line[start] == '#') continue;
    current = line.substr(start);
  }
  std::istringstream fields(current);
  std::string word, sha;
  fields >> word >> sha;
  if (fullCommand(word) == "fixup" && (sha == "-C" || sha == "-c")) fields >> sha;
  if (!knownAction(fullCommand(word)) || sha.empty()) return 0;

  const Json& plan = (*control)["plan"];
  std::optional<size_t> index;
  for (size_t i = 0; i < plan.size(); ++i) {
    if (plan[i].is_object() && shaMatches(sha, plan[i].value("sha", ""))) {
      index = i;
      break;
    }
  }
  if (!index) return 0;

  std::string message;
  const std::string action = plan[*index].value("action", "");
  if (action == "reword") {
    message = plan[*index].value("message", "");
  } else if (action == "squash" || action == "fixup") {
    // git asks once per chain, at its last squash/fixup: the latest squash
    // message in the chain describes the combined commit.
    for (size_t i = *index + 1; i-- > 0;) {
      const std::string step = plan[i].value("action", "");
      if (step == "squash") {
        message = plan[i].value("message", "");
        if (!message.empty()) break;
      } else if (step != "fixup" && step != "drop") {
        break;  // the commit the chain folds into
      }
    }
  }
  if (message.empty()) return 0;  // git's prepared message stands
  if (message.back() != '\n') message += '\n';
  return writeFile(msgPath, message) ? 0 : 1;
}

}  // namespace gg::exec
