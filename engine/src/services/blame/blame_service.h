#pragma once

#include <functional>
#include <memory>
#include <optional>
#include <string>

#include "cache/blame_cache.h"
#include "core/repo.h"
#include "util/cancel.h"
#include "util/result.h"

namespace gg::services {

// Which engine computes a blame. Cli is the compatibility oracle (rename
// heuristics, ignore-revs files, mailmap); LibGit2 is the in-process fallback
// for builds/environments without a git CLI (wasm groundwork).
enum class BlameBackend { Cli, LibGit2 };

struct BlameRequest {
  std::string path;                     // repo-relative
  std::optional<std::string> rev;       // nullopt = working tree
  std::optional<std::string> contents;  // dirty buffer overlay
  // Overrides automatic backend selection (tests compare backends and
  // exercise the fallback while a CLI is present).
  std::optional<BlameBackend> forceBackend;
};

struct BlameSummary {
  std::shared_ptr<const cache::BlameResult> result;
  bool fromCache = false;
};

// Whole-file blame. Uses `git blame --incremental` when a git CLI is
// available, and libgit2's git_blame_file/git_blame_buffer otherwise. Results
// are cached content-addressed by (blamed commit OID, blob OID) plus a
// backend marker, so clean-file re-requests are free and the two backends'
// results never mix.
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
  std::optional<std::string> cacheKey(const core::Repo& repo, const BlameRequest& request,
                                      BlameBackend backend);

  Result<std::shared_ptr<const cache::BlameResult>> blameWithCli(const core::Repo& repo,
                                                                 const BlameRequest& request,
                                                                 const CancelToken& token,
                                                                 const HunkFn& emit);
  Result<std::shared_ptr<const cache::BlameResult>> blameWithLibGit2(const core::Repo& repo,
                                                                     const BlameRequest& request,
                                                                     const CancelToken& token,
                                                                     const HunkFn& emit);

  cache::BlameCache& cache_;
  bool cliAvailable_;
};

}  // namespace gg::services
