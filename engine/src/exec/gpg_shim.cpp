// gpg.program shim: git runs it in place of gpg to sign a commit. It runs
// the real gpg unchanged first, so a key the agent has unlocked, or a
// graphical pinentry, signs exactly as before. Only when gpg could not ask
// for the passphrase (a terminal-only pinentry with no terminal) does it ask
// through the askpass broker and run gpg again with the passphrase on a
// private pipe through gpg's loopback pinentry. The passphrase never reaches
// argv, the environment or a file.

#include <cstdlib>
#include <cstring>
#include <optional>
#include <string>
#include <vector>

#include "exec/askpass.h"

#ifndef _WIN32
#include <fcntl.h>
#include <poll.h>
#include <spawn.h>
#include <sys/wait.h>
#include <unistd.h>

#include <cerrno>
#include <csignal>

extern char** environ;
#endif

namespace gg::exec {

#ifdef _WIN32

// Windows gpg (Gpg4win) brings a graphical pinentry, and the engine does not
// install this shim there.
std::optional<int> maybeRunGpgShim(int, char**) { return std::nullopt; }

#else

namespace {

// Attempts at the passphrase before giving up, like pinentry's own retries.
constexpr int kPassphraseAttempts = 3;

struct GpgRun {
  int exitCode = 2;
  std::string out;
  std::string err;
};

bool contains(const std::string& text, const char* needle) {
  return text.find(needle) != std::string::npos;
}

// gpg failed because its pinentry could not ask: no terminal for a curses
// pinentry, no display for a graphical one, or none installed.
bool couldNotAskForPassphrase(const std::string& err) {
  return contains(err, "Inappropriate ioctl for device") || contains(err, "No pinentry") ||
         contains(err, "Operation cancelled") || contains(err, "No such device or address") ||
         contains(err, "cannot open '/dev/tty'") || contains(err, "pinentry");
}

bool badPassphrase(const std::string& err) {
  return contains(err, "Bad passphrase") || contains(err, "bad passphrase");
}

std::string readAllStdin() {
  std::string data;
  char buffer[65536];
  for (;;) {
    const ssize_t n = ::read(STDIN_FILENO, buffer, sizeof(buffer));
    if (n < 0 && errno == EINTR) continue;
    if (n <= 0) break;
    data.append(buffer, static_cast<size_t>(n));
  }
  return data;
}

void writeAll(int fd, const std::string& data) {
  size_t written = 0;
  while (written < data.size()) {
    const ssize_t n = ::write(fd, data.data() + written, data.size() - written);
    if (n < 0 && errno == EINTR) continue;
    if (n <= 0) return;
    written += static_cast<size_t>(n);
  }
}

// The environment minus GPG_TTY: a terminal pinentry then fails at once
// rather than drawing on a terminal the user is not looking at, and the
// passphrase is asked for in the editor instead.
std::vector<std::string> gpgEnvironment() {
  std::vector<std::string> env;
  for (char** e = environ; *e; ++e) {
    if (std::strncmp(*e, "GPG_TTY=", 8) == 0) continue;
    env.emplace_back(*e);
  }
  return env;
}

// Runs gpg with `input` on stdin and, when given, `passphrase` on fd 3,
// collecting stdout and stderr.
GpgRun runGpg(const std::string& program, const std::vector<std::string>& args,
              const std::string& input, const std::optional<std::string>& passphrase) {
  GpgRun run;
  int in[2], out[2], err[2], pass[2] = {-1, -1};
  if (pipe(in) != 0 || pipe(out) != 0 || pipe(err) != 0 || (passphrase && pipe(pass) != 0)) {
    run.err = "gpg shim: pipe() failed\n";
    return run;
  }
  for (int fd : {in[1], out[0], err[0], pass[1]}) {
    if (fd >= 0) fcntl(fd, F_SETFD, FD_CLOEXEC);
  }

  posix_spawn_file_actions_t actions;
  posix_spawn_file_actions_init(&actions);
  posix_spawn_file_actions_adddup2(&actions, in[0], STDIN_FILENO);
  posix_spawn_file_actions_adddup2(&actions, out[1], STDOUT_FILENO);
  posix_spawn_file_actions_adddup2(&actions, err[1], STDERR_FILENO);
  if (passphrase) posix_spawn_file_actions_adddup2(&actions, pass[0], 3);

  std::vector<std::string> argvStrings = {program};
  argvStrings.insert(argvStrings.end(), args.begin(), args.end());
  std::vector<char*> argv;
  for (auto& arg : argvStrings) argv.push_back(arg.data());
  argv.push_back(nullptr);
  std::vector<std::string> envStrings = gpgEnvironment();
  std::vector<char*> envp;
  for (auto& entry : envStrings) envp.push_back(entry.data());
  envp.push_back(nullptr);

  pid_t pid = -1;
  const int rc = posix_spawnp(&pid, program.c_str(), &actions, nullptr, argv.data(), envp.data());
  posix_spawn_file_actions_destroy(&actions);
  for (int fd : {in[0], out[1], err[1], pass[0]}) {
    if (fd >= 0) ::close(fd);
  }
  if (rc != 0) {
    for (int fd : {in[1], out[0], err[0], pass[1]}) {
      if (fd >= 0) ::close(fd);
    }
    run.err = "gpg shim: cannot run '" + program + "': " + std::strerror(rc) + "\n";
    return run;
  }

  if (passphrase) {
    // A line on a pipe of its own; far below the pipe buffer, so this never
    // blocks on gpg.
    writeAll(pass[1], *passphrase + "\n");
    ::close(pass[1]);
  }

  // Feeds stdin while draining stdout and stderr, so a large payload and a
  // chatty gpg cannot block each other.
  size_t fed = 0;
  int inFd = in[1];
  if (input.empty()) {
    ::close(inFd);
    inFd = -1;
  } else {
    fcntl(inFd, F_SETFL, O_NONBLOCK);
  }
  int outFd = out[0];
  int errFd = err[0];
  char buffer[65536];
  while (outFd >= 0 || errFd >= 0) {
    pollfd fds[3];
    nfds_t count = 0;
    int inSlot = -1, outSlot = -1, errSlot = -1;
    if (inFd >= 0) {
      inSlot = static_cast<int>(count);
      fds[count++] = {inFd, POLLOUT, 0};
    }
    if (outFd >= 0) {
      outSlot = static_cast<int>(count);
      fds[count++] = {outFd, POLLIN, 0};
    }
    if (errFd >= 0) {
      errSlot = static_cast<int>(count);
      fds[count++] = {errFd, POLLIN, 0};
    }
    if (poll(fds, count, -1) < 0) {
      if (errno == EINTR) continue;
      break;
    }
    if (inSlot >= 0 && fds[inSlot].revents) {
      const ssize_t n = ::write(inFd, input.data() + fed, input.size() - fed);
      if (n > 0) fed += static_cast<size_t>(n);
      if ((n < 0 && errno != EAGAIN && errno != EINTR) || fed == input.size()) {
        ::close(inFd);
        inFd = -1;
      }
    }
    const auto drain = [&buffer](int& fd, std::string& sink) {
      const ssize_t n = ::read(fd, buffer, sizeof(buffer));
      if (n > 0) {
        sink.append(buffer, static_cast<size_t>(n));
      } else if (n == 0 || (errno != EAGAIN && errno != EINTR)) {
        ::close(fd);
        fd = -1;
      }
    };
    if (outSlot >= 0 && fds[outSlot].revents) drain(outFd, run.out);
    if (errSlot >= 0 && fds[errSlot].revents) drain(errFd, run.err);
  }
  if (inFd >= 0) ::close(inFd);
  int status = 0;
  while (waitpid(pid, &status, 0) < 0 && errno == EINTR) {
  }
  run.exitCode = WIFEXITED(status) ? WEXITSTATUS(status) : 2;
  return run;
}

int finish(const GpgRun& run) {
  writeAll(STDOUT_FILENO, run.out);
  writeAll(STDERR_FILENO, run.err);
  return run.exitCode;
}

}  // namespace

std::optional<int> maybeRunGpgShim(int argc, char** argv) {
  const char* program = std::getenv(kGpgProgramVar);
  if (!program || !*program) return std::nullopt;
  // git always passes --status-fd to gpg.program; the engine's own command
  // lines never do.
  std::vector<std::string> args;
  bool statusFd = false;
  bool signing = false;
  std::string key;
  for (int i = 1; i < argc; ++i) {
    const std::string arg = argv[i];
    if (arg.rfind("--status-fd", 0) == 0) statusFd = true;
    if (arg == "-bsau") {
      signing = true;
      if (i + 1 < argc) key = argv[i + 1];
    }
    args.push_back(arg);
  }
  if (!statusFd) return std::nullopt;

  if (!signing) {
    // Verification and anything else: the real gpg, untouched.
    std::vector<char*> execArgv;
    std::string programArg = program;
    execArgv.push_back(programArg.data());
    for (auto& arg : args) execArgv.push_back(arg.data());
    execArgv.push_back(nullptr);
    execvp(program, execArgv.data());
    const std::string message =
        std::string("gpg shim: cannot run '") + program + "': " + std::strerror(errno) + "\n";
    writeAll(STDERR_FILENO, message);
    return 2;
  }

  // gpg may close its stdin early; a write that fails then must not kill the
  // shim before it reports gpg's answer.
  std::signal(SIGPIPE, SIG_IGN);
  const std::string payload = readAllStdin();
  const GpgRun first = runGpg(program, args, payload, std::nullopt);
  if (first.exitCode == 0 || !couldNotAskForPassphrase(first.err)) return finish(first);

  std::vector<std::string> loopbackArgs = {"--pinentry-mode", "loopback", "--passphrase-fd", "3"};
  loopbackArgs.insert(loopbackArgs.end(), args.begin(), args.end());
  GpgRun last = first;
  for (int attempt = 0; attempt < kPassphraseAttempts; ++attempt) {
    std::string prompt =
        attempt == 0
            ? "Passphrase for the OpenPGP key " + key + " (commit signing)"
            : "Bad passphrase. Passphrase for the OpenPGP key " + key + " (commit signing)";
    const auto passphrase = askThroughBroker("gpg", prompt);
    // Dismissed: report gpg's own failure, which says why it could not ask.
    if (!passphrase) return finish(first);
    last = runGpg(program, loopbackArgs, payload, *passphrase);
    if (last.exitCode == 0 || !badPassphrase(last.err)) return finish(last);
  }
  return finish(last);
}

#endif  // _WIN32

}  // namespace gg::exec
