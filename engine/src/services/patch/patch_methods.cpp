#include "services/patch/patch_methods.h"

#include <fcntl.h>
#include <git2.h>
#include <poll.h>
#include <signal.h>
#include <spawn.h>
#include <sys/wait.h>
#include <unistd.h>

#include <cerrno>
#include <chrono>
#include <cstring>
#include <ctime>
#include <filesystem>
#include <memory>
#include <optional>
#include <string>
#include <utility>
#include <vector>

#include "services/mutate/mutate_common.h"
#include "util/sha256.h"

extern char** environ;

namespace gg::services {

namespace {

using mutate_detail::headSha;
using mutate_detail::openRepo;
using mutate_detail::repoCwd;
using mutate_detail::requireString;
using mutate_detail::runGit;
using mutate_detail::runGitOrThrow;

Error patchGitError(const std::string& context) {
  const git_error* err = git_error_last();
  const std::string detail = err && err->message ? err->message : "unknown libgit2 error";
  return {ErrorCode::GitError, context + ": " + detail};
}

// Captured `git` invocation whose stdout is kept byte-exact. Patch text must
// survive round-trips unchanged (CR characters, exact trailing newlines), so
// the line-splitting runners in mutate_common are not usable here.
struct RawGitOutput {
  int exitCode = -1;
  std::string stdoutText;
  std::string stderrText;
};

Result<RawGitOutput> runGitRaw(const core::Repo& repo, std::vector<std::string> args,
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
  const std::string cwd = repoCwd(repo);
  // Own process group so cancellation kills git and anything it forks.
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

  // Same non-interactive environment scrub as the other git runners; the
  // overrides replace inherited entries of the same name.
  const std::vector<std::pair<std::string, std::string>> overrides = {
      {"GIT_OPTIONAL_LOCKS", "0"}, {"GIT_TERMINAL_PROMPT", "0"}, {"LC_ALL", "C"}};
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

  RawGitOutput output;
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
    if (outOpen) drain(outPipe[0], output.stdoutText, outOpen);
    if (errOpen) drain(errPipe[0], output.stderrText, errOpen);
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
  output.exitCode = WIFEXITED(status) ? WEXITSTATUS(status) : -WTERMSIG(status);
  return output;
}

RawGitOutput runGitRawOrThrow(const core::Repo& repo, std::vector<std::string> args,
                              const CancelToken& token, const std::string& what) {
  auto output = runGitRaw(repo, std::move(args), token);
  if (!output) throw rpc::HandlerError{{output.error()}};
  if (output.value().exitCode != 0) {
    throw rpc::HandlerError{{ErrorCode::GitError,
                             what + " failed (" + std::to_string(output.value().exitCode) +
                                 "): " + output.value().stderrText}};
  }
  return std::move(output).value();
}

// Resolves `spec` to a full commit sha or throws GitError.
std::string resolveCommit(const core::Repo& repo, const std::string& spec,
                          const CancelToken& token) {
  auto output = runGitOrThrow(repo, {"rev-parse", "--verify", spec + "^{commit}"}, token,
                              "git rev-parse " + spec);
  if (output.lines.empty()) {
    throw rpc::HandlerError{{ErrorCode::GitError, "git rev-parse produced no output"}};
  }
  return output.lines.front();
}

// Subject line of a commit, used as the default envelope summary.
std::string commitSubject(const core::Repo& repo, const std::string& rev,
                          const CancelToken& token) {
  auto output =
      runGitOrThrow(repo, {"show", "-s", "--format=%s", rev}, token, "git show " + rev);
  return output.lines.empty() ? std::string() : output.lines.front();
}

// Current UTC time as ISO 8601 (second precision, Z suffix).
std::string isoUtcNow() {
  const std::time_t now =
      std::chrono::system_clock::to_time_t(std::chrono::system_clock::now());
  std::tm utc{};
  gmtime_r(&now, &utc);
  char buffer[32];
  std::strftime(buffer, sizeof(buffer), "%Y-%m-%dT%H:%M:%SZ", &utc);
  return buffer;
}

// First 16 hex chars of the SHA-256 of origin's fetch URL, when origin exists.
std::optional<std::string> originFingerprint(git_repository* raw) {
  git_remote* rawRemote = nullptr;
  if (git_remote_lookup(&rawRemote, raw, "origin") != 0) return std::nullopt;
  std::unique_ptr<git_remote, decltype(&git_remote_free)> remote(rawRemote, git_remote_free);
  const char* url = git_remote_url(remote.get());
  if (!url || !*url) return std::nullopt;
  return util::sha256Hex(url).substr(0, 16);
}

// Diff of HEAD against the working tree. Untracked files are appended as
// new-file diffs via `git diff --no-index /dev/null <path>` (git normalizes
// the null side to a/b-prefixed new-file headers); `git add -N` would get the
// same effect but mutates the index, which a create call must never do.
std::string wipPatchText(const core::Repo& repo, bool includeUntracked,
                         const CancelToken& token) {
  std::string patch =
      runGitRawOrThrow(repo, {"diff", "HEAD"}, token, "git diff HEAD").stdoutText;
  if (!includeUntracked) return patch;

  const RawGitOutput listed =
      runGitRawOrThrow(repo, {"ls-files", "--others", "--exclude-standard", "-z"}, token,
                       "git ls-files");
  size_t pos = 0;
  while (pos < listed.stdoutText.size()) {
    const size_t end = listed.stdoutText.find('\0', pos);
    const std::string path =
        listed.stdoutText.substr(pos, end == std::string::npos ? end : end - pos);
    pos = end == std::string::npos ? listed.stdoutText.size() : end + 1;
    if (path.empty()) continue;
    // Exits 1 when the file has content (the sides differ); only other exit
    // codes are real failures.
    auto output = runGitRaw(repo, {"diff", "--no-index", "--", "/dev/null", path}, token);
    if (!output) throw rpc::HandlerError{{output.error()}};
    if (output.value().exitCode != 0 && output.value().exitCode != 1) {
      throw rpc::HandlerError{{ErrorCode::GitError,
                               "git diff --no-index failed for '" + path +
                                   "': " + output.value().stderrText}};
    }
    patch += output.value().stdoutText;
  }
  return patch;
}

struct EnvelopeSource {
  std::string baseSha;
  std::string patch;
  std::string summary;
  std::optional<std::string> branch;
};

// Commit and range sources emit plain `git diff` output rather than
// format-patch: mail-style patches would need `git am` (which commits) on the
// receiving side, while a bare unified diff keeps patch/apply a single
// `git apply --3way` into the working tree. The commit message survives in
// the envelope summary instead.
EnvelopeSource buildSource(const core::Repo& repo, const rpc::Json& source,
                           const CancelToken& token) {
  const std::string kind = source.value("kind", "");
  EnvelopeSource built;

  if (kind == "wip") {
    built.baseSha = headSha(repo, token);
    auto head = repo.head();
    if (head && !head.value().detached && !head.value().branch.empty()) {
      built.branch = head.value().branch;
    }
    built.patch = wipPatchText(repo, source.value("includeUntracked", false), token);
    built.summary = built.branch ? "WIP on " + *built.branch : "WIP";
    return built;
  }

  if (kind == "stash") {
    if (!source.contains("index") || !source["index"].is_number_integer() ||
        source["index"].get<std::int64_t>() < 0) {
      throw rpc::HandlerError{
          {ErrorCode::InvalidParams, "'source.index' must be a non-negative integer"}};
    }
    const std::string ref = "stash@{" + std::to_string(source["index"].get<std::int64_t>()) + "}";
    // The stash's first parent is the commit the stash was taken on.
    auto parent = runGitOrThrow(repo, {"rev-parse", "--verify", ref + "^1"}, token,
                                "git rev-parse " + ref);
    if (parent.lines.empty()) {
      throw rpc::HandlerError{{ErrorCode::GitError, "git rev-parse produced no output"}};
    }
    built.baseSha = parent.lines.front();
    built.patch = runGitRawOrThrow(repo, {"stash", "show", "-p", "--include-untracked", ref},
                                   token, "git stash show")
                      .stdoutText;
    built.summary = commitSubject(repo, ref, token);
    return built;
  }

  if (kind == "commit") {
    const std::string sha = resolveCommit(repo, requireString(source, "sha"), token);
    auto parent = runGit(repo, {"rev-parse", "--verify", "--quiet", sha + "^"}, token);
    if (!parent) throw rpc::HandlerError{{parent.error()}};
    if (parent.value().exitCode == 0 && !parent.value().lines.empty()) {
      built.baseSha = parent.value().lines.front();
      built.patch =
          runGitRawOrThrow(repo, {"diff", built.baseSha, sha}, token, "git diff").stdoutText;
    } else {
      // Root commit: no parent exists, so the envelope records the commit
      // itself as base and the patch is the diff from the empty tree.
      built.baseSha = sha;
      auto emptyTree = runGitOrThrow(repo, {"hash-object", "-t", "tree", "/dev/null"}, token,
                                     "git hash-object");
      if (emptyTree.lines.empty()) {
        throw rpc::HandlerError{{ErrorCode::GitError, "git hash-object produced no output"}};
      }
      built.patch = runGitRawOrThrow(repo, {"diff", emptyTree.lines.front(), sha}, token,
                                     "git diff")
                        .stdoutText;
    }
    built.summary = commitSubject(repo, sha, token);
    return built;
  }

  if (kind == "range") {
    built.baseSha = resolveCommit(repo, requireString(source, "base"), token);
    const std::string head = resolveCommit(repo, requireString(source, "head"), token);
    built.patch =
        runGitRawOrThrow(repo, {"diff", built.baseSha, head}, token, "git diff").stdoutText;
    built.summary = commitSubject(repo, head, token);
    return built;
  }

  throw rpc::HandlerError{
      {ErrorCode::InvalidParams, "'source.kind' must be 'wip', 'stash', 'commit' or 'range'"}};
}

// Patch text written to a throwaway file, removed on scope exit (`git apply`
// takes file arguments, not stdin, through the process runner).
class TempPatchFile {
 public:
  explicit TempPatchFile(const std::string& contents) {
    std::string name =
        (std::filesystem::temp_directory_path() / "gitglasses-patch-XXXXXX").string();
    const int fd = mkstemp(name.data());
    if (fd < 0) {
      throw rpc::HandlerError{{ErrorCode::Internal, "failed to create temporary patch file"}};
    }
    size_t written = 0;
    while (written < contents.size()) {
      const ssize_t n = write(fd, contents.data() + written, contents.size() - written);
      if (n < 0) {
        close(fd);
        unlink(name.c_str());
        throw rpc::HandlerError{{ErrorCode::Internal, "failed to write temporary patch file"}};
      }
      written += static_cast<size_t>(n);
    }
    close(fd);
    path_ = std::move(name);
  }

