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

// File the sequence editor leaves in git's rebase state directory
// (rebase-merge) with a copy of the plan, so a rebase resumed after a stop
// still applies the plan's messages. git removes it with the rest of the
// directory when the rebase finishes or is aborted.
inline constexpr const char* kPersistedPlanName = "gitglasses-plan.json";

// Rewrites the git-generated rebase todo according to the JSON plan in the
// control file ({"plan": RebaseEntry[], "commentChar": "#"}). The plan must
// name every commit the todo offers, each once, in replay order: a todo
// commit the plan does not name was committed after the plan was made, and a
// plan commit the todo does not offer is one git will not replay (a merge, or
// a change the upstream already has). Either refuses the rebase rather than
// guessing. Dropped commits become explicit `drop` lines, and the
// `update-ref` lines git adds for rebase.updateRefs move with the commit they
// followed (to the commit before it when that one is dropped, and past any
// squash/fixup folded into it).
//
// On success the plan is also copied to <todo dir>/kPersistedPlanName. On
// failure a readable reason is stored under "error" in the control file and
// the return is non-zero, which makes git abort before it touches any commit.
int runSequenceEditor(const std::string& controlPath, const std::string& todoPath);

// Replaces a commit-message file with the plan's message for the commit git
// is stopping at, read from the last line of rebase-merge/done: a reword
// entry's message, or for a squash/fixup chain the latest squash message in
// the chain. Leaves git's file untouched when the plan has no message for
// that commit.
int runMessageEditor(const std::string& controlPath, const std::string& msgPath);

}  // namespace gg::exec
