#include "exec/git_process.h"

#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <spawn.h>
#include <sys/wait.h>
#include <unistd.h>

#include <cerrno>
#include <cstring>

extern char** environ;

namespace gg::exec {

namespace {

constexpr int kPollIntervalMs = 50;

struct SpawnActions {
  posix_spawn_file_actions_t actions;
  SpawnActions() { posix_spawn_file_actions_init(&actions); }
  ~SpawnActions() { posix_spawn_file_actions_destroy(&actions); }
};

struct SpawnAttr {
  posix_spawnattr_t attr;
  SpawnAttr() { posix_spawnattr_init(&attr); }
  ~SpawnAttr() { posix_spawnattr_destroy(&attr); }
};

}  // namespace

Result<GitProcess> GitProcess::spawn(const std::string& cwd, std::vector<std::string> args) {
  int outPipe[2], errPipe[2];
  if (pipe(outPipe) != 0) return Error{ErrorCode::Internal, "pipe() failed"};
  if (pipe(errPipe) != 0) {
    close(outPipe[0]);
    close(outPipe[1]);
    return Error{ErrorCode::Internal, "pipe() failed"};
  }

  SpawnActions fileActions;
  posix_spawn_file_actions_addopen(&fileActions.actions, STDIN_FILENO, "/dev/null", O_RDONLY, 0);
  posix_spawn_file_actions_adddup2(&fileActions.actions, outPipe[1], STDOUT_FILENO);
  posix_spawn_file_actions_adddup2(&fileActions.actions, errPipe[1], STDERR_FILENO);
  posix_spawn_file_actions_addclose(&fileActions.actions, outPipe[0]);
  posix_spawn_file_actions_addclose(&fileActions.actions, errPipe[0]);
  // Own process group so cancellation can kill git and any children it forks.
  SpawnAttr attr;
  posix_spawnattr_setflags(&attr.attr, POSIX_SPAWN_SETPGROUP);
  posix_spawnattr_setpgroup(&attr.attr, 0);

  std::vector<std::string> fullArgs;
  fullArgs.reserve(args.size() + 1);
  // -C replaces posix_spawn_file_actions_addchdir_np (glibc >= 2.29 only).
  fullArgs.push_back("git");
  fullArgs.push_back("-C");
  fullArgs.push_back(cwd);
  for (auto& a : args) fullArgs.push_back(std::move(a));

  std::vector<char*> argv;
  argv.reserve(fullArgs.size() + 1);
  for (auto& a : fullArgs) argv.push_back(a.data());
  argv.push_back(nullptr);

  // Scrubbed additions applied on top of the inherited environment: stable
  // parse output, no lock contention with the user's own git commands, and
  // never a hung child waiting for a credential prompt.
  std::vector<std::string> extraEnv = {"GIT_OPTIONAL_LOCKS=0", "GIT_TERMINAL_PROMPT=0",
                                       "LC_ALL=C"};
  std::vector<char*> envp;
  for (char** e = environ; *e; ++e) envp.push_back(*e);
  for (auto& e : extraEnv) envp.push_back(e.data());
  envp.push_back(nullptr);

  pid_t pid = -1;
  int rc = posix_spawnp(&pid, "git", &fileActions.actions, &attr.attr, argv.data(), envp.data());
  close(outPipe[1]);
  close(errPipe[1]);
  if (rc != 0) {
    close(outPipe[0]);
    close(errPipe[0]);
    return Error{ErrorCode::Internal, std::string("failed to spawn git: ") + std::strerror(rc)};
  }

  GitProcess process;
  process.pid_ = pid;
  process.stdoutFd_ = outPipe[0];
  process.stderrFd_ = errPipe[0];
  fcntl(process.stdoutFd_, F_SETFL, O_NONBLOCK);
  fcntl(process.stderrFd_, F_SETFL, O_NONBLOCK);
  return process;
}

GitProcess::GitProcess(GitProcess&& other) noexcept
    : pid_(other.pid_),
      stdoutFd_(other.stdoutFd_),
      stderrFd_(other.stderrFd_),
      buffer_(std::move(other.buffer_)),
      bufferPos_(other.bufferPos_),
      eof_(other.eof_),
      stderr_(std::move(other.stderr_)),
      reaped_(other.reaped_),
      exitCode_(other.exitCode_) {
  other.pid_ = -1;
  other.stdoutFd_ = -1;
  other.stderrFd_ = -1;
  other.reaped_ = true;
}

GitProcess::~GitProcess() {
  if (pid_ != -1 && !reaped_) {
    killGroup();
    waitpid(pid_, nullptr, 0);
  }
  if (stdoutFd_ != -1) close(stdoutFd_);
  if (stderrFd_ != -1) close(stderrFd_);
}

void GitProcess::killGroup() {
  if (pid_ != -1) kill(-pid_, SIGKILL);
}

void GitProcess::drainStderr(bool blocking) {
  char chunk[4096];
  for (;;) {
    ssize_t n = read(stderrFd_, chunk, sizeof(chunk));
    if (n > 0) {
      stderr_.append(chunk, static_cast<size_t>(n));
      continue;
    }
    if (n < 0 && errno == EAGAIN && blocking) {
      pollfd pfd{stderrFd_, POLLIN, 0};
      if (poll(&pfd, 1, kPollIntervalMs) > 0) continue;
    }
    return;
  }
}

bool GitProcess::fillBuffer(const CancelToken& token) {
  if (eof_) return false;
  for (;;) {
    if (token.cancelled()) {
      killGroup();
      throw CancelledError();
    }
    char chunk[65536];
    ssize_t n = read(stdoutFd_, chunk, sizeof(chunk));
    if (n > 0) {
      buffer_.append(chunk, static_cast<size_t>(n));
      return true;
    }
    if (n == 0) {
      eof_ = true;
      return false;
    }
    if (errno != EAGAIN && errno != EINTR) {
      eof_ = true;
      return false;
    }
    drainStderr(/*blocking=*/false);
    pollfd pfd{stdoutFd_, POLLIN, 0};
    poll(&pfd, 1, kPollIntervalMs);
  }
}

bool GitProcess::readLine(std::string& out, const CancelToken& token) {
  for (;;) {
    size_t newline = buffer_.find('\n', bufferPos_);
    if (newline != std::string::npos) {
      out.assign(buffer_, bufferPos_, newline - bufferPos_);
      bufferPos_ = newline + 1;
      // Compact once the consumed prefix dominates the buffer.
      if (bufferPos_ > 1 << 20 && bufferPos_ > buffer_.size() / 2) {
        buffer_.erase(0, bufferPos_);
        bufferPos_ = 0;
      }
      return true;
    }
    if (!fillBuffer(token)) {
      if (bufferPos_ < buffer_.size()) {  // final line without trailing newline
        out.assign(buffer_, bufferPos_, buffer_.size() - bufferPos_);
        bufferPos_ = buffer_.size();
        return true;
      }
      return false;
    }
  }
}

int GitProcess::wait(const CancelToken& token) {
  if (reaped_) return exitCode_;
  for (;;) {
    if (token.cancelled()) {
      killGroup();
      waitpid(pid_, nullptr, 0);
      reaped_ = true;
      throw CancelledError();
    }
    drainStderr(/*blocking=*/false);
    int status = 0;
    pid_t done = waitpid(pid_, &status, WNOHANG);
    if (done == pid_) {
      drainStderr(/*blocking=*/false);
      exitCode_ = WIFEXITED(status) ? WEXITSTATUS(status) : -WTERMSIG(status);
      reaped_ = true;
      return exitCode_;
    }
    pollfd pfd{stderrFd_, POLLIN, 0};
    poll(&pfd, 1, kPollIntervalMs);
  }
}

}  // namespace gg::exec
