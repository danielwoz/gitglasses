#pragma once

#include <functional>
#include <memory>
#include <optional>
#include <string>
#include <vector>

#include "cache/blame_cache.h"
#include "core/repo.h"
#include "util/cancel.h"
#include "util/result.h"

namespace gg::services {

// Which engine computes a blame. Cli honors full git semantics (rename
// heuristics, ignore-revs files, mailmap); LibGit2 computes in-process and
// serves builds and environments where no git CLI is available.
enum class BlameBackend { Cli, LibGit2 };

// How far blame looks for lines that were moved or copied rather than
// written: Off is plain `git blame`, WithinFile is -M, and AcrossFiles is -C,
// which also covers lines moved or copied from other files changed in the
// same commit. CLI backend only.
enum class MoveDetection { Off, WithinFile, AcrossFiles };

// Attribution choices. The defaults are plain `git blame`, which also honours
// the repository's ignore-revs file.
struct BlameOptions {
  // -w: a change that only touches whitespace does not take a line over.
  bool ignoreWhitespace = false;
  MoveDetection moves = MoveDetection::Off;
  // Look through the commits listed in the blame.ignoreRevsFile files, or in
  // the repository's .git-blame-ignore-revs when that setting is unset.
  // Listed files that do not exist are skipped. CLI backend only.
  bool ignoreRevs = true;
};

struct BlameRequest {
  std::string path;                     // repo-relative
  std::optional<std::string> rev;       // nullopt = working tree
  std::optional<std::string> contents;  // dirty buffer overlay
  BlameOptions options;
  // Overrides automatic backend selection (tests compare backends and
  // exercise the fallback while a CLI is present).
  std::optional<BlameBackend> forceBackend;
};

struct BlameSummary {
  std::shared_ptr<const cache::BlameResult> result;
  bool fromCache = false;
  // The path is tracked with Git LFS (filter=lfs): what git stores, and so
  // what the hunks attribute, is the pointer file, not the content.
  bool lfs = false;
};

// Whole-file blame. Uses `git blame --incremental` when a git CLI is
// available, and libgit2's git_blame_file/git_blame_buffer otherwise. Results
// are cached content-addressed by (blamed commit OID, blob OID), the path,
// the options and a digest of the ignore-revs and mailmap files, plus a
// backend marker, so clean-file re-requests are free and the two backends'
// results never mix. Both backends map names through the mailmap.
class BlameService {
 public:
  explicit BlameService(cache::BlameCache& cache, bool cliAvailable = true)
      : cache_(cache), cliAvailable_(cliAvailable) {}

  using HunkFn = std::function<void(const exec::BlameHunk&)>;

  // Emits hunks in the backend's discovery order (streaming); the returned
  // summary carries the complete parsed result. `repo` must outlive the call.
  Result<BlameSummary> blame(const core::Repo& repo, const BlameRequest& request,
                             const CancelToken& token, const HunkFn& emit);

 private:
  // Cache key for the request, when it is cacheable (no dirty contents).
  // `inputs` digests everything outside the file's history that changes the
  // answer (ignore-revs and mailmap files).
  std::optional<std::string> cacheKey(const core::Repo& repo, const BlameRequest& request,
                                      BlameBackend backend, const std::string& inputs);

  Result<std::shared_ptr<const cache::BlameResult>> blameWithCli(
      const core::Repo& repo, const BlameRequest& request,
      const std::vector<std::string>& ignoreRevsFiles, const CancelToken& token,
      const HunkFn& emit);
  Result<std::shared_ptr<const cache::BlameResult>> blameWithLibGit2(const core::Repo& repo,
                                                                     const BlameRequest& request,
                                                                     const CancelToken& token,
                                                                     const HunkFn& emit);

  cache::BlameCache& cache_;
  bool cliAvailable_;
};

}  // namespace gg::services
