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

// Same, but always as GitError. An unresolvable rev, ref, object or path
// reports GIT_ENOTFOUND, which lastGitError() maps to RepoNotFound even though
// the repository itself is present.
Error gitError(const std::string& context);

struct RepositoryDeleter {
  void operator()(git_repository* repo) const { git_repository_free(repo); }
};
struct ReferenceDeleter {
  void operator()(git_reference* ref) const { git_reference_free(ref); }
};
struct CommitDeleter {
  void operator()(git_commit* commit) const { git_commit_free(commit); }
};
struct TreeDeleter {
  void operator()(git_tree* tree) const { git_tree_free(tree); }
};
struct ObjectDeleter {
  void operator()(git_object* object) const { git_object_free(object); }
};
struct IndexDeleter {
  void operator()(git_index* index) const { git_index_free(index); }
};
struct DiffDeleter {
  void operator()(git_diff* diff) const { git_diff_free(diff); }
};
struct PatchDeleter {
  void operator()(git_patch* patch) const { git_patch_free(patch); }
};
struct StatusListDeleter {
  void operator()(git_status_list* list) const { git_status_list_free(list); }
};
struct BranchIteratorDeleter {
  void operator()(git_branch_iterator* iter) const { git_branch_iterator_free(iter); }
};
struct ReferenceIteratorDeleter {
  void operator()(git_reference_iterator* iter) const { git_reference_iterator_free(iter); }
};
struct BufDisposer {
  git_buf buf = GIT_BUF_INIT;
  ~BufDisposer() { git_buf_dispose(&buf); }
};

using RepositoryPtr = std::unique_ptr<git_repository, RepositoryDeleter>;
using ReferencePtr = std::unique_ptr<git_reference, ReferenceDeleter>;
using CommitPtr = std::unique_ptr<git_commit, CommitDeleter>;
using TreePtr = std::unique_ptr<git_tree, TreeDeleter>;
using ObjectPtr = std::unique_ptr<git_object, ObjectDeleter>;
using IndexPtr = std::unique_ptr<git_index, IndexDeleter>;
using DiffPtr = std::unique_ptr<git_diff, DiffDeleter>;
using PatchPtr = std::unique_ptr<git_patch, PatchDeleter>;
using StatusListPtr = std::unique_ptr<git_status_list, StatusListDeleter>;
using BranchIteratorPtr = std::unique_ptr<git_branch_iterator, BranchIteratorDeleter>;
using ReferenceIteratorPtr = std::unique_ptr<git_reference_iterator, ReferenceIteratorDeleter>;

// Hex text of an object id.
std::string oidToHex(const git_oid& oid);

// Sha of the commit a ref ultimately points at (peels annotated tags and
// symbolic refs). Empty when the ref does not resolve to a commit.
std::string commitShaOf(git_reference* ref);

// Protocol shape of a git signature: name, email, epoch seconds. A null
// signature yields empty strings and time 0.

}  // namespace gg::core
