#pragma once

#include <git2.h>

#include <memory>
#include <string>

#include "core/repo.h"
#include "util/result.h"

namespace gg::services::status_detail {

struct DiffDeleter {
  void operator()(git_diff* diff) const { git_diff_free(diff); }
};
using DiffPtr = std::unique_ptr<git_diff, DiffDeleter>;

struct PatchDeleter {
  void operator()(git_patch* patch) const { git_patch_free(patch); }
};
using PatchPtr = std::unique_ptr<git_patch, PatchDeleter>;

// Always reports GitError: an unresolvable object is GIT_ENOTFOUND to
// libgit2, but not a missing repository.
Error statusGitError(const std::string& context);

// Diff limited to one path: index -> workdir (staged == false, untracked
// content included) or HEAD tree -> index (staged == true; empty tree when
// HEAD is unborn). Rename detection stays off so paths are stable.
Result<DiffPtr> singleFileDiff(const core::Repo& repo, const std::string& path, bool staged);

}  // namespace gg::services::status_detail
