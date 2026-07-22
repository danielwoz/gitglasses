#include "core/git2.h"

namespace gg::core {

LibGit2::LibGit2() { git_libgit2_init(); }

LibGit2::~LibGit2() { git_libgit2_shutdown(); }

Error lastGitError(int code, const std::string& context) {
  const git_error* err = git_error_last();
  std::string detail = err && err->message ? err->message : "unknown libgit2 error";
  return {code == GIT_ENOTFOUND ? ErrorCode::RepoNotFound : ErrorCode::GitError,
          context + ": " + detail};
}

}  // namespace gg::core
