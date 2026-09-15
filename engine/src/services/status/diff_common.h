#pragma once

#include <git2.h>

#include <string>

#include "core/git2.h"
#include "core/repo.h"
#include "util/result.h"

namespace gg::services::status_detail {

// Diff limited to one path: index -> workdir (staged == false, untracked
// content included) or HEAD tree -> index (staged == true; empty tree when
// HEAD is unborn). Rename detection stays off so paths are stable.
Result<core::DiffPtr> singleFileDiff(const core::Repo& repo, const std::string& path,
                                     bool staged);

}  // namespace gg::services::status_detail
