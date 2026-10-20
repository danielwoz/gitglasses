#include "services/status/diff_common.h"

#include <algorithm>
#include <cctype>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <system_error>
#include <utility>

#include "exec/git_runner.h"
#include "rpc/dispatcher.h"
#include "util/utf8_path.h"

namespace gg::services::status_detail {

namespace {

// Bytes of path arguments per git invocation. UTF-8 never takes fewer bytes
// than UTF-16 takes code units, so this bounds the Windows command line too,
// leaving room for the executable, the working directory and the options.
constexpr size_t kArgvBudget = 16 * 1024;

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

bool isRegularFileMode(std::uint32_t mode) {
  return mode == GIT_FILEMODE_BLOB || mode == GIT_FILEMODE_BLOB_EXECUTABLE;
}

// A filesystem path from UTF-8 text (see util::pathFromUtf8).
inline std::filesystem::path pathFromUtf8(const std::string& text) {
  return util::pathFromUtf8(text);
}

std::string lowercase(std::string text) {
  for (char& c : text) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
  return text;
}

// The attribute's value when it is set to a string (`filter=lfs`), else "".
std::string stringAttribute(git_repository* repo, const std::string& path, const char* name) {
  const char* value = nullptr;
  if (git_attr_get(&value, repo, GIT_ATTR_CHECK_FILE_THEN_INDEX, path.c_str(), name) != 0) {
    return {};
  }
  return git_attr_value(value) == GIT_ATTR_VALUE_STRING ? std::string(value) : std::string();
}

bool parseHunkHeader(const std::string& line, HunkBlock& out) {
  if (line.rfind("@@ -", 0) != 0) return false;
  const char* p = line.c_str() + 4;
  char* end = nullptr;
  out.oldStart = std::strtol(p, &end, 10);
  if (end == p) return false;
  p = end;
  out.oldLines = 1;
  if (*p == ',') {
    ++p;
    out.oldLines = std::strtol(p, &end, 10);
    if (end == p) return false;
    p = end;
  }
  if (p[0] != ' ' || p[1] != '+') return false;
  p += 2;
  out.newStart = std::strtol(p, &end, 10);
  if (end == p) return false;
  p = end;
  out.newLines = 1;
  if (*p == ',') {
    ++p;
    out.newLines = std::strtol(p, &end, 10);
    if (end == p) return false;
    p = end;
  }
  if (std::strncmp(p, " @@", 3) != 0) return false;
  out.trailing = std::string(p + 3);
  return true;
}

}  // namespace

Result<core::TreePtr> commitTree(git_commit* commit) {
  git_tree* tree = nullptr;
  if (git_commit_tree(&tree, commit) != 0) return core::gitError("read commit tree");
  return core::TreePtr(tree);
}

Result<core::CommitPtr> resolveCommit(const core::Repo& repo, const std::string& rev) {
  git_object* raw = nullptr;
  if (git_revparse_single(&raw, repo.raw(), rev.c_str()) != 0) {
    return core::gitError("resolve '" + rev + "'");
  }
  core::ObjectPtr object(raw);
  git_object* peeled = nullptr;
  if (git_object_peel(&peeled, object.get(), GIT_OBJECT_COMMIT) != 0) {
    return core::gitError("'" + rev + "' does not point to a commit");
  }
  return core::CommitPtr(reinterpret_cast<git_commit*>(peeled));
}

Result<core::DiffPtr> commitDiff(const core::Repo& repo, git_commit* commit) {
  auto tree = commitTree(commit);
  if (!tree) return tree.error();

  core::TreePtr parentTree;
  if (git_commit_parentcount(commit) > 0) {
    git_commit* rawParent = nullptr;
    if (git_commit_parent(&rawParent, commit, 0) != 0) {
      return core::gitError("lookup parent of " + core::oidToHex(*git_commit_id(commit)));
    }
    core::CommitPtr parent(rawParent);
    auto parentTreeResult = commitTree(parent.get());
    if (!parentTreeResult) return parentTreeResult.error();
    parentTree = std::move(parentTreeResult.value());
  }

  git_diff* rawDiff = nullptr;
  if (git_diff_tree_to_tree(&rawDiff, repo.raw(), parentTree.get(), tree.value().get(), nullptr) !=
      0) {
    return core::gitError("diff commit " + core::oidToHex(*git_commit_id(commit)));
  }
  return core::DiffPtr(rawDiff);
}

Result<std::vector<TreeFileChange>> treeFileChanges(git_diff* diff, const CancelToken& token,
                                                    std::size_t limit, std::size_t& total) {
  git_diff_find_options findOpts;
  git_diff_find_options_init(&findOpts, GIT_DIFF_FIND_OPTIONS_VERSION);
  if (git_diff_find_similar(diff, &findOpts) != 0) return core::gitError("detect renames");

  total = git_diff_num_deltas(diff);
  const std::size_t count = std::min(total, limit);
  std::vector<TreeFileChange> files;
  files.reserve(count);
  for (std::size_t i = 0; i < count; ++i) {
    token.throwIfCancelled();
    const git_diff_delta* delta = git_diff_get_delta(diff, i);
    TreeFileChange file;
    file.path = delta->new_file.path ? delta->new_file.path : "";
    file.status = statusLetter(delta->status);
    if ((file.status == 'R' || file.status == 'C') && delta->old_file.path) {
      file.origPath = delta->old_file.path;
    }
    file.binary = (delta->flags & GIT_DIFF_FLAG_BINARY) != 0;
    if (!file.binary) {
      git_patch* rawPatch = nullptr;
      if (git_patch_from_diff(&rawPatch, diff, i) == 0 && rawPatch) {
        core::PatchPtr patch(rawPatch);
        // Building the patch loads both sides, which is when binary content
        // is detected.
        file.binary = (git_patch_get_delta(patch.get())->flags & GIT_DIFF_FLAG_BINARY) != 0;
        size_t contextLines = 0, additions = 0, deletions = 0;
        if (!file.binary &&
            git_patch_line_stats(&contextLines, &additions, &deletions, patch.get()) == 0) {
          file.additions = additions;
          file.deletions = deletions;
        }
      }
    }
    files.push_back(std::move(file));
  }
  return files;
}

Result<core::DiffPtr> singleFileDiff(const core::Repo& repo, const std::string& path, bool staged) {
  git_diff_options opts;
  git_diff_options_init(&opts, GIT_DIFF_OPTIONS_VERSION);
  char* pathspec[] = {const_cast<char*>(path.c_str())};
  opts.pathspec.strings = pathspec;
  opts.pathspec.count = 1;
  opts.flags |= GIT_DIFF_DISABLE_PATHSPEC_MATCH;

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

const git_diff_delta* deltaForPath(git_diff* diff, const std::string& path, size_t* index) {
  const size_t count = git_diff_num_deltas(diff);
  for (size_t i = 0; i < count; ++i) {
    const git_diff_delta* delta = git_diff_get_delta(diff, i);
    const char* name = delta->new_file.path ? delta->new_file.path : delta->old_file.path;
    if (name && path == name) {
      if (index) *index = i;
      return delta;
    }
  }
  return nullptr;
}

std::string PathFilter::describe() const {
  std::string text;
  if (!driver.empty()) text = "the '" + driver + "' filter";
  if (!encoding.empty()) {
    if (!text.empty()) text += " and ";
    text += "working-tree-encoding " + encoding;
  }
  return text;
}

PathFilter pathFilter(git_repository* repo, const std::string& path) {
  PathFilter filter;
  filter.driver = stringAttribute(repo, path, "filter");
  // Git skips the conversion when the declared encoding is already UTF-8.
  std::string encoding = stringAttribute(repo, path, "working-tree-encoding");
  const std::string folded = lowercase(encoding);
  if (folded != "utf-8" && folded != "utf8") filter.encoding = std::move(encoding);
  return filter;
}

Result<core::IndexPtr> readIndex(git_repository* repo) {
  git_index* rawIndex = nullptr;
  if (git_repository_index(&rawIndex, repo) != 0) return core::gitError("open index");
  core::IndexPtr index(rawIndex);
  if (git_index_read(index.get(), /*force=*/0) != 0) return core::gitError("read index");
  return index;
}

bool skipWorktree(git_index* index, const char* path) {
  const git_index_entry* entry = git_index_get_bypath(index, path, 0);
  return entry && (entry->flags_extended & GIT_INDEX_ENTRY_SKIP_WORKTREE) != 0;
}

bool workdirHas(const core::Repo& repo, const std::string& path) {
  std::error_code ec;
  const auto status =
      std::filesystem::symlink_status(pathFromUtf8(repo.workdir()) / pathFromUtf8(path), ec);
  return status.type() != std::filesystem::file_type::not_found;
}

bool indexHas(git_index* index, const std::string& path) {
  for (int stage = 0; stage <= 3; ++stage) {
    if (git_index_get_bypath(index, path.c_str(), stage)) return true;
  }
  size_t position = 0;
  return git_index_find_prefix(&position, index, (path + "/").c_str()) == 0;
}

bool workdirSideHidden(git_index* index, const git_status_entry& entry) {
  const git_diff_delta* delta = entry.index_to_workdir;
  if (!delta) return false;
  const char* path = delta->old_file.path ? delta->old_file.path : delta->new_file.path;
  if (path && index && skipWorktree(index, path)) return true;
  // A dirty submodule carries its checked-out commit as the new id; when that
  // is still the recorded commit, only the submodule's own tree changed.
  return (entry.status & GIT_STATUS_WT_MODIFIED) != 0 &&
         delta->old_file.mode == GIT_FILEMODE_COMMIT &&
         delta->new_file.mode == GIT_FILEMODE_COMMIT && !git_oid_is_zero(&delta->new_file.id) &&
         git_oid_equal(&delta->old_file.id, &delta->new_file.id);
}

bool needsCleanRecheck(git_repository* repo, const git_status_entry& entry) {
  const git_diff_delta* delta = entry.index_to_workdir;
  if (!delta || (entry.status & GIT_STATUS_WT_MODIFIED) == 0 || !delta->new_file.path) {
    return false;
  }
  if (!isRegularFileMode(delta->old_file.mode) || !isRegularFileMode(delta->new_file.mode)) {
    return false;
  }
  // A changed executable bit is a change whatever the content, and the
  // recheck compares content only.
  if (delta->old_file.mode != delta->new_file.mode) return false;
  return pathFilter(repo, delta->new_file.path).any();
}

std::vector<bool> confirmCleanChanges(const core::Repo& repo,
                                      const std::vector<CleanRecheck>& candidates,
                                      const CancelToken& token) {
  std::vector<bool> changed(candidates.size(), true);
  std::vector<std::string> paths;
  paths.reserve(candidates.size());
  for (const auto& candidate : candidates) paths.push_back(candidate.path);

  size_t offset = 0;
  for (auto& batch : argvBatches(paths)) {
    const size_t size = batch.size();
    std::vector<std::string> args = {"hash-object", "--"};
    for (auto& path : batch) args.push_back(std::move(path));
    std::vector<std::string> ids;
    auto status =
        exec::runGit(repo.workdir(), std::move(args), {}, token, [&ids](std::string line) {
          if (!line.empty() && line.back() == '\r') line.pop_back();
          ids.push_back(std::move(line));
        });
    if (status && status.value().exitCode == 0 && ids.size() == size) {
      for (size_t i = 0; i < size; ++i) {
        changed[offset + i] = ids[i] != core::oidToHex(candidates[offset + i].indexId);
      }
    }
    offset += size;
  }
  return changed;
}

std::string runGitChecked(const core::Repo& repo, std::vector<std::string> args,
                          const CancelToken& token, const std::string& what, int alsoOk,
                          std::chrono::milliseconds timeout) {
  exec::RunOpts opts;
  opts.rawOutput = true;
  opts.timeout = timeout;
  std::string output;
  auto status = exec::runGit(repo.workdir(), std::move(args), opts, token,
                             [&output](std::string chunk) { output = std::move(chunk); });
  if (!status) throw rpc::HandlerError{{status.error()}};
  const int code = status.value().exitCode;
  if (code != 0 && code != alsoOk) {
    throw rpc::HandlerError{{ErrorCode::GitError, what + " failed (" + std::to_string(code) +
                                                      "): " + status.value().stderrText}};
  }
  return output;
}

std::vector<std::vector<std::string>> argvBatches(const std::vector<std::string>& paths) {
  std::vector<std::vector<std::string>> batches;
  size_t used = kArgvBudget;
  for (const auto& path : paths) {
    // Quotes and a separating space on top of the path itself.
    const size_t cost = path.size() + 3;
    if (batches.empty() || (used + cost > kArgvBudget && !batches.back().empty())) {
      batches.emplace_back();
      used = 0;
    }
    batches.back().push_back(path);
    used += cost;
  }
  return batches;
}

void splitPatch(const std::string& text, std::string& header, std::vector<HunkBlock>& blocks) {
  size_t pos = 0;
  while (pos < text.size()) {
    size_t eol = text.find('\n', pos);
    const size_t lineEnd = eol == std::string::npos ? text.size() : eol + 1;
    std::string line = text.substr(pos, lineEnd - pos);
    std::string bare = line;
    while (!bare.empty() && (bare.back() == '\n' || bare.back() == '\r')) bare.pop_back();
    HunkBlock parsed;
    if (parseHunkHeader(bare, parsed)) {
      parsed.headerLine = std::move(line);
      blocks.push_back(std::move(parsed));
    } else if (blocks.empty()) {
      header += line;
    } else {
      blocks.back().body += line;
    }
    pos = lineEnd;
  }
}

FilePatch filePatch(const core::Repo& repo, const std::string& path, bool staged, bool cliAvailable,
                    const CancelToken& token) {
  FilePatch patch;
  if (!staged) {
    // Git treats a skip-worktree entry as unchanged whatever the working
    // tree holds, so the absent file of an out-of-cone entry is no deletion.
    auto index = readIndex(repo.raw());
    if (!index) throw rpc::HandlerError{{index.error()}};
    if (skipWorktree(index.value().get(), path.c_str())) return patch;
  }
  auto diff = singleFileDiff(repo, path, staged);
  if (!diff) throw rpc::HandlerError{{diff.error()}};
  size_t index = 0;
  const git_diff_delta* delta = deltaForPath(diff.value().get(), path, &index);
  if (!delta) return patch;
  if (delta->old_file.mode == GIT_FILEMODE_COMMIT || delta->new_file.mode == GIT_FILEMODE_COMMIT) {
    patch.gitlink = true;
    return patch;
  }
  patch.filter = pathFilter(repo.raw(), path);

  // Both sides of a staged diff are blobs git already stores, so only the
  // working-tree side ever needs cleaning.
  if (!staged && patch.filter.any()) {
    if (!cliAvailable) {
      throw rpc::HandlerError{
          {ErrorCode::FilterNeedsGitCli,
           "'" + path + "' goes through " + patch.filter.describe() +
               ", which only the git CLI can apply, and this engine has no git CLI"}};
    }
    // A new file has no index side; --no-index against /dev/null still runs
    // the clean filter on it and yields a patch `git apply --cached` accepts.
    const bool untracked = delta->status == GIT_DELTA_UNTRACKED;
    std::vector<std::string> args = untracked
                                        ? std::vector<std::string>{"diff", "--no-index"}
                                        : std::vector<std::string>{"--literal-pathspecs", "diff"};
    // Pinned output options: the patch is parsed and re-applied, so user
    // configuration (external diff tools, textconv, colour, prefixes,
    // context size) must not reshape it.
    for (const char* arg : {"--no-ext-diff", "--no-textconv", "--no-color", "--no-renames",
                            "--src-prefix=a/", "--dst-prefix=b/", "-U3", "--"}) {
      args.emplace_back(arg);
    }
    if (untracked) args.emplace_back("/dev/null");
    args.push_back(path);
    // `git diff --no-index` exits 1 when the inputs differ.
    patch.text = runGitChecked(repo, std::move(args), token, "git diff", untracked ? 1 : 0);
    patch.viaCli = true;
    return patch;
  }

  git_patch* rawPatch = nullptr;
  if (git_patch_from_diff(&rawPatch, diff.value().get(), index) != 0) {
    throw rpc::HandlerError{{core::gitError("build patch for '" + path + "'")}};
  }
  if (!rawPatch) return patch;  // unchanged
  core::PatchPtr owned(rawPatch);
  core::BufDisposer buf;
  if (git_patch_to_buf(&buf.buf, owned.get()) != 0) {
    throw rpc::HandlerError{{core::gitError("format patch for '" + path + "'")}};
  }
  patch.text.assign(buf.buf.ptr, buf.buf.size);
  return patch;
}

}  // namespace gg::services::status_detail
