#pragma once

#include <atomic>
#include <chrono>
#include <cstdint>
#include <memory>
#include <string>
#include <string_view>
#include <vector>

#include "util/cancel.h"
#include "util/result.h"

namespace gg::exec {

// Wall-clock ceiling on a local git invocation. Cancellation covers the case
// where the client no longer wants the answer; this covers the case where git
// never answers at all (stalled filesystem, a credential or hook helper that
// ignores GIT_TERMINAL_PROMPT). High enough that no healthy local command on
// a large repository reaches it.
inline constexpr std::chrono::milliseconds kDefaultGitTimeout{120'000};

// Ceiling for invocations that talk to a remote (fetch/pull/push). A first
// fetch of a large repository over a slow link runs for minutes, and git's own
// TCP connect retry to a blackholed address runs past two minutes, so this
// ceiling only catches a remote that never answers at all.
inline constexpr std::chrono::milliseconds kNetworkGitTimeout{300'000};

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

class AskpassSession;

// How long a cancelled or timed-out git gets to exit after SIGTERM before its
// process group is killed outright. git removes its lock files on SIGTERM, so
// a stopped commit or rebase leaves no index.lock behind.
inline constexpr std::chrono::milliseconds kTerminateGrace{1000};

// What the prompts one git invocation raised have cost: the broker updates
// it, GitProcess reads it to keep time spent on prompts off git's clock.
struct AskpassPromptStats {
  // Prompts open right now.
  std::atomic<int> open{0};
  // Total time prompts have been open.
  std::atomic<std::int64_t> millis{0};
  // The user dismissed one.
  std::atomic<bool> declined{false};
};

// Options for GitProcess::spawn beyond the defaults every caller wants.
struct SpawnOpts {
  // "NAME=value" entries applied on top of the inherited environment. An
  // entry replaces any inherited variable of the same name (and any default
  // from childEnvOverrides()), so the child sees exactly one value per name.
  std::vector<std::string> extraEnv;
  // The caller consumes stdout byte-exact via readAll() rather than through
  // readLine(); no newline handling is applied to the stream.
  bool rawOutput = false;
  // Wall-clock ceiling measured from spawn. On expiry the process group is
  // killed, stdout reports EOF and timedOut() becomes true.
  std::chrono::milliseconds timeout = kDefaultGitTimeout;
};

// "NAME=value" settings every git child gets on top of the inherited
// environment: stable parse output, no lock contention with the user's own
// git commands, and never a hung child waiting for a terminal prompt.
// `askpassEnv` (see askpassEnvironment) routes prompts to the client instead.
// opts.extraEnv comes last, so a caller's entry wins over a default of the
// same name.
inline std::vector<std::string> childEnvOverrides(const SpawnOpts& opts,
                                                  const std::vector<std::string>& askpassEnv = {}) {
  std::vector<std::string> overrides = {"GIT_OPTIONAL_LOCKS=0", "GIT_TERMINAL_PROMPT=0",
                                        "LC_ALL=C"};
  overrides.insert(overrides.end(), askpassEnv.begin(), askpassEnv.end());
  overrides.insert(overrides.end(), opts.extraEnv.begin(), opts.extraEnv.end());
  return overrides;
}

#ifndef _WIN32
// Creates a pipe whose two ends close on exec, so no child ever inherits them:
// not git (posix_spawn's dup2 onto fds 1 and 2 gives it the copies it needs),
// not the hooks and helpers git starts, and not a concurrent spawn on another
// thread. An inherited write end keeps the read side from seeing EOF for as
// long as its holder lives, which a helper left running in the background (a
// hook's watcher, a detached auto-gc) can make minutes. Returns false when
// the pipe cannot be created.
bool makeCloexecPipe(int fds[2]);
#endif

// A spawned `git` child process. Stdout is line-buffered for parsing; stderr
// is captured for error reporting. Cancellation stops the whole process
// group (SIGTERM, then SIGKILL after kTerminateGrace), so a blame of a huge
// file stops costing CPU the moment the client scrolls away. A child that
// outlives SpawnOpts::timeout is stopped the same way and reported through
// timedOut(); time spent waiting on a credential prompt does not count.
// While an askpass broker is installed, git, ssh and gpg prompts go to the
// client (see exec/askpass.h).
class GitProcess {
 public:
  // Spawns `git <args...>` with `cwd` as working directory and the
  // environment childEnvOverrides() describes. The child reads stdin from the
  // null device, inherits no descriptor beyond its three standard ones, and on
  // POSIX runs in a session of its own with no controlling terminal. Fails
  // with ErrorCode::Restricted, spawning nothing, in Restricted Mode.
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

  // True when the timeout killed the child. Output read before that point is
  // whatever git had produced, so callers must treat the run as failed rather
  // than parse a truncated stream.
  bool timedOut() const { return timedOut_; }

  // The configured ceiling, for error messages.
  std::chrono::milliseconds timeout() const { return timeout_; }

  // True when the user dismissed a prompt this git raised.
  bool promptDeclined() const { return promptStats_ && promptStats_->declined.load(); }

 private:
  GitProcess() = default;

  bool fillBuffer(const CancelToken& token);  // false on stdout EOF
  void drainStderr(bool blocking);
  void killGroup();

  // Kills the process group once the deadline has passed, latching timedOut_.
  // Called from every loop that waits on the child. The deadline moves by
  // the time the user spent on prompts, and never passes while one is open.
  bool expired() {
    if (timedOut_) return true;
    const auto now = std::chrono::steady_clock::now();
    if (now < deadline_) return false;
    if (promptStats_) {
      if (promptStats_->open.load() > 0) return false;
      if (now < deadline_ + std::chrono::milliseconds(promptStats_->millis.load())) return false;
    }
    timedOut_ = true;
    killGroup();
    return true;
  }

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
  std::chrono::milliseconds timeout_ = kDefaultGitTimeout;
  std::chrono::steady_clock::time_point deadline_ = std::chrono::steady_clock::time_point::max();
  bool timedOut_ = false;
  // Prompts this invocation raises are answered through this session; null
  // when no askpass broker is installed.
  std::shared_ptr<AskpassSession> askpass_;
  std::shared_ptr<const AskpassPromptStats> promptStats_;
};

}  // namespace gg::exec
