#pragma once

#include <optional>
#include <string>

namespace gg::exec {

// Records argv[0] so selfExePath() has a fallback when /proc/self/exe is
// unavailable. Call once at process startup.
void setSelfPathFallback(const char* argv0);

// Absolute path of the running executable.
std::string selfExePath();

// Handles the editor-shim command lines git invokes during an engine-driven
// interactive rebase:
//   <binary> --edit-sequence <control-file> <todo-file>
//   <binary> --edit-message  <control-file> <msg-file>
// Returns the process exit code when argv selects a shim mode, nullopt
// otherwise so the caller proceeds with its normal startup.
std::optional<int> maybeRunEditorShim(int argc, char** argv);

// Rewrites the git-generated rebase todo according to the JSON plan in the
// control file: plan order and actions are authoritative, todo shas absent
// from the plan are dropped. Returns a process exit code; non-zero makes git
// abort the rebase before it touches any commit.
int runSequenceEditor(const std::string& controlPath, const std::string& todoPath);

// Replaces a commit-message file with the next unconsumed plan message
// (entries with action reword/squash and a non-empty message, in plan order),
// advancing the consumption counter stored in the control file. Leaves the
// file untouched when no message is pending.
int runMessageEditor(const std::string& controlPath, const std::string& msgPath);

}  // namespace gg::exec
