#pragma once

#include <string>
#include <string_view>
#include <vector>

#include "util/cancel.h"
#include "util/result.h"

namespace gg::exec {

// True when git's option parser would read this value as a flag.
//
// Refnames, remotes and paths reach argv as positionals; git parses a leading
// '-' as an option wherever it appears, so such a value can become an
// arbitrary-command primitive (--upload-pack=, --exec=) or a file write
// (--output=). Values are not always client-supplied — refnames come from the
// repository — so a hostile repo is enough. Callers reject these, and add a
// "--" separator wherever the subcommand accepts one.
inline bool looksLikeGitOption(std::string_view value) {
  return !value.empty() && value.front() == '-';
}

// Options for GitProcess::spawn beyond the defaults every caller wants.
struct SpawnOpts {
  // "NAME=value" entries applied on top of the inherited environment. An
  // entry replaces any inherited variable of the same name (and any of the
  // default scrub entries), so the child sees exactly one value per name.
  std::vector<std::string> extraEnv;
  // The caller consumes stdout byte-exact via readAll() rather than through
  // readLine(); no newline handling is applied to the stream.
  bool rawOutput = false;
};

// A spawned `git` child process. Stdout is line-buffered for parsing; stderr
// is captured for error reporting. Cancellation kills the whole process
// group, so a blame of a huge file stops costing CPU the moment the client
// scrolls away.
class GitProcess {
 public:
  // Spawns `git <args...>` with `cwd` as working directory. The environment
  // is scrubbed of interactive/optional-lock behavior (GIT_OPTIONAL_LOCKS=0,
  // GIT_TERMINAL_PROMPT=0, LC_ALL=C) so output is stable and non-blocking;
  // opts.extraEnv overrides both the inherited environment and the scrub.
  static Result<GitProcess> spawn(const std::string& cwd, std::vector<std::string> args,
                                  const SpawnOpts& opts = {});

  GitProcess(GitProcess&& other) noexcept;
  GitProcess& operator=(GitProcess&&) = delete;
  GitProcess(const GitProcess&) = delete;
  GitProcess& operator=(const GitProcess&) = delete;
  ~GitProcess();

  // Reads the next stdout line (without trailing newline). Returns false on
  // EOF. Throws CancelledError if the token fires; the child is killed first.
  bool readLine(std::string& out, const CancelToken& token);

  // Reads all remaining stdout bytes verbatim (CR and LF preserved) until
  // EOF. Throws CancelledError if the token fires; the child is killed first.
  std::string readAll(const CancelToken& token);

  // Waits for exit, returns the exit code. Kills the process group on cancel.
  int wait(const CancelToken& token);

  // Stderr accumulated so far (complete once wait() returned).
  const std::string& stderrOutput() const { return stderr_; }

 private:
  GitProcess() = default;

  bool fillBuffer(const CancelToken& token);  // false on stdout EOF
  void drainStderr(bool blocking);
  void killGroup();

#ifdef _WIN32
  // Win32 handles kept as void* so this header stays free of <windows.h>.
  void* process_ = nullptr;     // process HANDLE
  void* job_ = nullptr;         // job object HANDLE (kill-on-close)
  void* stdoutHandle_ = nullptr;
  void* stderrHandle_ = nullptr;
#else
  int pid_ = -1;
  int stdoutFd_ = -1;
  int stderrFd_ = -1;
#endif
  std::string buffer_;
  size_t bufferPos_ = 0;
  bool eof_ = false;
  std::string stderr_;
  bool reaped_ = false;
  int exitCode_ = -1;
};

}  // namespace gg::exec
