#include "services/status/stage_methods.h"

#include <git2.h>

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <memory>
#include <string>
#include <utility>
#include <vector>

#include "exec/git_process.h"
#include "services/status/diff_common.h"
#include "util/temp_file.h"

namespace gg::services {

namespace {

using status_detail::DiffPtr;
using status_detail::PatchPtr;
using status_detail::statusGitError;

struct IndexDeleter {
  void operator()(git_index* index) const { git_index_free(index); }
};
using IndexPtr = std::unique_ptr<git_index, IndexDeleter>;

struct ObjectDeleter {
  void operator()(git_object* object) const { git_object_free(object); }
};
using ObjectPtr = std::unique_ptr<git_object, ObjectDeleter>;

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

// One "@@ -o,l +n,m @@ ..." block of a unified-diff patch.
struct HunkBlock {
  long oldStart = 0;
  long oldLines = 1;
  long newStart = 0;
  long newLines = 1;
  std::string trailing;   // header text after the closing "@@" (function context)
  std::string headerLine; // the original @@ line, including newline
  std::string body;       // hunk lines, each including its newline
};

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

// Splits a single-file patch into its file header and hunk blocks.
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

// Rebuilds a patch containing only the selected hunks. For forward
// application the new-side start of each kept hunk is renumbered as if the
// dropped hunks did not exist; for reverse application (`selected` hunks are
// removed from the index) the recorded numbers are already absolute on the
// source side, so they are kept verbatim.
std::string buildSubsetPatch(const std::string& header, const std::vector<HunkBlock>& blocks,
                             const std::vector<bool>& selected, bool renumber) {
  std::string out = header;
  long cumulativeAll = 0;
  long cumulativeKept = 0;
  for (size_t i = 0; i < blocks.size(); ++i) {
    const HunkBlock& block = blocks[i];
    const long delta = block.newLines - block.oldLines;
    if (selected[i]) {
      if (renumber) {
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

// Writes `contents` to a throwaway file for `git apply`; removed by caller.
Result<std::filesystem::path> writeTempPatch(const std::string& contents) {
  const std::filesystem::path file = util::randomTempPath("gg-hunk-", ".patch");
  std::FILE* f = std::fopen(file.string().c_str(), "wb");
  if (!f) return Error{ErrorCode::Internal, "cannot create temp patch file"};
  const size_t written = std::fwrite(contents.data(), 1, contents.size(), f);
  std::fclose(f);
  if (written != contents.size()) {
    std::error_code ec;
    std::filesystem::remove(file, ec);
    return Error{ErrorCode::Internal, "cannot write temp patch file"};
  }
  return file;
}

}  // namespace

void registerStageMethods(rpc::Dispatcher& dispatcher, ServiceContext& context) {
  // Whole-file stage/unstage. Serial: index writes must not interleave.
  dispatcher.method(
      "stage/files",
      [&context](const rpc::Json& params, const CancelToken&, const rpc::NotifyFn&) -> rpc::Json {
        const std::string action = requireAction(params);
        const rpc::Json paths = params.value("paths", rpc::Json::array());
        if (!paths.is_array() || paths.empty()) {
          throw rpc::HandlerError{
              {ErrorCode::InvalidParams, "'paths' must be a non-empty array"}};
        }
        auto repo = openWorktreeRepo(context, params);
        if (!repo) throw rpc::HandlerError{{repo.error()}};
        git_repository* raw = repo.value().raw();

        if (action == "stage") {
          git_index* rawIndex = nullptr;
          if (git_repository_index(&rawIndex, raw) != 0) {
            throw rpc::HandlerError{{statusGitError("open index")}};
          }
          IndexPtr index(rawIndex);
          for (const auto& entry : paths) {
            const std::string path = entry.get<std::string>();
            // A path deleted from the working tree stages as a removal.
            std::error_code ec;
            const bool exists = std::filesystem::symlink_status(
                                    std::filesystem::path(repo.value().workdir()) / path, ec)
                                    .type() != std::filesystem::file_type::not_found;
            const int rc = exists ? git_index_add_bypath(index.get(), path.c_str())
                                  : git_index_remove_bypath(index.get(), path.c_str());
            if (rc != 0) throw rpc::HandlerError{{statusGitError("stage '" + path + "'")}};
          }
          if (git_index_write(index.get()) != 0) {
            throw rpc::HandlerError{{statusGitError("write index")}};
          }
        } else {
          // git_reset_default restores index entries from HEAD's tree (or
          // removes them when HEAD is unborn or lacks the path).
          ObjectPtr head;
          auto headState = repo.value().head();
          if (!headState) throw rpc::HandlerError{{headState.error()}};
          if (!headState.value().unborn) {
            git_object* rawHead = nullptr;
            if (git_revparse_single(&rawHead, raw, "HEAD") != 0) {
              throw rpc::HandlerError{{statusGitError("resolve HEAD")}};
            }
            head.reset(rawHead);
          }
          std::vector<std::string> owned;
          for (const auto& entry : paths) owned.push_back(entry.get<std::string>());
          std::vector<char*> pointers;
          pointers.reserve(owned.size());
          for (auto& path : owned) pointers.push_back(path.data());
          git_strarray pathspec{pointers.data(), pointers.size()};
          if (git_reset_default(raw, head.get(), &pathspec) != 0) {
            throw rpc::HandlerError{{statusGitError("unstage paths")}};
          }
        }
        return rpc::Json::object();
      },
      rpc::Mode::Serial);

  // Hunk-level staging. A fresh single-file diff is taken and the requested
  // hunks are matched by their recorded ranges; a stale request (the file
  // changed since the client's diff/fileHunks call) fails instead of applying
  // the wrong lines. Stage applies the subset patch to the index via
  // libgit2's git_apply; unstage reverse-applies it through `git apply
  // --cached --reverse` (libgit2 has no reverse apply, and the CLI keeps
  // "no newline" marker semantics correct in reverse).
  dispatcher.method(
      "stage/hunks",
      [&context](const rpc::Json& params, const CancelToken& token,
                 const rpc::NotifyFn&) -> rpc::Json {
        const std::string action = requireAction(params);
        // Unstaging hunks reverse-applies through the git CLI (libgit2 has no
        // reverse apply); staging stays libgit2-only and needs no CLI.
        if (action == "unstage") requireGitCli(context);
        const std::string path = params.value("path", "");
        const rpc::Json requested = params.value("hunks", rpc::Json::array());
        if (path.empty()) {
          throw rpc::HandlerError{{ErrorCode::InvalidParams, "'path' is required"}};
        }
        if (!requested.is_array() || requested.empty()) {
          throw rpc::HandlerError{
              {ErrorCode::InvalidParams, "'hunks' must be a non-empty array"}};
        }
        auto repo = openWorktreeRepo(context, params);
        if (!repo) throw rpc::HandlerError{{repo.error()}};

        const bool staged = action == "unstage";
        auto diff = status_detail::singleFileDiff(repo.value(), path, staged);
        if (!diff) throw rpc::HandlerError{{diff.error()}};
        if (git_diff_num_deltas(diff.value().get()) == 0) {
          throw rpc::HandlerError{
              {ErrorCode::GitError, "no " + std::string(staged ? "staged" : "unstaged") +
                                        " changes for '" + path + "'"}};
        }
        git_patch* rawPatch = nullptr;
        if (git_patch_from_diff(&rawPatch, diff.value().get(), 0) != 0) {
          throw rpc::HandlerError{{statusGitError("build patch for '" + path + "'")}};
        }
        PatchPtr patch(rawPatch);
        git_buf buf = GIT_BUF_INIT;
        if (git_patch_to_buf(&buf, patch.get()) != 0) {
          throw rpc::HandlerError{{statusGitError("format patch for '" + path + "'")}};
        }
        std::string patchText(buf.ptr, buf.size);
        git_buf_dispose(&buf);

        std::string header;
        std::vector<HunkBlock> blocks;
        splitPatch(patchText, header, blocks);

        std::vector<bool> selected(blocks.size(), false);
        size_t matched = 0;
        for (const auto& want : requested) {
          token.throwIfCancelled();
          const long oldStart = want.value("oldStart", -1L);
          const long oldLines = want.value("oldLines", -1L);
          const long newStart = want.value("newStart", -1L);
          const long newLines = want.value("newLines", -1L);
          bool found = false;
          for (size_t i = 0; i < blocks.size(); ++i) {
            if (!selected[i] && blocks[i].oldStart == oldStart &&
                blocks[i].oldLines == oldLines && blocks[i].newStart == newStart &&
                blocks[i].newLines == newLines) {
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

        if (action == "stage") {
          git_diff* rawSubset = nullptr;
          if (git_diff_from_buffer(&rawSubset, subset.data(), subset.size()) != 0) {
            throw rpc::HandlerError{{statusGitError("parse subset patch")}};
          }
          DiffPtr subsetDiff(rawSubset);
          if (git_apply(repo.value().raw(), subsetDiff.get(), GIT_APPLY_LOCATION_INDEX,
                        nullptr) != 0) {
            throw rpc::HandlerError{{statusGitError("apply hunks to index")}};
          }
        } else {
          auto file = writeTempPatch(subset);
          if (!file) throw rpc::HandlerError{{file.error()}};
          auto process = exec::GitProcess::spawn(
              repo.value().workdir(),
              {"apply", "--cached", "--reverse", file.value().string()});
          if (!process) {
            std::error_code ec;
            std::filesystem::remove(file.value(), ec);
            throw rpc::HandlerError{{process.error()}};
          }
          std::string line;
          while (process.value().readLine(line, token)) {
          }
          const int exitCode = process.value().wait(token);
          std::error_code ec;
          std::filesystem::remove(file.value(), ec);
          if (exitCode != 0) {
            throw rpc::HandlerError{
                {ErrorCode::GitError, "git apply --cached --reverse failed (" +
                                          std::to_string(exitCode) +
                                          "): " + process.value().stderrOutput()}};
          }
        }
        return rpc::Json::object();
      },
      rpc::Mode::Serial);
}

}  // namespace gg::services
