#include "services/blame/blame_service.h"

#include <unistd.h>

#include <cstdio>
#include <ctime>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <utility>

#include "exec/git_process.h"
#include "exec/parsers/incremental_blame.h"

namespace gg::services {

namespace {

// RAII temp file used to hand dirty buffer contents to `git blame
// --contents` without stdin-pipe deadlock concerns.
class TempFile {
 public:
  static Result<TempFile> create(const std::string& contents) {
    TempFile file;
    file.path_ =
        (std::filesystem::temp_directory_path() / "gg-contents-XXXXXX").string();
    int fd = mkstemp(file.path_.data());
    if (fd < 0) return Error{ErrorCode::Internal, "mkstemp failed"};
    size_t written = 0;
    while (written < contents.size()) {
      ssize_t n = write(fd, contents.data() + written, contents.size() - written);
      if (n < 0) {
        close(fd);
        return Error{ErrorCode::Internal, "failed writing contents temp file"};
      }
      written += static_cast<size_t>(n);
    }
    close(fd);
    return file;
  }

  TempFile(TempFile&& other) noexcept : path_(std::move(other.path_)) { other.path_.clear(); }
  TempFile(const TempFile&) = delete;
  ~TempFile() {
    if (!path_.empty()) std::remove(path_.c_str());
  }

  const std::string& path() const { return path_; }

