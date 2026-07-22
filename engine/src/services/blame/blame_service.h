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

struct BlameRequest {
  std::string path;                     // repo-relative
  std::optional<std::string> rev;       // nullopt = working tree
  std::optional<std::string> contents;  // dirty buffer overlay
};

struct BlameSummary {
  std::shared_ptr<const cache::BlameResult> result;
  bool fromCache = false;
};

// Whole-file blame. Uses `git blame --incremental` (the CLI is the
// compatibility oracle for blame: rename heuristics, ignore-revs files,
// mailmap) and caches parsed results content-addressed by
// (blamed commit OID, blob OID) so clean-file re-requests are free.
class BlameService {
 public:
  explicit BlameService(cache::BlameCache& cache) : cache_(cache) {}

  using HunkFn = std::function<void(const exec::BlameHunk&)>;

  // Emits hunks in git's discovery order (streaming); the returned summary
  // carries the complete parsed result. `repo` must outlive the call.
  Result<BlameSummary> blame(const core::Repo& repo, const BlameRequest& request,
                             const CancelToken& token, const HunkFn& emit);

 private:
  // Cache key for the request, when it is cacheable (no dirty contents).
  std::optional<std::string> cacheKey(const core::Repo& repo, const BlameRequest& request);

  cache::BlameCache& cache_;
};

}  // namespace gg::services
