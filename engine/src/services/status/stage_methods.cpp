#include "services/status/stage_methods.h"

#include <git2.h>

#include <chrono>
#include <cstdint>
#include <string>
#include <utility>
#include <vector>

#include "core/git2.h"
#include "services/params.h"
#include "services/status/diff_common.h"
#include "util/temp_file.h"

namespace gg::services {

namespace {

// Ceiling on hunk offsets: past it the value cannot address a real diff, and
// the cast to long stays well defined on every supported platform.
constexpr std::int64_t kMaxLine = 1LL << 40;

// One requested hunk, addressed by the ranges diff/fileHunks reported.
struct HunkRange {
  long oldStart = 0;
  long oldLines = 0;
  long newStart = 0;
  long newLines = 0;
};

// Reads the 'hunks' param. The ranges must select hunks of a diff the engine
// re-derives, so they are validated up front: a fractional, negative or
// missing offset can never match and is a client bug, not a stale diff.
std::vector<HunkRange> requireHunkRanges(const rpc::Json& params) {
  const rpc::Json requested = params.value("hunks", rpc::Json::array());
  if (!requested.is_array() || requested.empty()) {
    throw rpc::HandlerError{{ErrorCode::InvalidParams, "'hunks' must be a non-empty array"}};
  }
  std::vector<HunkRange> ranges;
  ranges.reserve(requested.size());
  for (const auto& want : requested) {
    ranges.push_back({static_cast<long>(requireInteger(want, "oldStart", 0, kMaxLine)),
                      static_cast<long>(requireInteger(want, "oldLines", 0, kMaxLine)),
                      static_cast<long>(requireInteger(want, "newStart", 0, kMaxLine)),
                      static_cast<long>(requireInteger(want, "newLines", 0, kMaxLine))});
  }
  return ranges;
}

std::string requireAction(const rpc::Json& params) {
  const std::string action = params.value("action", "");
  if (action != "stage" && action != "unstage") {
    throw rpc::HandlerError{
        {ErrorCode::InvalidParams, "'action' must be 'stage' or 'unstage'"}};
  }
  return action;
}

Result<core::Repo> openWorktreeRepo(ServiceContext& context, const rpc::Json& params) {
  auto repo = context.registry.open(params.value("repoId", ""));
  if (!repo) return repo;
  if (repo.value().workdir().empty()) {
    return Error{ErrorCode::GitError, "staging requires a repository with a working tree"};
  }
  return repo;
}

using status_detail::HunkBlock;

// Rebuilds a patch containing only the selected hunks. For forward
// application the new-side start of each kept hunk is renumbered as if the
// dropped hunks did not exist; for reverse application (`selected` hunks are
// removed from the index) the recorded numbers are already absolute on the
// source side, so they are kept verbatim.
std::string buildSubsetPatch(const std::string& header, const std::vector<HunkBlock>& blocks,
                             const std::vector<bool>& selected, bool renumber) {
  std::string out = header;
  // Line count each side of the file has gained from the hunks seen so far:
  // over all of them, and over the kept ones alone.
  long cumulativeAll = 0;
  long cumulativeKept = 0;
  for (size_t i = 0; i < blocks.size(); ++i) {
    const HunkBlock& block = blocks[i];
    const long delta = block.newLines - block.oldLines;
    if (selected[i]) {
      if (renumber) {
        // newStart counts from a file carrying every earlier hunk; the subset
        // carries only the kept ones, so swap one shift for the other.
        const long newStart = block.newStart - cumulativeAll + cumulativeKept;
        out += "@@ -" + std::to_string(block.oldStart) + "," + std::to_string(block.oldLines) +
               " +" + std::to_string(newStart) + "," + std::to_string(block.newLines) + " @@" +
               block.trailing + "\n";
      } else {
        out += block.headerLine;
      }
      out += block.body;
      cumulativeKept += delta;
    }
    cumulativeAll += delta;
  }
  return out;
}

// Refuses skip-worktree paths before anything is staged. Git treats such an
// entry as unchanged whatever the working tree holds (`git add` stages the
// other paths and then fails), and staging the absent file of an
// out-of-cone entry would record its deletion.
void refuseSkipWorktree(git_index* index, const std::vector<std::string>& paths) {
  for (const auto& path : paths) {
    if (status_detail::skipWorktree(index, path.c_str())) {
      throw rpc::HandlerError{
          {ErrorCode::GitError,
           "'" + path + "' is outside the sparse checkout (skip-worktree); git does not stage it"}};
    }
  }
}

// Ceiling on a git command that writes the index. Git holds index.lock for
// the whole run, clean filters included, and a killed git leaves the lock
// behind, which keeps every git tool out of the repository until someone
// deletes it. The ceiling is sized for filters working through large files
// (Git LFS, git-crypt), not for catching a stalled git.
constexpr std::chrono::milliseconds kIndexWriteTimeout = std::chrono::hours(1);

// Runs a git command that writes the index. For the same reason it is not
// cancelled once started; callers check for cancellation before each run.
void runIndexWriter(const core::Repo& repo, std::vector<std::string> args,
                    const std::string& what) {
  status_detail::runGitChecked(repo, std::move(args), CancelToken::none(), what, 0,
                               kIndexWriteTimeout);
}

// `git add` runs every filter driver (git-lfs, git-crypt, custom clean
// filters) and working-tree-encoding, so the index receives exactly what git
// stores; -A stages a path missing from the working tree as a removal. Each
// batch is one index update, so a failure or cancellation before a later
// batch leaves the earlier ones staged, as separate `git add` commands would.
void stageWithGit(const core::Repo& repo, const std::vector<std::string>& paths,
                  const CancelToken& token) {
  for (auto& batch : status_detail::argvBatches(paths)) {
    token.throwIfCancelled();
    std::vector<std::string> args = {"--literal-pathspecs", "add", "-A", "--"};
    for (auto& path : batch) args.push_back(std::move(path));
    runIndexWriter(repo, std::move(args), "git add");
  }
}

// Staging for engines without the git CLI. libgit2 performs only its built-in
// CRLF and ident conversions, so a path with a filter driver or
// working-tree-encoding is refused before the index changes rather than
// staged as raw working-tree bytes.
void stageWithLibgit2(const core::Repo& repo, git_index* index,
                      const std::vector<std::string>& paths) {
  for (const auto& path : paths) {
    const status_detail::PathFilter filter = status_detail::pathFilter(repo.raw(), path);
    if (filter.any()) {
      throw rpc::HandlerError{
          {ErrorCode::FilterNeedsGitCli,
           "cannot stage '" + path + "': it goes through " + filter.describe() +
               ", which only the git CLI can apply, and this engine has no git CLI"}};
    }
  }
  for (const auto& path : paths) {
    int rc = git_index_add_bypath(index, path.c_str());
    // A path missing from the working tree stages as a removal.
    if (rc == GIT_ENOTFOUND) rc = git_index_remove_bypath(index, path.c_str());
    if (rc != 0) throw rpc::HandlerError{{core::gitError("stage '" + path + "'")}};
  }
  if (git_index_write(index) != 0) throw rpc::HandlerError{{core::gitError("write index")}};
}

// Restores the index entries for `paths` from HEAD's tree, as
// `git reset -- <paths>` does: an entry absent from HEAD leaves the index,
// and a directory covers its contents. Paths are literal, so unstaging
// `app/[id]/page.tsx` never touches `app/i/page.tsx`.
void resetToHead(const core::Repo& repo, git_index* index, const std::vector<std::string>& paths) {
  core::ObjectPtr treeGuard;
  git_tree* tree = nullptr;
  auto head = repo.head();
  if (!head) throw rpc::HandlerError{{head.error()}};
  if (!head.value().unborn) {
    git_object* rawTree = nullptr;
    if (git_revparse_single(&rawTree, repo.raw(), "HEAD^{tree}") != 0) {
      throw rpc::HandlerError{{core::gitError("resolve HEAD tree")}};
    }
    treeGuard.reset(rawTree);
    tree = reinterpret_cast<git_tree*>(rawTree);
  }

  std::vector<std::string> owned = paths;
  std::vector<char*> pointers;
  pointers.reserve(owned.size());
  for (auto& path : owned) pointers.push_back(path.data());
  git_diff_options opts;
  git_diff_options_init(&opts, GIT_DIFF_OPTIONS_VERSION);
  opts.pathspec = {pointers.data(), pointers.size()};
  // Reversed, the new side is HEAD: what each entry goes back to.
  opts.flags = GIT_DIFF_REVERSE | GIT_DIFF_DISABLE_PATHSPEC_MATCH;
  git_diff* rawDiff = nullptr;
  if (git_diff_tree_to_index(&rawDiff, repo.raw(), tree, index, &opts) != 0) {
    throw rpc::HandlerError{{core::gitError("diff HEAD..index")}};
  }
  core::DiffPtr diff(rawDiff);

  const size_t count = git_diff_num_deltas(diff.get());
  for (size_t i = 0; i < count; ++i) {
    const git_diff_delta* delta = git_diff_get_delta(diff.get(), i);
    // Unstaging also drops any conflict entries for the path. GIT_ENOTFOUND
    // means the index has no entry at all, which is the case for a path that
    // exists only in HEAD.
    int rc = git_index_conflict_remove(index, delta->old_file.path);
    if (rc == GIT_ENOTFOUND) rc = 0;
    if (rc == 0 && delta->status == GIT_DELTA_DELETED) {
      rc = git_index_remove(index, delta->old_file.path, 0);
    } else if (rc == 0) {
      git_index_entry entry{};
      entry.mode = delta->new_file.mode;
      git_oid_cpy(&entry.id, &delta->new_file.id);
      entry.path = delta->new_file.path;
      rc = git_index_add(index, &entry);
    }
    if (rc != 0) {
      throw rpc::HandlerError{
          {core::gitError("unstage '" + std::string(delta->old_file.path) + "'")}};
    }
  }
  if (git_index_write(index) != 0) throw rpc::HandlerError{{core::gitError("write index")}};
}

// Applies a patch to the index with `git apply --cached`. The patch goes
// through a TempFile, which is removed on every exit path. --whitespace=nowarn
// keeps an apply.whitespace setting from rewriting the lines being staged.
void applyToIndexWithGit(const core::Repo& repo, const std::string& patch, bool reverse,
                         const CancelToken& token) {
  token.throwIfCancelled();
  auto file = util::TempFile::create(patch, "gg-hunk-", ".patch");
  if (!file) throw rpc::HandlerError{{file.error()}};
  std::vector<std::string> args = {"apply", "--cached", "--whitespace=nowarn"};
  if (reverse) args.emplace_back("--reverse");
  args.push_back(file.value().path());
  runIndexWriter(repo, std::move(args),
                 reverse ? "git apply --cached --reverse" : "git apply --cached");
}

}  // namespace

void registerStageMethods(rpc::Dispatcher& dispatcher, ServiceContext& context) {
  // Whole-file stage/unstage. Serial: index writes must not interleave.
  dispatcher.method(
      "stage/files",
      [&context](const rpc::Json& params, const CancelToken& token,
                 const rpc::NotifyFn&) -> rpc::Json {
        const std::string action = requireAction(params);
        const std::vector<std::string> paths = requireStringArray(params, "paths");
        auto repo = openWorktreeRepo(context, params);
        if (!repo) throw rpc::HandlerError{{repo.error()}};
        auto index = status_detail::readIndex(repo.value().raw());
        if (!index) throw rpc::HandlerError{{index.error()}};

        if (action == "stage") {
          refuseSkipWorktree(index.value().get(), paths);
          if (context.cliAvailable) {
            stageWithGit(repo.value(), paths, token);
          } else {
            stageWithLibgit2(repo.value(), index.value().get(), paths);
          }
        } else {
          // Unstaging copies blobs git already stores from HEAD's tree into
          // the index, so no filter is involved and libgit2 suffices.
          resetToHead(repo.value(), index.value().get(), paths);
        }
        return rpc::Json::object();
      },
      rpc::Mode::Serial);

  // Hunk-level staging. A fresh single-file diff is taken and the requested
  // hunks are matched by their recorded ranges; a stale request (the file
  // changed since the client's diff/fileHunks call) fails instead of applying
  // the wrong lines. Stage applies the subset patch to the index via libgit2's
  // git_apply, or through `git apply --cached` when the diff itself came from
  // the git CLI because the path has a filter driver or working-tree-encoding;
  // unstage reverse-applies it through `git apply --cached --reverse`, which
  // libgit2 has no equivalent for, so unstage requires the git CLI.
  dispatcher.method(
      "stage/hunks",
      [&context](const rpc::Json& params, const CancelToken& token,
                 const rpc::NotifyFn&) -> rpc::Json {
        const std::string action = requireAction(params);
        if (action == "unstage") requireGitCli(context);
        const std::string path = requireString(params, "path");
        const std::vector<HunkRange> requested = requireHunkRanges(params);
        auto repo = openWorktreeRepo(context, params);
        if (!repo) throw rpc::HandlerError{{repo.error()}};

        const bool staged = action == "unstage";
        const status_detail::FilePatch patch =
            status_detail::filePatch(repo.value(), path, staged, context.cliAvailable, token);
        // A gitlink has no lines to split, and a pointer's lines are not the
        // file's: neither can be staged one hunk at a time.
        if (patch.gitlink) {
          throw rpc::HandlerError{{ErrorCode::WholeFileOnly,
                                   "'" + path + "' is a submodule, which cannot be split into " +
                                       "hunks; " + action + " it as a whole"}};
        }
        if (patch.text.empty()) {
          throw rpc::HandlerError{
              {ErrorCode::GitError, "no " + std::string(staged ? "staged" : "unstaged") +
                                        " changes for '" + path + "'"}};
        }
        if (patch.filter.lfs()) {
          throw rpc::HandlerError{{ErrorCode::WholeFileOnly,
                                   "'" + path + "' is stored as a Git LFS pointer, which cannot " +
                                       "be split into hunks; " + action + " the whole file"}};
        }

        std::string header;
        std::vector<HunkBlock> blocks;
        status_detail::splitPatch(patch.text, header, blocks);

        std::vector<bool> selected(blocks.size(), false);
        size_t matched = 0;
        for (const auto& want : requested) {
          token.throwIfCancelled();
          bool found = false;
          for (size_t i = 0; i < blocks.size(); ++i) {
            if (!selected[i] && blocks[i].oldStart == want.oldStart &&
                blocks[i].oldLines == want.oldLines && blocks[i].newStart == want.newStart &&
                blocks[i].newLines == want.newLines) {
              selected[i] = true;
              ++matched;
              found = true;
              break;
            }
          }
          if (!found) {
            throw rpc::HandlerError{
                {ErrorCode::GitError,
                 "hunk not found in current diff of '" + path + "' (stale hunk ranges?)"}};
          }
        }
        if (matched == 0) {
          throw rpc::HandlerError{{ErrorCode::GitError, "no hunks selected"}};
        }

        const std::string subset =
            buildSubsetPatch(header, blocks, selected, /*renumber=*/action == "stage");

        if (action == "stage" && !patch.viaCli) {
          git_diff* rawSubset = nullptr;
          if (git_diff_from_buffer(&rawSubset, subset.data(), subset.size()) != 0) {
            throw rpc::HandlerError{{core::gitError("parse subset patch")}};
          }
          core::DiffPtr subsetDiff(rawSubset);
          if (git_apply(repo.value().raw(), subsetDiff.get(), GIT_APPLY_LOCATION_INDEX,
                        nullptr) != 0) {
            throw rpc::HandlerError{{core::gitError("apply hunks to index")}};
          }
        } else {
          applyToIndexWithGit(repo.value(), subset, /*reverse=*/action == "unstage", token);
        }
        return rpc::Json::object();
      },
      rpc::Mode::Serial);
}

}  // namespace gg::services
