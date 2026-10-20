#pragma once

#include <git2.h>

#include <chrono>
#include <cstddef>
#include <string>
#include <vector>

#include "core/git2.h"
#include "core/repo.h"
#include "exec/git_process.h"
#include "util/cancel.h"
#include "util/result.h"

namespace gg::services::status_detail {

// The commit a revspec names (full or short sha, HEAD, a branch, a tag),
// peeling annotated tags.
Result<core::CommitPtr> resolveCommit(const core::Repo& repo, const std::string& rev);

// The tree a commit records.
Result<core::TreePtr> commitTree(git_commit* commit);

// One file of a tree-to-tree diff.
struct TreeFileChange {
  std::string path;
  std::string origPath;  // the source path of a rename or copy, else empty
  char status = 'M';     // M A D R C T U
  std::size_t additions = 0;
  std::size_t deletions = 0;
  bool binary = false;  // binary files carry no line counts
  // The content is not in the local object database (a partial clone that
  // has not downloaded it) and could not be fetched, so neither the line
  // counts nor `binary` are known; they stay 0 and false.
  bool statsUnavailable = false;
};

// The files changed between two trees (`oldTree` null means the empty tree),
// with rename detection as git porcelain does it: `diff.renames` (off, on,
// or copies) and `diff.renameLimit` (default 1000) from the repository's
// config. Exact renames (identical content) are paired first however many
// files moved; similarity is then measured among the files left over,
// unless their sources times destinations exceed the limit squared, in
// which case they stay added and deleted, as git leaves them.
//
// Per-file line stats are computed for the first `limit` files; `total`
// receives the number of files. In a partial clone, blobs the stats need
// that the object database lacks are downloaded in one batch through the git
// CLI when `mayFetch` (the way `git show --stat` downloads them); otherwise,
// or when that fails, the affected files report statsUnavailable.
Result<std::vector<TreeFileChange>> treeFileChanges(const core::Repo& repo, git_tree* oldTree,
                                                    git_tree* newTree, const CancelToken& token,
                                                    std::size_t limit, std::size_t& total,
                                                    bool mayFetch);

// The same for the change a commit introduces: its tree against its first
// parent's tree, or against the empty tree for a root commit.
Result<std::vector<TreeFileChange>> commitFileChanges(const core::Repo& repo, git_commit* commit,
                                                      const CancelToken& token, std::size_t limit,
                                                      std::size_t& total, bool mayFetch);

// Whether objects missing from the repository's database may be supplied by
// a promisor remote: a partial clone (`git clone --filter=...`).
bool isPartialClone(git_repository* repo);

// Downloads objects a partial clone lacks by running `git <args>`, a command
// that reads them (git fetches what one command needs in a single batch).
// Fails with git's stderr when git cannot (offline, no credentials).
Result<void> fetchThroughGit(const core::Repo& repo, std::vector<std::string> args,
                             const CancelToken& token);

// Diff limited to one path: index -> workdir (staged == false, untracked
// content included) or HEAD tree -> index (staged == true; empty tree when
// HEAD is unborn). The path is literal, never a glob, so `app/[id]/page.tsx`
// cannot pick up `app/i/page.tsx`; a directory path still covers its
// contents. Rename detection stays off so paths are stable.
Result<core::DiffPtr> singleFileDiff(const core::Repo& repo, const std::string& path, bool staged);

// The delta of `diff` whose path is exactly `path`, or nullptr.
const git_diff_delta* deltaForPath(git_diff* diff, const std::string& path, size_t* index);

// How git turns a path's working-tree bytes into the bytes it stores, beyond
// the CRLF and ident conversions libgit2 performs itself. libgit2 runs
// neither filter drivers (git-lfs, git-crypt, nbstripout, custom
// clean/smudge) nor working-tree-encoding, so for such a path its view of the
// working tree is the raw bytes, not the cleaned bytes git compares and
// stores.
struct PathFilter {
  std::string driver;    // the `filter` attribute's driver name, or empty
  std::string encoding;  // a non-UTF-8 working-tree-encoding, or empty

