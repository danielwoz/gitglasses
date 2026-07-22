#pragma once

#include <optional>
#include <string>

#include "core/git2.h"
#include "util/result.h"

namespace gg::core {

struct HeadState {
  std::string oid;              // empty for unborn HEAD
  std::string branch;           // short name, empty when detached
  bool detached = false;
  bool unborn = false;
};

// A single opened repository handle. NOT thread-safe (mirrors libgit2's
// git_repository contract): open one per task, opens are cheap.
class Repo {
 public:
  static Result<Repo> open(const std::string& path);

  // Discovers the repository containing `path`, walking up like `git rev-parse
  // --git-dir` does. Returns the working-directory root.
  static Result<std::string> discover(const std::string& path);

  const std::string& workdir() const { return workdir_; }
  const std::string& gitdir() const { return gitdir_; }
  bool isBare() const { return bare_; }
  bool isWorktree() const { return worktree_; }

  Result<HeadState> head() const;

  git_repository* raw() const { return repo_.get(); }

 private:
  Repo(RepositoryPtr repo, std::string workdir, std::string gitdir, bool bare, bool worktree)
      : repo_(std::move(repo)),
        workdir_(std::move(workdir)),
        gitdir_(std::move(gitdir)),
        bare_(bare),
        worktree_(worktree) {}

  RepositoryPtr repo_;
  std::string workdir_;
  std::string gitdir_;
  bool bare_ = false;
  bool worktree_ = false;
};

}  // namespace gg::core
