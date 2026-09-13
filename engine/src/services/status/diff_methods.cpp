#include "services/status/diff_methods.h"

#include <git2.h>

#include <memory>
#include <string>
#include <utility>
#include <vector>

#include "core/git2.h"
#include "services/params.h"
#include "services/status/diff_common.h"

namespace gg::services {

namespace {

char statusLetter(git_delta_t status) {
  switch (status) {
    case GIT_DELTA_ADDED:
    case GIT_DELTA_UNTRACKED:
      return 'A';
    case GIT_DELTA_DELETED:
      return 'D';
    case GIT_DELTA_RENAMED:
      return 'R';
    case GIT_DELTA_COPIED:
      return 'C';
    case GIT_DELTA_TYPECHANGE:
      return 'T';
    case GIT_DELTA_CONFLICTED:
      return 'U';
    default:
      return 'M';
  }
}

// Resolves a revspec to the commit it names (peeling annotated tags).
Result<core::CommitPtr> resolveCommit(const core::Repo& repo, const std::string& rev) {
  git_object* obj = nullptr;
  if (git_revparse_single(&obj, repo.raw(), rev.c_str()) != 0) {
    return core::gitError("resolve '" + rev + "'");
  }
  std::unique_ptr<git_object, decltype(&git_object_free)> guard(obj, git_object_free);
  git_object* peeled = nullptr;
  if (git_object_peel(&peeled, obj, GIT_OBJECT_COMMIT) != 0) {
    return core::gitError("'" + rev + "' does not point to a commit");
  }
  return core::CommitPtr(reinterpret_cast<git_commit*>(peeled));
}

Result<core::TreePtr> commitTree(git_commit* commit) {
  git_tree* tree = nullptr;
  if (git_commit_tree(&tree, commit) != 0) return core::gitError("read commit tree");
  return core::TreePtr(tree);
}

// FileChange list for a tree diff: rename detection on, per-file line stats
// from the generated patch (0 for binary files).
rpc::Json fileChangesJson(git_diff* diff, const CancelToken& token) {
  git_diff_find_options findOpts;
  git_diff_find_options_init(&findOpts, GIT_DIFF_FIND_OPTIONS_VERSION);
  if (git_diff_find_similar(diff, &findOpts) != 0) {
    throw rpc::HandlerError{{core::gitError("detect renames")}};
  }
  rpc::Json files = rpc::Json::array();
  const size_t count = git_diff_num_deltas(diff);
  for (size_t i = 0; i < count; ++i) {
    token.throwIfCancelled();
    const git_diff_delta* delta = git_diff_get_delta(diff, i);
    const char letter = statusLetter(delta->status);
    rpc::Json file = {{"path", delta->new_file.path ? delta->new_file.path : ""},
                      {"status", std::string(1, letter)},
                      {"additions", 0},
                      {"deletions", 0}};
    if ((letter == 'R' || letter == 'C') && delta->old_file.path) {
      file["origPath"] = delta->old_file.path;
    }
    if ((delta->flags & GIT_DIFF_FLAG_BINARY) == 0) {
      git_patch* rawPatch = nullptr;
      if (git_patch_from_diff(&rawPatch, diff, i) == 0 && rawPatch) {
        core::PatchPtr patch(rawPatch);
        size_t contextLines = 0, additions = 0, deletions = 0;
        if (git_patch_line_stats(&contextLines, &additions, &deletions, patch.get()) == 0) {
          file["additions"] = additions;
          file["deletions"] = deletions;
        }
      }
    }
    files.push_back(std::move(file));
  }
  return files;
}

}  // namespace

void registerDiffMethods(rpc::Dispatcher& dispatcher, ServiceContext& context) {
  // Files changed by one commit: its tree against the first parent's tree
  // (the empty tree for a root commit).
  dispatcher.method(
      "diff/commit",
      [&context](const rpc::Json& params, const CancelToken& token,
                 const rpc::NotifyFn&) -> rpc::Json {
        const std::string sha = requireString(params, "sha");
        auto repo = context.registry.open(params.value("repoId", ""));
        if (!repo) throw rpc::HandlerError{{repo.error()}};

        auto commit = resolveCommit(repo.value(), sha);
        if (!commit) throw rpc::HandlerError{{commit.error()}};
        auto tree = commitTree(commit.value().get());
        if (!tree) throw rpc::HandlerError{{tree.error()}};

        core::TreePtr parentTree;
        if (git_commit_parentcount(commit.value().get()) > 0) {
          git_commit* rawParent = nullptr;
          if (git_commit_parent(&rawParent, commit.value().get(), 0) != 0) {
            throw rpc::HandlerError{{core::gitError("lookup parent of " + sha)}};
          }
          core::CommitPtr parent(rawParent);
          auto parentTreeResult = commitTree(parent.get());
          if (!parentTreeResult) throw rpc::HandlerError{{parentTreeResult.error()}};
          parentTree = std::move(parentTreeResult.value());
        }

        git_diff* rawDiff = nullptr;
        if (git_diff_tree_to_tree(&rawDiff, repo.value().raw(), parentTree.get(),
                                  tree.value().get(), nullptr) != 0) {
          throw rpc::HandlerError{{core::gitError("diff commit " + sha)}};
        }
        core::DiffPtr diff(rawDiff);
        return {{"files", fileChangesJson(diff.get(), token)}};
      },
      rpc::Mode::Concurrent);

  // Files changed between two revspecs' trees.
  dispatcher.method(
      "diff/refs",
      [&context](const rpc::Json& params, const CancelToken& token,
                 const rpc::NotifyFn&) -> rpc::Json {
        const std::string base = requireString(params, "base");
        const std::string head = requireString(params, "head");
        auto repo = context.registry.open(params.value("repoId", ""));
        if (!repo) throw rpc::HandlerError{{repo.error()}};

        auto baseCommit = resolveCommit(repo.value(), base);
        if (!baseCommit) throw rpc::HandlerError{{baseCommit.error()}};
        auto headCommit = resolveCommit(repo.value(), head);
        if (!headCommit) throw rpc::HandlerError{{headCommit.error()}};
        auto baseTree = commitTree(baseCommit.value().get());
        if (!baseTree) throw rpc::HandlerError{{baseTree.error()}};
        auto headTree = commitTree(headCommit.value().get());
        if (!headTree) throw rpc::HandlerError{{headTree.error()}};

        git_diff* rawDiff = nullptr;
        if (git_diff_tree_to_tree(&rawDiff, repo.value().raw(), baseTree.value().get(),
                                  headTree.value().get(), nullptr) != 0) {
          throw rpc::HandlerError{{core::gitError("diff " + base + ".." + head)}};
        }
        core::DiffPtr diff(rawDiff);
        return {{"files", fileChangesJson(diff.get(), token)}};
      },
      rpc::Mode::Concurrent);

  // Hunks of one file's staged or unstaged diff, for hunk staging. Lines are
  // unified-diff lines prefixed ' ', '+', '-'; "no newline at end of file"
  // markers are omitted (stage/hunks rebuilds its patch from a fresh diff, so
  // fidelity is preserved where it matters).
  dispatcher.method(
      "diff/fileHunks",
      [&context](const rpc::Json& params, const CancelToken& token,
                 const rpc::NotifyFn&) -> rpc::Json {
        const std::string path = requireString(params, "path");
        const bool staged = params.value("staged", false);
        auto repo = context.registry.open(params.value("repoId", ""));
        if (!repo) throw rpc::HandlerError{{repo.error()}};

        auto diff = status_detail::singleFileDiff(repo.value(), path, staged);
        if (!diff) throw rpc::HandlerError{{diff.error()}};

        rpc::Json hunks = rpc::Json::array();
        if (git_diff_num_deltas(diff.value().get()) == 0) {
          return {{"hunks", std::move(hunks)}};  // no changes for this path
        }
        git_patch* rawPatch = nullptr;
        if (git_patch_from_diff(&rawPatch, diff.value().get(), 0) != 0) {
          throw rpc::HandlerError{{core::gitError("build patch for '" + path + "'")}};
        }
        core::PatchPtr patch(rawPatch);
        const size_t hunkCount = git_patch_num_hunks(patch.get());
        for (size_t h = 0; h < hunkCount; ++h) {
          token.throwIfCancelled();
          const git_diff_hunk* hunk = nullptr;
          size_t lineCount = 0;
          if (git_patch_get_hunk(&hunk, &lineCount, patch.get(), h) != 0) {
            throw rpc::HandlerError{{core::gitError("read hunk of '" + path + "'")}};
          }
          std::string header(hunk->header, hunk->header_len);
          while (!header.empty() && (header.back() == '\n' || header.back() == '\r')) {
            header.pop_back();
          }
          rpc::Json lines = rpc::Json::array();
          for (size_t l = 0; l < lineCount; ++l) {
            const git_diff_line* line = nullptr;
            if (git_patch_get_line_in_hunk(&line, patch.get(), h, l) != 0) {
              throw rpc::HandlerError{{core::gitError("read line of '" + path + "'")}};
            }
            char prefix = 0;
            switch (line->origin) {
              case GIT_DIFF_LINE_CONTEXT:
                prefix = ' ';
                break;
              case GIT_DIFF_LINE_ADDITION:
                prefix = '+';
                break;
              case GIT_DIFF_LINE_DELETION:
                prefix = '-';
                break;
              default:
                continue;  // end-of-file newline markers
            }
            std::string content(line->content, line->content_len);
            if (!content.empty() && content.back() == '\n') content.pop_back();
            if (!content.empty() && content.back() == '\r') content.pop_back();
            lines.push_back(prefix + content);
          }
          hunks.push_back({{"header", std::move(header)},
                           {"oldStart", hunk->old_start},
                           {"oldLines", hunk->old_lines},
                           {"newStart", hunk->new_start},
                           {"newLines", hunk->new_lines},
                           {"lines", std::move(lines)}});
        }
        return {{"hunks", std::move(hunks)}};
      },
      rpc::Mode::Concurrent);
}

}  // namespace gg::services