  bool any() const { return !driver.empty() || !encoding.empty(); }
  // Git LFS stores a pointer, so the index's lines never correspond to the
  // working tree's and no hunk of the pointer can be staged on its own.
  bool lfs() const { return driver == "lfs"; }
  // "the 'lfs' filter", "working-tree-encoding UTF-16LE-BOM", ...
  std::string describe() const;
};

PathFilter pathFilter(git_repository* repo, const std::string& path);

// The repository's index, freshly read from disk.
Result<core::IndexPtr> readIndex(git_repository* repo);

// True when the index entry for `path` is marked skip-worktree (outside a
// sparse checkout, or `git update-index --skip-worktree`). Git treats such
// an entry as unchanged whatever the working tree holds.
bool skipWorktree(git_index* index, const char* path);

// Whether anything (a file, directory or symlink, even a dangling one) is at
// `path` in the working tree. An unreadable location counts as present.
bool workdirHas(const core::Repo& repo, const std::string& path);

// Whether the index has an entry at `path`, at any conflict stage, or below
// it as a directory.
bool indexHas(git_index* index, const std::string& path);

// Whether git leaves this status entry's working-tree side out of what can
// be staged. libgit2 reports a skip-worktree entry missing from the working
// tree as deleted, and a submodule whose checked-out commit still matches
// the index as modified when it only has local edits or untracked files,
// which the parent repository has nothing to stage for.
bool workdirSideHidden(git_index* index, const git_status_entry& entry);

// Whether libgit2's "modified" verdict for this entry's working-tree side
// rests on raw bytes that git would clean first: a regular file with a
// filter driver or working-tree-encoding whose mode is unchanged.
bool needsCleanRecheck(git_repository* repo, const git_status_entry& entry);

// A working-tree file libgit2 reports as modified, with the index blob it was
// compared against.
struct CleanRecheck {
  std::string path;
  git_oid indexId;
};

// For each candidate, whether git sees the working-tree file as different
// from the index once its clean filter and working-tree-encoding have run
// (`git hash-object`, which only reads). A candidate git cannot hash (a
// failing filter, a vanished file) counts as changed.
std::vector<bool> confirmCleanChanges(const core::Repo& repo,
                                      const std::vector<CleanRecheck>& candidates,
                                      const CancelToken& token);

// Runs `git <args>` in the working tree and returns its stdout verbatim. A
// spawn failure, a timeout, or an exit code other than 0 and `alsoOk` fails
// the request with git's stderr, naming the command as `what`.
std::string runGitChecked(const core::Repo& repo, std::vector<std::string> args,
                          const CancelToken& token, const std::string& what, int alsoOk = 0,
                          std::chrono::milliseconds timeout = exec::kDefaultGitTimeout);

// Splits paths into runs that keep each git command line well under the
// Windows limit (32767 UTF-16 units), so a large "stage all" never fails to
// spawn.
std::vector<std::vector<std::string>> argvBatches(const std::vector<std::string>& paths);

// One "@@ -o,l +n,m @@ ..." block of a unified-diff patch.
struct HunkBlock {
  long oldStart = 0;
  long oldLines = 1;
  long newStart = 0;
  long newLines = 1;
  std::string trailing;    // header text after the closing "@@" (function context)
  std::string headerLine;  // the original @@ line, including newline
  std::string body;        // hunk lines, each including its newline
};

// Splits a single-file patch into its file header and hunk blocks.
void splitPatch(const std::string& text, std::string& header, std::vector<HunkBlock>& blocks);

// The unstaged (index -> working tree) or staged (HEAD -> index) change of
// one path, as unified-diff text in the form git stores content.
struct FilePatch {
  std::string text;  // empty when the path has no change
  bool gitlink = false;
  PathFilter filter;
  // The text came from the git CLI because libgit2 cannot clean the path, so
  // applying it must go through the CLI too.
  bool viaCli = false;
};

// Builds the FilePatch for `path`. Unstaged changes of a path with a filter
// driver or working-tree-encoding are diffed by git itself, which cleans the
// working-tree side first; without the git CLI that is impossible, and the
// request fails with FilterNeedsGitCli rather than exposing raw bytes. A
// skip-worktree path has no unstaged change, as in `git diff`.
FilePatch filePatch(const core::Repo& repo, const std::string& path, bool staged, bool cliAvailable,
                    const CancelToken& token);

}  // namespace gg::services::status_detail
