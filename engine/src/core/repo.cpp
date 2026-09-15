#include "core/repo.h"

namespace gg::core {

Result<Repo> Repo::open(const std::string& path) {
  git_repository* raw = nullptr;
  if (int rc = git_repository_open(&raw, path.c_str()); rc != 0) {
    return lastGitError(rc, "open repository at " + path);
  }
  RepositoryPtr repo(raw);

  const char* workdir = git_repository_workdir(raw);
  const char* gitdir = git_repository_path(raw);
  return Repo(std::move(repo), workdir ? workdir : "", gitdir ? gitdir : "",
              git_repository_is_bare(raw) != 0, git_repository_is_worktree(raw) != 0);
}

Result<std::string> Repo::discover(const std::string& path) {
  BufDisposer found;
  if (int rc = git_repository_discover(&found.buf, path.c_str(), /*across_fs=*/0, nullptr);
      rc != 0) {
    return lastGitError(rc, "discover repository from " + path);
  }
  // discover() yields the .git dir; open it to learn the workdir root.
  auto repo = Repo::open(std::string(found.buf.ptr, found.buf.size));
  if (!repo) return repo.error();
  return repo.value().workdir().empty() ? repo.value().gitdir() : repo.value().workdir();
}

Result<HeadState> Repo::head() const {
  HeadState state;
  if (git_repository_head_unborn(repo_.get()) == 1) {
    state.unborn = true;
    return state;
  }
  state.detached = git_repository_head_detached(repo_.get()) == 1;

  git_reference* rawHead = nullptr;
  if (int rc = git_repository_head(&rawHead, repo_.get()); rc != 0) {
    return lastGitError(rc, "read HEAD");
  }
  ReferencePtr head(rawHead);

  if (const git_oid* oid = git_reference_target(rawHead)) state.oid = oidToHex(*oid);
  if (!state.detached) {
    const char* shorthand = git_reference_shorthand(rawHead);
    state.branch = shorthand ? shorthand : "";
  }
  return state;
}

}  // namespace gg::core
