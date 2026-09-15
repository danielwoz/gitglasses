#include "services/patch/patch_methods.h"

#include <git2.h>

#include <chrono>
#include <ctime>
#include <limits>
#include <memory>
#include <optional>
#include <string>
#include <utility>
#include <vector>

#include "core/git2.h"
#include "exec/git_runner.h"
#include "services/mutate/mutate_common.h"
#include "services/params.h"
#include "util/sha256.h"
#include "util/temp_file.h"

namespace gg::services {

namespace {

using mutate_detail::headSha;
using mutate_detail::openRepo;
using mutate_detail::repoCwd;
using mutate_detail::runGit;
using mutate_detail::requirePositional;
using mutate_detail::runGitOrThrow;

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
  exec::RunOpts opts;
  opts.rawOutput = true;
  RawGitOutput output;
  auto status = exec::runGit(repoCwd(repo), std::move(args), opts, token,
                             [&output](std::string bytes) {
                               output.stdoutText = std::move(bytes);
                             });
  if (!status) return status.error();
  output.exitCode = status.value().exitCode;
  output.stderrText = status.value().stderrText;
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
  // Concatenated into a rev-parse argument, so a leading '-' would survive as
  // an option ("--output=x" -> "--output=x^{commit}").
  requirePositional(spec, "sha");
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
#ifdef _WIN32
  gmtime_s(&utc, &now);
#else
  gmtime_r(&now, &utc);
#endif
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

// Diff of HEAD against the working tree, leaving the index untouched.
// Untracked files are appended as new-file diffs via `git diff --no-index
// /dev/null <path>`, which git normalizes to a/b-prefixed new-file headers.
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

// Builds the envelope's base, patch text and summary for one source kind.
// Every kind emits a bare unified diff, which patch/apply feeds to a single
// `git apply --3way` into the working tree; a commit's message travels in the
// envelope summary.
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
    const std::int64_t index =
        requireInteger(source, "index", 0, std::numeric_limits<std::int64_t>::max());
    const std::string ref = "stash@{" + std::to_string(index) + "}";
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
util::TempFile makeTempPatchFile(const std::string& contents) {
  auto file = util::TempFile::create(contents, "gitglasses-patch-");
  if (!file) {
    throw rpc::HandlerError{{ErrorCode::Internal, "failed to write temporary patch file"}};
  }
  return std::move(file).value();
}

}  // namespace

void registerPatchMethods(rpc::Dispatcher& dispatcher, ServiceContext& context) {
  dispatcher.method(
      "remote/list",
      [&context](const rpc::Json& params, const CancelToken&, const rpc::NotifyFn&) -> rpc::Json {
        auto repo = openRepo(context, params);
        git_strarray names{};
        if (git_remote_list(&names, repo.raw()) != 0) {
          throw rpc::HandlerError{{core::gitError("list remotes")}};
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
        const std::string summaryOverride = optionalString(params, "summary");
        auto repo = openRepo(context, params);
        EnvelopeSource source = buildSource(repo, params["source"], token);
        if (source.patch.empty()) {
          throw rpc::HandlerError{{ErrorCode::GitError, "nothing to include in patch"}};
        }

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

        const util::TempFile file = makeTempPatchFile(patch);
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