  ~TempPatchFile() {
    if (!path_.empty()) unlink(path_.c_str());
  }

  TempPatchFile(const TempPatchFile&) = delete;
  TempPatchFile& operator=(const TempPatchFile&) = delete;

  const std::string& path() const { return path_; }

 private:
  std::string path_;
};

}  // namespace

void registerPatchMethods(rpc::Dispatcher& dispatcher, ServiceContext& context) {
  dispatcher.method(
      "remote/list",
      [&context](const rpc::Json& params, const CancelToken&, const rpc::NotifyFn&) -> rpc::Json {
        auto repo = openRepo(context, params);
        git_strarray names{};
        if (git_remote_list(&names, repo.raw()) != 0) {
          throw rpc::HandlerError{{patchGitError("list remotes")}};
        }
        rpc::Json remotes = rpc::Json::array();
        for (size_t i = 0; i < names.count; ++i) {
          git_remote* rawRemote = nullptr;
          if (git_remote_lookup(&rawRemote, repo.raw(), names.strings[i]) != 0) continue;
          std::unique_ptr<git_remote, decltype(&git_remote_free)> remote(rawRemote,
                                                                         git_remote_free);
          const char* fetchUrl = git_remote_url(remote.get());
          rpc::Json entry = {{"name", names.strings[i]},
                             {"fetchUrl", fetchUrl ? fetchUrl : ""}};
          if (const char* pushUrl = git_remote_pushurl(remote.get())) {
            entry["pushUrl"] = pushUrl;
          }
          remotes.push_back(std::move(entry));
        }
        git_strarray_dispose(&names);
        return {{"remotes", std::move(remotes)}};
      },
      rpc::Mode::Concurrent);

  dispatcher.method(
      "patch/create",
      [&context](const rpc::Json& params, const CancelToken& token,
                 const rpc::NotifyFn&) -> rpc::Json {
        requireGitCli(context);
        if (!params.contains("source") || !params["source"].is_object()) {
          throw rpc::HandlerError{{ErrorCode::InvalidParams, "'source' is required"}};
        }
        auto repo = openRepo(context, params);
        EnvelopeSource source = buildSource(repo, params["source"], token);
        if (source.patch.empty()) {
          throw rpc::HandlerError{{ErrorCode::GitError, "nothing to include in patch"}};
        }
        const std::string summaryOverride = params.value("summary", "");

        rpc::Json envelope = {{"format", "gitglasses-patch"},
                              {"version", 1},
                              {"baseSha", source.baseSha},
                              {"summary", summaryOverride.empty() ? source.summary
                                                                  : summaryOverride},
                              {"patch", std::move(source.patch)},
                              {"createdAtIso", isoUtcNow()}};
        if (source.branch) envelope["branch"] = *source.branch;
        if (auto fingerprint = originFingerprint(repo.raw())) {
          envelope["remoteFingerprint"] = *fingerprint;
        }
        return {{"envelope", std::move(envelope)}};
      },
      rpc::Mode::Concurrent);

  dispatcher.method(
      "patch/apply",
      [&context](const rpc::Json& params, const CancelToken& token,
                 const rpc::NotifyFn&) -> rpc::Json {
        requireGitCli(context);
        if (!params.contains("envelope") || !params["envelope"].is_object()) {
          throw rpc::HandlerError{{ErrorCode::InvalidParams, "'envelope' is required"}};
        }
        const rpc::Json& envelope = params["envelope"];
        if (envelope.value("format", "") != "gitglasses-patch" ||
            envelope.value("version", 0) != 1) {
          throw rpc::HandlerError{
              {ErrorCode::InvalidParams, "unsupported patch envelope format or version"}};
        }
        const std::string patch = envelope.value("patch", "");
        if (patch.empty()) {
          throw rpc::HandlerError{{ErrorCode::InvalidParams, "'envelope.patch' is required"}};
        }
        auto repo = openRepo(context, params);

        // Whether the envelope's base commit exists here; when it does, all
        // blobs the 3-way merge needs are reachable.
        bool baseFound = false;
        const std::string baseSha = envelope.value("baseSha", "");
        git_oid baseOid;
        if (!baseSha.empty() && git_oid_fromstr(&baseOid, baseSha.c_str()) == 0) {
          git_object* object = nullptr;
          if (git_object_lookup(&object, repo.raw(), &baseOid, GIT_OBJECT_ANY) == 0) {
            baseFound = true;
            git_object_free(object);
          }
        }

        TempPatchFile file(patch);
        auto output = runGit(repo, {"apply", "--3way", file.path()}, token);
        if (!output) throw rpc::HandlerError{{output.error()}};
        if (output.value().exitCode == 0) {
          return {{"applied", true}, {"conflicts", false}, {"baseFound", baseFound}};
        }
        // A nonzero exit still counts as applied when git stored conflicts:
        // `git apply --3way` leaves conflict markers in the working tree and
        // unmerged entries in the index, reporting "with conflicts" on stderr.
        auto unmerged = runGit(repo, {"ls-files", "-u"}, token);
        const bool conflicts =
            (unmerged && unmerged.value().exitCode == 0 && !unmerged.value().lines.empty()) ||
            output.value().stderrText.find("with conflicts") != std::string::npos;
        if (conflicts) {
          return {{"applied", true}, {"conflicts", true}, {"baseFound", baseFound}};
        }
        return {{"applied", false}, {"conflicts", false}, {"baseFound", baseFound}};
      },
      rpc::Mode::Serial);
}

}  // namespace gg::services
