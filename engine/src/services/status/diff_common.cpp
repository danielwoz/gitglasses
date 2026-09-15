#include "services/status/diff_common.h"

namespace gg::services::status_detail {

Result<core::DiffPtr> singleFileDiff(const core::Repo& repo, const std::string& path,
                                     bool staged) {
  git_diff_options opts;
  git_diff_options_init(&opts, GIT_DIFF_OPTIONS_VERSION);
  char* pathspec[] = {const_cast<char*>(path.c_str())};
  opts.pathspec.strings = pathspec;
  opts.pathspec.count = 1;

  git_diff* rawDiff = nullptr;
  if (staged) {
    core::ObjectPtr treeGuard;
    git_tree* tree = nullptr;
    auto head = repo.head();
    if (!head) return head.error();
    if (!head.value().unborn) {
      git_object* rawTree = nullptr;
      if (git_revparse_single(&rawTree, repo.raw(), "HEAD^{tree}") != 0) {
        return core::gitError("resolve HEAD tree");
      }
      treeGuard.reset(rawTree);
      tree = reinterpret_cast<git_tree*>(rawTree);
    }
    if (git_diff_tree_to_index(&rawDiff, repo.raw(), tree, nullptr, &opts) != 0) {
      return core::gitError("diff HEAD..index for '" + path + "'");
    }
  } else {
    opts.flags |= GIT_DIFF_INCLUDE_UNTRACKED | GIT_DIFF_SHOW_UNTRACKED_CONTENT |
                  GIT_DIFF_RECURSE_UNTRACKED_DIRS;
    if (git_diff_index_to_workdir(&rawDiff, repo.raw(), nullptr, &opts) != 0) {
      return core::gitError("diff index..workdir for '" + path + "'");
    }
  }
  return core::DiffPtr(rawDiff);
}

}  // namespace gg::services::status_detail
