#include "services/status/diff_methods.h"

#include <git2.h>

#include <cstddef>
#include <limits>
#include <string>
#include <utility>
#include <vector>

#include "core/git2.h"
#include "services/params.h"
#include "services/status/diff_common.h"

namespace gg::services {

namespace {

using status_detail::commitTree;
using status_detail::resolveCommit;

// FileChange list for a tree diff: rename detection on, per-file line stats
// from the generated patch (0 for binary files).
rpc::Json fileChangesJson(git_diff* diff, const CancelToken& token) {
  std::size_t total = 0;
  auto changes =
      status_detail::treeFileChanges(diff, token, std::numeric_limits<std::size_t>::max(), total);
  if (!changes) throw rpc::HandlerError{{changes.error()}};
  rpc::Json files = rpc::Json::array();
  for (const auto& change : changes.value()) {
    rpc::Json file = {{"path", change.path},
                      {"status", std::string(1, change.status)},
                      {"additions", change.additions},
                      {"deletions", change.deletions}};
    if (!change.origPath.empty()) file["origPath"] = change.origPath;
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
        auto diff = status_detail::commitDiff(repo.value(), commit.value().get());
        if (!diff) throw rpc::HandlerError{{diff.error()}};
        return {{"files", fileChangesJson(diff.value().get(), token)}};
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
  // fidelity is preserved where it matters). The working-tree side of a path
  // with a filter driver or working-tree-encoding is the cleaned content git
  // would store, so the hunks are the ones `git diff` shows. Submodules have
  // no hunks.
  dispatcher.method(
      "diff/fileHunks",
      [&context](const rpc::Json& params, const CancelToken& token,
                 const rpc::NotifyFn&) -> rpc::Json {
        const std::string path = requireString(params, "path");
        const bool staged = params.value("staged", false);
        auto repo = context.registry.open(params.value("repoId", ""));
        if (!repo) throw rpc::HandlerError{{repo.error()}};

        const status_detail::FilePatch patch =
            status_detail::filePatch(repo.value(), path, staged, context.cliAvailable, token);
        rpc::Json hunks = rpc::Json::array();
        if (patch.gitlink) return {{"hunks", std::move(hunks)}};

        std::string header;
        std::vector<status_detail::HunkBlock> blocks;
        status_detail::splitPatch(patch.text, header, blocks);
        for (const auto& block : blocks) {
          token.throwIfCancelled();
          std::string headerText = block.headerLine;
          while (!headerText.empty() && (headerText.back() == '\n' || headerText.back() == '\r')) {
            headerText.pop_back();
          }
          rpc::Json lines = rpc::Json::array();
          size_t pos = 0;
          while (pos < block.body.size()) {
            const size_t eol = block.body.find('\n', pos);
            const size_t end = eol == std::string::npos ? block.body.size() : eol;
            std::string line = block.body.substr(pos, end - pos);
            pos = end + 1;
            if (!line.empty() && line.back() == '\r') line.pop_back();
            // diff.suppressBlankEmpty writes an empty context line bare.
            if (line.empty()) line = " ";
            if (line[0] != ' ' && line[0] != '+' && line[0] != '-') continue;  // EOF markers
            lines.push_back(std::move(line));
          }
          hunks.push_back({{"header", std::move(headerText)},
                           {"oldStart", block.oldStart},
                           {"oldLines", block.oldLines},
                           {"newStart", block.newStart},
                           {"newLines", block.newLines},
                           {"lines", std::move(lines)}});
        }
        return {{"hunks", std::move(hunks)}};
      },
      rpc::Mode::Concurrent);
}

}  // namespace gg::services
