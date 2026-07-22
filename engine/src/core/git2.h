#pragma once

#include <git2.h>

#include <memory>
#include <string>

#include "util/result.h"

namespace gg::core {

// Process-wide libgit2 init/shutdown. Construct exactly once, in main().
class LibGit2 {
 public:
  LibGit2();
  ~LibGit2();
  LibGit2(const LibGit2&) = delete;
  LibGit2& operator=(const LibGit2&) = delete;
};

// Translates the current libgit2 thread-local error into a gg::Error.
Error lastGitError(int code, const std::string& context);

struct RepositoryDeleter {
  void operator()(git_repository* repo) const { git_repository_free(repo); }
};
struct ReferenceDeleter {
  void operator()(git_reference* ref) const { git_reference_free(ref); }
};
struct CommitDeleter {
  void operator()(git_commit* commit) const { git_commit_free(commit); }
};
struct BufDisposer {
  git_buf buf = GIT_BUF_INIT;
  ~BufDisposer() { git_buf_dispose(&buf); }
};

using RepositoryPtr = std::unique_ptr<git_repository, RepositoryDeleter>;
using ReferencePtr = std::unique_ptr<git_reference, ReferenceDeleter>;
using CommitPtr = std::unique_ptr<git_commit, CommitDeleter>;

}  // namespace gg::core