 private:
  TempFile() = default;
  std::string path_;
};

// Resolves (commit OID, blob OID) for a cacheable request. Returns nullopt
// when the working tree file differs from the blamed blob in a way we can't
// key on (e.g. unreadable file).
std::optional<std::pair<std::string, std::string>> resolveOids(const core::Repo& repo,
                                                               const BlameRequest& request) {
  git_object* commitObj = nullptr;
  const std::string revspec = request.rev.value_or("HEAD");
  if (git_revparse_single(&commitObj, repo.raw(), revspec.c_str()) != 0) return std::nullopt;
  std::unique_ptr<git_object, decltype(&git_object_free)> commitGuard(commitObj,
                                                                      git_object_free);

  git_object* peeled = nullptr;
  if (git_object_peel(&peeled, commitObj, GIT_OBJECT_COMMIT) != 0) return std::nullopt;
  std::unique_ptr<git_object, decltype(&git_object_free)> peeledGuard(peeled, git_object_free);

  char commitHex[GIT_OID_HEXSZ + 1] = {};
  git_oid_fmt(commitHex, git_object_id(peeled));

  std::string blobHex;
  if (request.rev) {
    // Blob as recorded in the blamed commit's tree.
    git_object* blob = nullptr;
    const std::string spec = std::string(commitHex) + ":" + request.path;
    if (git_revparse_single(&blob, repo.raw(), spec.c_str()) != 0) return std::nullopt;
    char hex[GIT_OID_HEXSZ + 1] = {};
    git_oid_fmt(hex, git_object_id(blob));
    git_object_free(blob);
    blobHex = hex;
  } else {
    // Working-tree blame: hash the on-disk bytes. Content addressing keeps
    // the key exact — any edit changes the blob OID and misses the cache.
    git_oid oid;
    const std::filesystem::path file = std::filesystem::path(repo.workdir()) / request.path;
    if (git_odb_hashfile(&oid, file.string().c_str(), GIT_OBJECT_BLOB) != 0) return std::nullopt;
    char hex[GIT_OID_HEXSZ + 1] = {};
    git_oid_fmt(hex, &oid);
    blobHex = hex;
  }
  return std::make_pair(std::string(commitHex), blobHex);
}

// Blame-scoped libgit2 error: always GitError — an unresolvable rev or a
// path missing from the tree is GIT_ENOTFOUND to libgit2, but the repository
// itself exists.
Error blameGitError(const std::string& context) {
  const git_error* err = git_error_last();
  const std::string detail = err && err->message ? err->message : "unknown libgit2 error";
  return {ErrorCode::GitError, context + ": " + detail};
}

std::string oidHex(const git_oid& oid) {
  char hex[GIT_OID_HEXSZ + 1] = {};
  git_oid_fmt(hex, &oid);
  return hex;
}

// git_time offset (minutes east of UTC) -> "+HHMM"/"-HHMM".
std::string formatTimezone(int offsetMinutes) {
  const char sign = offsetMinutes < 0 ? '-' : '+';
  const int magnitude = offsetMinutes < 0 ? -offsetMinutes : offsetMinutes;
  char buffer[16];
  std::snprintf(buffer, sizeof(buffer), "%c%02d%02d", sign, magnitude / 60, magnitude % 60);
  return buffer;
}

exec::BlameSignature toBlameSignature(const git_signature* sig) {
  exec::BlameSignature out;
  if (!sig) return out;
  out.name = sig->name ? sig->name : "";
  out.email = sig->email ? sig->email : "";
  out.time = static_cast<std::int64_t>(sig->when.time);
  out.timezone = formatTimezone(sig->when.offset);
  return out;
}

struct BlameDeleter {
  void operator()(git_blame* blame) const { git_blame_free(blame); }
};
using BlamePtr = std::unique_ptr<git_blame, BlameDeleter>;

}  // namespace

std::optional<std::string> BlameService::cacheKey(const core::Repo& repo,
                                                  const BlameRequest& request,
                                                  BlameBackend backend) {
  if (request.contents) return std::nullopt;  // dirty buffers are never cached
  auto oids = resolveOids(repo, request);
  if (!oids) return std::nullopt;
  // The backend marker keeps CLI-parsed and libgit2-computed entries apart:
  // the two backends can attribute rename-boundary hunks differently, so a
  // cached result must only ever serve requests for the same backend.
  return cache::BlameCache::makeKey(oids->first, oids->second) +
         (backend == BlameBackend::Cli ? "|cli" : "|libgit2");
}

Result<BlameSummary> BlameService::blame(const core::Repo& repo, const BlameRequest& request,
                                         const CancelToken& token, const HunkFn& emit) {
  const BlameBackend backend =
      request.forceBackend.value_or(cliAvailable_ ? BlameBackend::Cli : BlameBackend::LibGit2);
  const std::optional<std::string> key = cacheKey(repo, request, backend);
  if (key) {
    if (auto cached = cache_.get(*key)) {
      for (const auto& hunk : cached->hunks) {
        token.throwIfCancelled();
        emit(hunk);
      }
      return BlameSummary{cached, /*fromCache=*/true};
    }
  }

  auto computed = backend == BlameBackend::Cli ? blameWithCli(repo, request, token, emit)
                                               : blameWithLibGit2(repo, request, token, emit);
  if (!computed) return computed.error();
  if (key) cache_.put(*key, computed.value());
  return BlameSummary{std::move(computed).value(), /*fromCache=*/false};
}

Result<std::shared_ptr<const cache::BlameResult>> BlameService::blameWithCli(
    const core::Repo& repo, const BlameRequest& request, const CancelToken& token,
    const HunkFn& emit) {
  std::vector<std::string> args = {"blame", "--incremental"};
  std::optional<TempFile> contentsFile;
  if (request.contents) {
    auto file = TempFile::create(*request.contents);
    if (!file) return file.error();
    contentsFile.emplace(std::move(file.value()));
    args.push_back("--contents");
    args.push_back(contentsFile->path());
  }
  if (request.rev) args.push_back(*request.rev);
  args.push_back("--");
  args.push_back(request.path);

  const std::string cwd = repo.workdir().empty() ? repo.gitdir() : repo.workdir();
  auto process = exec::GitProcess::spawn(cwd, std::move(args));
  if (!process) return process.error();

  auto result = std::make_shared<cache::BlameResult>();
  exec::IncrementalBlameParser parser([&](const exec::BlameHunk& hunk) {
    result->hunks.push_back(hunk);
    emit(hunk);
  });

  std::string line;
  while (process.value().readLine(line, token)) {
    parser.feedLine(line);
  }
  parser.finish();

  if (int exitCode = process.value().wait(token); exitCode != 0) {
    return Error{ErrorCode::GitError,
                 "git blame failed (" + std::to_string(exitCode) +
                     "): " + process.value().stderrOutput()};
  }

  result->commits = parser.commits();
  return std::shared_ptr<const cache::BlameResult>(std::move(result));
}

// In-process fallback via git_blame_file/git_blame_buffer. Known divergences
// from `git blame` (all acceptable; results never share cache entries with
// the CLI backend):
//   - Weaker cross-file rename attribution: clean whole-file renames are
//     followed, but similarity-based pairing can attribute rename+edit or
//     copy cases to the renaming commit instead of the true origin.
//   - No `previous` (blame-parent) hunk fields: libgit2 does not report the
//     parent commit a hunk was passed from.
//   - ignore-revs files and mailmap are not consulted.
Result<std::shared_ptr<const cache::BlameResult>> BlameService::blameWithLibGit2(
    const core::Repo& repo, const BlameRequest& request, const CancelToken& token,
    const HunkFn& emit) {
  // Default flags mirror `git blame` defaults (no -M/-C copy tracking).
  git_blame_options options;
  if (git_blame_options_init(&options, GIT_BLAME_OPTIONS_VERSION) != 0) {
    return blameGitError("blame options");
  }
  if (request.rev) {
    git_object* obj = nullptr;
    if (git_revparse_single(&obj, repo.raw(), request.rev->c_str()) != 0) {
      return blameGitError("resolve '" + *request.rev + "'");
    }
    std::unique_ptr<git_object, decltype(&git_object_free)> objGuard(obj, git_object_free);
    git_object* peeled = nullptr;
    if (git_object_peel(&peeled, obj, GIT_OBJECT_COMMIT) != 0) {
      return blameGitError("'" + *request.rev + "' does not point to a commit");
    }
    std::unique_ptr<git_object, decltype(&git_object_free)> peeledGuard(peeled, git_object_free);
    git_oid_cpy(&options.newest_commit, git_object_id(peeled));
  }

  token.throwIfCancelled();
  git_blame* rawBase = nullptr;
  if (git_blame_file(&rawBase, repo.raw(), request.path.c_str(), &options) != 0) {
    return blameGitError("blame '" + request.path + "'");
  }
  BlamePtr base(rawBase);

  // Working-tree (and dirty-buffer) blame layers the current contents over
  // the HEAD blame — the same shape as `git blame [--contents]` on a dirty
  // file. Lines absent from HEAD come back with a zero OID.
  git_blame* effective = base.get();
  BlamePtr buffer;
  if (!request.rev) {
    std::string contents;
    if (request.contents) {
      contents = *request.contents;
    } else {
      const std::filesystem::path file =
          std::filesystem::path(repo.workdir()) / request.path;
      std::ifstream in(file, std::ios::binary);
      if (!in) return Error{ErrorCode::GitError, "cannot read '" + request.path + "'"};
      std::ostringstream text;
      text << in.rdbuf();
      contents = std::move(text).str();
    }
    token.throwIfCancelled();
    git_blame* rawBuffer = nullptr;
    if (git_blame_buffer(&rawBuffer, base.get(), contents.data(), contents.size()) != 0) {
      return blameGitError("blame buffer for '" + request.path + "'");
    }
    buffer.reset(rawBuffer);
    effective = buffer.get();
  }

  auto result = std::make_shared<cache::BlameResult>();
  const size_t hunkCount = git_blame_hunkcount(effective);
  for (size_t i = 0; i < hunkCount; ++i) {
    token.throwIfCancelled();
    const git_blame_hunk* raw = git_blame_hunk_byindex(effective, i);
    if (!raw) continue;

    const bool uncommitted = git_oid_is_zero(&raw->final_commit_id) != 0;
    exec::BlameHunk hunk;
    hunk.sha = uncommitted ? exec::kUncommittedSha : oidHex(raw->final_commit_id);
    hunk.resultLine = static_cast<std::uint32_t>(raw->final_start_line_number);
    hunk.originalLine = static_cast<std::uint32_t>(raw->orig_start_line_number);
    hunk.lineCount = static_cast<std::uint32_t>(raw->lines_in_hunk);
    hunk.path = raw->orig_path ? raw->orig_path : request.path;

    auto [it, inserted] = result->commits.try_emplace(hunk.sha);
    exec::BlameCommit& commit = it->second;
    if (inserted) {
      commit.sha = hunk.sha;
      if (uncommitted) {
        // Synthetic entry matching the CLI's for not-yet-committed lines.
        exec::BlameSignature signature;
        signature.name = "Not Committed Yet";
        signature.email = "not.committed.yet";
        signature.time = static_cast<std::int64_t>(std::time(nullptr));
        signature.timezone = "+0000";
        commit.author = signature;
        commit.committer = std::move(signature);
        commit.summary = "Version of " + request.path + " from " + request.path;
      } else {
        git_commit* rawCommit = nullptr;
        if (git_commit_lookup(&rawCommit, repo.raw(), &raw->final_commit_id) != 0) {
          return blameGitError("lookup commit " + hunk.sha);
        }
        core::CommitPtr commitGuard(rawCommit);
        commit.author = toBlameSignature(git_commit_author(rawCommit));
        commit.committer = toBlameSignature(git_commit_committer(rawCommit));
        const char* summary = git_commit_summary(rawCommit);
        commit.summary = summary ? summary : "";
      }
    }
    if (raw->boundary) commit.boundary = true;

    result->hunks.push_back(hunk);
    emit(hunk);
  }
  return std::shared_ptr<const cache::BlameResult>(std::move(result));
}

}  // namespace gg::services
