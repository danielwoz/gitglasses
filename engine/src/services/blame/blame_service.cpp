#include "services/blame/blame_service.h"

#include <unistd.h>

#include <cstdio>
#include <filesystem>

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

}  // namespace

std::optional<std::string> BlameService::cacheKey(const core::Repo& repo,
                                                  const BlameRequest& request) {
  if (request.contents) return std::nullopt;  // dirty buffers are never cached
  auto oids = resolveOids(repo, request);
  if (!oids) return std::nullopt;
  return cache::BlameCache::makeKey(oids->first, oids->second);
}

Result<BlameSummary> BlameService::blame(const core::Repo& repo, const BlameRequest& request,
                                         const CancelToken& token, const HunkFn& emit) {
  const std::optional<std::string> key = cacheKey(repo, request);
  if (key) {
    if (auto cached = cache_.get(*key)) {
      for (const auto& hunk : cached->hunks) {
        token.throwIfCancelled();
        emit(hunk);
      }
      return BlameSummary{cached, /*fromCache=*/true};
    }
  }

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
  std::shared_ptr<const cache::BlameResult> shared = std::move(result);
  if (key) cache_.put(*key, shared);
  return BlameSummary{shared, /*fromCache=*/false};
}

}  // namespace gg::services
