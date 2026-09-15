#include "services/mutate/stash_worktree_methods.h"

#include <cstdint>
#include <limits>
#include <string>
#include <utility>
#include <vector>

#include "services/mutate/mutate_common.h"
#include "services/params.h"

namespace gg::services {

namespace {

using mutate_detail::openRepo;
using mutate_detail::runConflictAware;
using mutate_detail::requirePositional;
using mutate_detail::runGitOrThrow;

std::string requireStashRef(const rpc::Json& params) {
  const std::int64_t index =
      requireInteger(params, "index", 0, std::numeric_limits<std::int64_t>::max());
  return "stash@{" + std::to_string(index) + "}";
}

bool lineHasPrefix(const std::string& line, const std::string& prefix) {
  return line.rfind(prefix, 0) == 0;
}

// Parses `git worktree list --porcelain`: one attribute block per worktree,
// blocks separated by blank lines.
rpc::Json parseWorktreePorcelain(const std::vector<std::string>& lines) {
  rpc::Json worktrees = rpc::Json::array();
  std::string path, branch, sha;
  bool bare = false, locked = false, open = false;
  const auto flush = [&] {
    if (!open) return;
    rpc::Json entry = {{"path", path}, {"sha", sha}, {"bare", bare}, {"locked", locked}};
    if (!branch.empty()) entry["branch"] = branch;
    worktrees.push_back(std::move(entry));
    path.clear();
    branch.clear();
    sha.clear();
    bare = locked = open = false;
  };
  for (const auto& line : lines) {
    if (line.empty()) {
      flush();
    } else if (lineHasPrefix(line, "worktree ")) {
      flush();  // porcelain always blank-line-separates, but stay tolerant
      path = line.substr(9);
      open = true;
    } else if (lineHasPrefix(line, "HEAD ")) {
      sha = line.substr(5);
    } else if (lineHasPrefix(line, "branch ")) {
      branch = line.substr(7);
      const std::string headsPrefix = "refs/heads/";
      if (lineHasPrefix(branch, headsPrefix)) branch = branch.substr(headsPrefix.size());
    } else if (line == "bare") {
      bare = true;
    } else if (line == "locked" || lineHasPrefix(line, "locked ")) {
      locked = true;
    }
    // "detached" and unknown attributes carry no protocol field.
  }
  flush();
  return worktrees;
}

}  // namespace

void registerStashWorktreeMethods(rpc::Dispatcher& dispatcher, ServiceContext& context) {
  dispatcher.method(
      "stash/push",
      [&context](const rpc::Json& params, const CancelToken& token,
                 const rpc::NotifyFn&) -> rpc::Json {
        requireGitCli(context);
        auto repo = openRepo(context, params);
        std::vector<std::string> args = {"stash", "push"};
        if (params.value("includeUntracked", false)) args.push_back("--include-untracked");
        const std::string message =
            requirePositional(optionalString(params, "message"), "message");
        if (!message.empty()) {
          args.push_back("-m");
          args.push_back(message);
        }
        runGitOrThrow(repo, std::move(args), token, "git stash push");
        return rpc::Json::object();
      },
      rpc::Mode::Serial);

  dispatcher.method(
      "stash/apply",
      [&context](const rpc::Json& params, const CancelToken& token,
                 const rpc::NotifyFn&) -> rpc::Json {
        requireGitCli(context);
        const std::string stashRef = requireStashRef(params);
        // Apply and pop are not interchangeable, so the caller states which.
        const bool pop = requireBool(params, "pop");
        auto repo = openRepo(context, params);
        // Conflict semantics mirror merge; on conflict git keeps the stash
        // entry even for pop.
        return runConflictAware(repo, {"stash", pop ? "pop" : "apply", stashRef}, token,
                                pop ? "git stash pop" : "git stash apply");
      },
      rpc::Mode::Serial);

  dispatcher.method(
      "stash/drop",
      [&context](const rpc::Json& params, const CancelToken& token,
                 const rpc::NotifyFn&) -> rpc::Json {
        requireGitCli(context);
        const std::string stashRef = requireStashRef(params);
        auto repo = openRepo(context, params);
        runGitOrThrow(repo, {"stash", "drop", stashRef}, token, "git stash drop");
        return rpc::Json::object();
      },
      rpc::Mode::Serial);

  dispatcher.method(
      "worktree/list",
      [&context](const rpc::Json& params, const CancelToken& token,
                 const rpc::NotifyFn&) -> rpc::Json {
        requireGitCli(context);
        auto repo = openRepo(context, params);
        auto output =
            runGitOrThrow(repo, {"worktree", "list", "--porcelain"}, token, "git worktree list");
        return {{"worktrees", parseWorktreePorcelain(output.lines)}};
      },
      rpc::Mode::Concurrent);

  dispatcher.method(
      "worktree/add",
      [&context](const rpc::Json& params, const CancelToken& token,
                 const rpc::NotifyFn&) -> rpc::Json {
        requireGitCli(context);
        const std::string path = requireString(params, "path");
        const std::string ref = requirePositional(requireString(params, "ref"), "ref");
        const std::string createBranch =
            requirePositional(optionalString(params, "createBranch"), "createBranch");
        auto repo = openRepo(context, params);
        std::vector<std::string> args = {"worktree", "add"};
        if (!createBranch.empty()) {
          args.push_back("-b");
          args.push_back(createBranch);
        }
        args.push_back("--");
        args.push_back(path);
        args.push_back(ref);
        runGitOrThrow(repo, std::move(args), token, "git worktree add");
        return rpc::Json::object();
      },
      rpc::Mode::Serial);

  dispatcher.method(
      "worktree/remove",
      [&context](const rpc::Json& params, const CancelToken& token,
                 const rpc::NotifyFn&) -> rpc::Json {
        requireGitCli(context);
        const std::string path = requireString(params, "path");
        auto repo = openRepo(context, params);
        std::vector<std::string> args = {"worktree", "remove"};
        if (params.value("force", false)) args.push_back("--force");
        args.push_back("--");
        args.push_back(path);
        runGitOrThrow(repo, std::move(args), token, "git worktree remove");
        return rpc::Json::object();
      },
      rpc::Mode::Serial);
}

}  // namespace gg::services
