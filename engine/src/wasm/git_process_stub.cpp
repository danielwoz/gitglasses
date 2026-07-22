// Wasm build: there are no child processes, so spawning the git CLI always
// fails with a typed Internal error. cli_detect's startup probe consequently
// reports the CLI as unavailable, which makes initialize advertise
// gitCli:false and CLI-dependent methods reject with MethodNotSupported.

#include "exec/git_process.h"

#include <errno.h>
#include <spawn.h>

#include "exec/sequence_editor.h"

// Emscripten's libc declares posix_spawnp but does not define it. All call
// sites (runGitWithEnv in mutate/patch) sit behind requireGitCli, which
// always rejects in this build, so a failing definition is never reached.
extern "C" int posix_spawnp(pid_t*, const char*, const posix_spawn_file_actions_t*,
                            const posix_spawnattr_t*, char* const[], char* const[]) {
  return ENOSYS;
}

namespace gg::exec {

// The editor-shim re-exec path needs the engine binary's own path; there is
// no such binary in the wasm build and the rebase methods that use it are
// CLI-gated.
std::string selfExePath() { return "/gitglasses-engine-wasm"; }

Result<GitProcess> GitProcess::spawn(const std::string&, std::vector<std::string>) {
  return Error{ErrorCode::Internal, "git CLI processes are not available in this engine build"};
}

GitProcess::GitProcess(GitProcess&&) noexcept = default;

GitProcess::~GitProcess() = default;

bool GitProcess::readLine(std::string&, const CancelToken&) { return false; }

int GitProcess::wait(const CancelToken&) { return -1; }

}  // namespace gg::exec
