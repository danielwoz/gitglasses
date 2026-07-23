#include "services/mutate/mutate_common.h"

#include <fcntl.h>
#include <git2.h>
#include <poll.h>
#include <signal.h>
#include <spawn.h>
#include <sys/wait.h>
#include <unistd.h>

#include <cerrno>
#include <cstring>
#include <filesystem>

#include "exec/git_process.h"

extern char** environ;

namespace gg::services::mutate_detail {

namespace {

std::vector<std::string> splitLines(const std::string& text) {
  std::vector<std::string> lines;
  size_t pos = 0;
  while (pos < text.size()) {
    const size_t eol = text.find('\n', pos);
    if (eol == std::string::npos) {
      lines.push_back(text.substr(pos));
      break;
    }
    std::string line = text.substr(pos, eol - pos);
    if (!line.empty() && line.back() == '\r') line.pop_back();
    lines.push_back(std::move(line));
    pos = eol + 1;
  }
  return lines;
}

}  // namespace

std::string repoCwd(const core::Repo& repo) {
  return repo.workdir().empty() ? repo.gitdir() : repo.workdir();
}

Result<GitOutput> runGit(const core::Repo& repo, std::vector<std::string> args,
                         const CancelToken& token) {
  auto process = exec::GitProcess::spawn(repoCwd(repo), std::move(args));
  if (!process) return process.error();
  GitOutput output;
  std::string line;
  while (process.value().readLine(line, token)) output.lines.push_back(line);
  output.exitCode = process.value().wait(token);
  output.stderrText = process.value().stderrOutput();
  return output;
}

Result<GitOutput> runGitWithEnv(const std::string& cwd, std::vector<std::string> args,
                                const std::vector<std::pair<std::string, std::string>>& extraEnv,
                                const CancelToken& token) {
  int outPipe[2], errPipe[2];
  if (pipe(outPipe) != 0) return Error{ErrorCode::Internal, "pipe() failed"};
  if (pipe(errPipe) != 0) {
    close(outPipe[0]);
    close(outPipe[1]);
    return Error{ErrorCode::Internal, "pipe() failed"};
  }

  posix_spawn_file_actions_t actions;
  posix_spawn_file_actions_init(&actions);
  posix_spawn_file_actions_addopen(&actions, STDIN_FILENO, "/dev/null", O_RDONLY, 0);
  posix_spawn_file_actions_adddup2(&actions, outPipe[1], STDOUT_FILENO);
  posix_spawn_file_actions_adddup2(&actions, errPipe[1], STDERR_FILENO);
  posix_spawn_file_actions_addclose(&actions, outPipe[0]);
  posix_spawn_file_actions_addclose(&actions, errPipe[0]);
  // Own process group so cancellation kills git and any editors it forks.
  posix_spawnattr_t attr;
  posix_spawnattr_init(&attr);
  posix_spawnattr_setflags(&attr, POSIX_SPAWN_SETPGROUP);
  posix_spawnattr_setpgroup(&attr, 0);

  std::vector<std::string> fullArgs;
  fullArgs.reserve(args.size() + 1);
  fullArgs.push_back("git");
  fullArgs.push_back("-C");
  fullArgs.push_back(cwd);
  for (auto& arg : args) fullArgs.push_back(std::move(arg));
  std::vector<char*> argv;
  argv.reserve(fullArgs.size() + 1);
  for (auto& arg : fullArgs) argv.push_back(arg.data());
  argv.push_back(nullptr);

  // Overrides must replace inherited entries of the same name: with
  // duplicates in envp, which copy wins is unspecified.
  std::vector<std::pair<std::string, std::string>> overrides = {
      {"GIT_OPTIONAL_LOCKS", "0"}, {"GIT_TERMINAL_PROMPT", "0"}, {"LC_ALL", "C"}};
  overrides.insert(overrides.end(), extraEnv.begin(), extraEnv.end());
  const auto overridden = [&overrides](const char* entry) {
    for (const auto& [name, value] : overrides) {
      (void)value;
      if (std::strncmp(entry, name.c_str(), name.size()) == 0 && entry[name.size()] == '=') {
        return true;
      }
    }
    return false;
  };
  std::vector<std::string> envStrings;
  for (char** e = environ; *e; ++e) {
    if (!overridden(*e)) envStrings.emplace_back(*e);
  }
  for (const auto& [name, value] : overrides) envStrings.push_back(name + "=" + value);
  std::vector<char*> envp;
  envp.reserve(envStrings.size() + 1);
  for (auto& entry : envStrings) envp.push_back(entry.data());
  envp.push_back(nullptr);

  pid_t pid = -1;
  const int rc = posix_spawnp(&pid, "git", &actions, &attr, argv.data(), envp.data());
  posix_spawn_file_actions_destroy(&actions);
  posix_spawnattr_destroy(&attr);
  close(outPipe[1]);
  close(errPipe[1]);
  if (rc != 0) {
    close(outPipe[0]);
    close(errPipe[0]);
    return Error{ErrorCode::Internal, std::string("failed to spawn git: ") + std::strerror(rc)};
  }
  fcntl(outPipe[0], F_SETFL, O_NONBLOCK);
  fcntl(errPipe[0], F_SETFL, O_NONBLOCK);

  std::string outText, errText;
  bool outOpen = true, errOpen = true;
  const auto drain = [](int fd, std::string& sink, bool& open) {
    char chunk[65536];
    for (;;) {
      const ssize_t n = read(fd, chunk, sizeof(chunk));
      if (n > 0) {
        sink.append(chunk, static_cast<size_t>(n));
        continue;
      }
      if (n == 0) open = false;
      return;
    }
  };
  while (outOpen || errOpen) {
    if (token.cancelled()) {
      kill(-pid, SIGKILL);
      waitpid(pid, nullptr, 0);
      close(outPipe[0]);
      close(errPipe[0]);
      throw CancelledError();
    }
    pollfd fds[2] = {{outPipe[0], POLLIN, 0}, {errPipe[0], POLLIN, 0}};
    poll(fds, 2, 50);
    if (outOpen) drain(outPipe[0], outText, outOpen);
    if (errOpen) drain(errPipe[0], errText, errOpen);
  }
  close(outPipe[0]);
  close(errPipe[0]);

  int status = 0;
  for (;;) {
    if (token.cancelled()) {
      kill(-pid, SIGKILL);
      waitpid(pid, nullptr, 0);
      throw CancelledError();
    }
    const pid_t done = waitpid(pid, &status, WNOHANG);
    if (done == pid) break;
    if (done < 0 && errno != EINTR) {
      return Error{ErrorCode::Internal, "waitpid() failed for git child"};
    }
    poll(nullptr, 0, 20);
  }

  GitOutput output;
  output.exitCode = WIFEXITED(status) ? WEXITSTATUS(status) : -WTERMSIG(status);
  output.lines = splitLines(outText);
  output.stderrText = std::move(errText);
  return output;
}

GitOutput runGitOrThrow(const core::Repo& repo, std::vector<std::string> args,
                        const CancelToken& token, const std::string& what) {
  auto output = runGit(repo, std::move(args), token);
  if (!output) throw rpc::HandlerError{{output.error()}};
  if (output.value().exitCode != 0) {
    throw rpc::HandlerError{{ErrorCode::GitError,
                             what + " failed (" + std::to_string(output.value().exitCode) +
                                 "): " + output.value().stderrText}};
  }
  return std::move(output.value());
}

rpc::Json runConflictAware(const core::Repo& repo, std::vector<std::string> args,
                           const CancelToken& token, const std::string& what) {
  auto output = runGit(repo, std::move(args), token);
  if (!output) throw rpc::HandlerError{{output.error()}};
  if (output.value().exitCode == 0) return {{"conflicts", false}};
  if (inConflictState(repo)) return {{"conflicts", true}};
  throw rpc::HandlerError{{ErrorCode::GitError,
                           what + " failed (" + std::to_string(output.value().exitCode) +
                               "): " + output.value().stderrText}};
}

bool rebaseInProgress(const core::Repo& repo) {
  namespace fs = std::filesystem;
  const fs::path gitdir(repo.gitdir());
  std::error_code ec;
  return fs::exists(gitdir / "rebase-merge", ec) || fs::exists(gitdir / "rebase-apply", ec);
}

bool inConflictState(const core::Repo& repo) {
  namespace fs = std::filesystem;
  const fs::path gitdir(repo.gitdir());
  std::error_code ec;
  for (const char* marker : {"MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD"}) {
    if (fs::exists(gitdir / marker, ec)) return true;
  }
  if (rebaseInProgress(repo)) return true;
  git_index* rawIndex = nullptr;
  if (git_repository_index(&rawIndex, repo.raw()) != 0) return false;
  const bool conflicts = git_index_has_conflicts(rawIndex) != 0;
  git_index_free(rawIndex);
  return conflicts;
}

core::Repo openRepo(ServiceContext& context, const rpc::Json& params) {
  auto repo = context.registry.open(params.value("repoId", ""));
  if (!repo) throw rpc::HandlerError{{repo.error()}};
  return std::move(repo).value();
}

std::string headSha(const core::Repo& repo, const CancelToken& token) {
  auto output = runGitOrThrow(repo, {"rev-parse", "HEAD"}, token, "git rev-parse HEAD");
  if (output.lines.empty()) {
    throw rpc::HandlerError{{ErrorCode::GitError, "git rev-parse HEAD produced no output"}};
  }
  return output.lines.front();
}

std::string requireString(const rpc::Json& params, const char* key) {
  const std::string value = params.value(key, "");
  if (value.empty()) {
    throw rpc::HandlerError{
        {ErrorCode::InvalidParams, std::string("'") + key + "' is required"}};
  }
  return value;
}

std::vector<std::string> requireStringArray(const rpc::Json& params, const char* key) {
  if (!params.contains(key) || !params[key].is_array() || params[key].empty()) {
    throw rpc::HandlerError{{ErrorCode::InvalidParams,
                             std::string("'") + key + "' must be a non-empty array"}};
  }
  std::vector<std::string> values;
  for (const auto& entry : params[key]) {
    if (!entry.is_string() || entry.get<std::string>().empty()) {
      throw rpc::HandlerError{{ErrorCode::InvalidParams,
                               std::string("'") + key + "' entries must be non-empty strings"}};
    }
    values.push_back(entry.get<std::string>());
  }
  return values;
}

}  // namespace gg::services::mutate_detail
