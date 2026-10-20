#include "services/mutate/stash_worktree_methods.h"

#include <cstdint>
#include <limits>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <utility>
#include <vector>

#include "exec/cli_detect.h"
#include "services/mutate/mutate_common.h"
#include "services/params.h"
#include "services/worktree/worktree_status.h"

namespace gg::services {

namespace {

using mutate_detail::openRepo;
using mutate_detail::requirePositional;
using mutate_detail::runConflictAware;
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
// blocks separated by blank lines. `current` marks the worktree `repo` serves.
rpc::Json parseWorktreePorcelain(const std::vector<std::string>& lines, const core::Repo& repo) {
  rpc::Json worktrees = rpc::Json::array();
  std::string path, branch, sha;
  bool bare = false, locked = false, prunable = false, open = false;
  const auto flush = [&] {
    if (!open) return;
    rpc::Json entry = {{"path", path},
                       {"sha", sha},
                       {"bare", bare},
                       {"locked", locked},
                       {"prunable", prunable},
                       {"missing", !bare && worktree::isMissingDirectory(path)},
                       {"current", worktree::isRepoDirectory(repo, path)}};
    if (!branch.empty()) entry["branch"] = branch;
    worktrees.push_back(std::move(entry));
    path.clear();
    branch.clear();
    sha.clear();
    bare = locked = prunable = open = false;
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
    } else if (line == "prunable" || lineHasPrefix(line, "prunable ")) {
      prunable = true;
    }
    // "detached" and unknown attributes carry no protocol field.
  }
  flush();
  return worktrees;
}

// The git on PATH, asked once per dispatcher the first time a merge check
// needs it rather than at startup.
class LazyGitVersion {
 public:
  std::optional<exec::GitVersion> get() {
    std::call_once(once_, [this] { version_ = exec::probeGitVersion(); });
    return version_;
  }

 private:
  std::once_flag once_;
  std::optional<exec::GitVersion> version_;
};

// The wasm engine reads only the workspace mirrored into its own file
// system, and linked worktrees live outside it: listing them would report
// every one as missing. The worktree reads are refused there instead.
void requireHostFileSystem() {
#ifdef GG_WASM
  throw rpc::HandlerError{{ErrorCode::MethodNotSupported,
                           "worktrees are not available in the web engine: linked worktrees lie "
                           "outside the mirrored workspace"}};
#endif
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
        const std::string message = requirePositional(optionalString(params, "message"), "message");
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

  // git's own listing when it may run; libgit2's otherwise (Restricted Mode,
  // builds without the CLI), which reads the same administrative files.
  dispatcher.method(
      "worktree/list",
      [&context](const rpc::Json& params, const CancelToken& token,
                 const rpc::NotifyFn&) -> rpc::Json {
        requireHostFileSystem();
        auto repo = openRepo(context, params);
        if (!context.cliAvailable) return {{"worktrees", worktree::listWithLibgit2(repo)}};
        auto output =
            runGitOrThrow(repo, {"worktree", "list", "--porcelain"}, token, "git worktree list");
        return {{"worktrees", parseWorktreePorcelain(output.lines, repo)}};
      },
      rpc::Mode::Concurrent);

  auto gitVersion = std::make_shared<LazyGitVersion>();
  dispatcher.method(
      "worktree/status",
      [&context, gitVersion](const rpc::Json& params, const CancelToken& token,
                             const rpc::NotifyFn&) -> rpc::Json {
        requireHostFileSystem();
        worktree::StatusRequest request;
        request.path = requireString(params, "path");
        request.base = requirePositional(optionalString(params, "base"), "base");
        request.cliAvailable = context.cliAvailable;
        request.restricted = context.restricted;
        auto repo = openRepo(context, params);
        if (context.cliAvailable) request.gitVersion = gitVersion->get();
        return worktree::status(repo, request, token);
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
