#include "services/mutate/mutate_methods.h"

#include <string>
#include <utility>
#include <vector>

#include "services/mutate/mutate_common.h"
#include "services/params.h"

namespace gg::services {

namespace {

using mutate_detail::headSha;
using mutate_detail::openRepo;
using mutate_detail::runConflictAware;
using mutate_detail::runGit;
using mutate_detail::requirePositional;
using mutate_detail::requirePositionals;
using mutate_detail::runGitOrThrow;

}  // namespace

void registerMutateMethods(rpc::Dispatcher& dispatcher, ServiceContext& context) {
  dispatcher.method(
      "mutate/commit",
      [&context](const rpc::Json& params, const CancelToken& token,
                 const rpc::NotifyFn&) -> rpc::Json {
        requireGitCli(context);
        const std::string message = requireString(params, "message");
        auto repo = openRepo(context, params);
        std::vector<std::string> args = {"commit", "-m", message};
        if (params.value("amend", false)) args.push_back("--amend");
        if (params.value("signoff", false)) args.push_back("--signoff");
        runGitOrThrow(repo, std::move(args), token, "git commit");
        return {{"sha", headSha(repo, token)}};
      },
      rpc::Mode::Serial);

  dispatcher.method(
      "mutate/branchCreate",
      [&context](const rpc::Json& params, const CancelToken& token,
                 const rpc::NotifyFn&) -> rpc::Json {
        requireGitCli(context);
        const std::string name = requirePositional(requireString(params, "name"), "name");
        const std::string startPoint =
            requirePositional(params.value("startPoint", ""), "startPoint");
        auto repo = openRepo(context, params);
        std::vector<std::string> args;
        if (params.value("checkout", false)) {
          args = {"switch", "-c", name};
        } else {
          args = {"branch", "--"};
          args.push_back(name);
        }
        if (!startPoint.empty()) args.push_back(startPoint);
        runGitOrThrow(repo, std::move(args), token, "git branch create");
        return rpc::Json::object();
      },
      rpc::Mode::Serial);

  dispatcher.method(
      "mutate/branchDelete",
      [&context](const rpc::Json& params, const CancelToken& token,
                 const rpc::NotifyFn&) -> rpc::Json {
        requireGitCli(context);
        const std::string name = requirePositional(requireString(params, "name"), "name");
        auto repo = openRepo(context, params);
        runGitOrThrow(repo, {"branch", params.value("force", false) ? "-D" : "-d", "--", name},
                      token, "git branch delete");
        return rpc::Json::object();
      },
      rpc::Mode::Serial);

  dispatcher.method(
      "mutate/switch",
      [&context](const rpc::Json& params, const CancelToken& token,
                 const rpc::NotifyFn&) -> rpc::Json {
        requireGitCli(context);
        const std::string ref = requirePositional(requireString(params, "ref"), "ref");
        auto repo = openRepo(context, params);
        // A ref that is not a local branch (sha, tag, remote branch) needs an
        // explicit detach; `git switch` refuses it otherwise.
        auto probe = runGit(repo, {"show-ref", "--verify", "--quiet", "refs/heads/" + ref}, token);
        if (!probe) throw rpc::HandlerError{{probe.error()}};
        const bool isBranch = probe.value().exitCode == 0;
        std::vector<std::string> args = {"switch"};
        if (!isBranch) args.push_back("--detach");
        args.push_back("--");
        args.push_back(ref);
        runGitOrThrow(repo, std::move(args), token, "git switch");
        return rpc::Json::object();
      },
      rpc::Mode::Serial);

  dispatcher.method(
      "mutate/merge",
      [&context](const rpc::Json& params, const CancelToken& token,
                 const rpc::NotifyFn&) -> rpc::Json {
        requireGitCli(context);
        const std::string ref = requirePositional(requireString(params, "ref"), "ref");
        auto repo = openRepo(context, params);
        // --no-edit: the default merge-commit message is used; an editor must
        // never block a headless engine.
        std::vector<std::string> args = {"merge", "--no-edit"};
        if (params.value("noFf", false)) args.push_back("--no-ff");
        args.push_back(ref);
        return runConflictAware(repo, std::move(args), token, "git merge");
      },
      rpc::Mode::Serial);

  dispatcher.method(
      "mutate/cherryPick",
      [&context](const rpc::Json& params, const CancelToken& token,
                 const rpc::NotifyFn&) -> rpc::Json {
        requireGitCli(context);
        const std::vector<std::string> shas =
            requirePositionals(requireStringArray(params, "shas"), "shas");
        auto repo = openRepo(context, params);
        std::vector<std::string> args = {"cherry-pick"};
        args.insert(args.end(), shas.begin(), shas.end());
        return runConflictAware(repo, std::move(args), token, "git cherry-pick");
      },
      rpc::Mode::Serial);

  dispatcher.method(
      "mutate/revert",
      [&context](const rpc::Json& params, const CancelToken& token,
                 const rpc::NotifyFn&) -> rpc::Json {
        requireGitCli(context);
        const std::vector<std::string> shas =
            requirePositionals(requireStringArray(params, "shas"), "shas");
        auto repo = openRepo(context, params);
        std::vector<std::string> args = {"revert", "--no-edit"};
        args.insert(args.end(), shas.begin(), shas.end());
        return runConflictAware(repo, std::move(args), token, "git revert");
      },
      rpc::Mode::Serial);

  dispatcher.method(
      "mutate/reset",
      [&context](const rpc::Json& params, const CancelToken& token,
                 const rpc::NotifyFn&) -> rpc::Json {
        requireGitCli(context);
        // `git reset <tree-ish> [--] [<pathspec>]`: the ref must precede any
        // "--", so it cannot be separated and is validated instead.
        const std::string ref = requirePositional(requireString(params, "ref"), "ref");
        const std::string mode = params.value("mode", "");
        if (mode != "soft" && mode != "mixed" && mode != "hard") {
          throw rpc::HandlerError{
              {ErrorCode::InvalidParams, "'mode' must be 'soft', 'mixed' or 'hard'"}};
        }
        auto repo = openRepo(context, params);
        runGitOrThrow(repo, {"reset", "--" + mode, ref}, token, "git reset");
        return rpc::Json::object();
      },
      rpc::Mode::Serial);

  dispatcher.method(
      "mutate/fetch",
      [&context](const rpc::Json& params, const CancelToken& token,
                 const rpc::NotifyFn&) -> rpc::Json {
        requireGitCli(context);
        auto repo = openRepo(context, params);
        std::vector<std::string> args = {"fetch"};
        if (params.value("prune", false)) args.push_back("--prune");
        const std::string remote = requirePositional(params.value("remote", ""), "remote");
        if (!remote.empty()) {
          args.push_back("--");
          args.push_back(remote);
        }
        runGitOrThrow(repo, std::move(args), token, "git fetch");
        return rpc::Json::object();
      },
      rpc::Mode::Serial);

  dispatcher.method(
      "mutate/pull",
      [&context](const rpc::Json& params, const CancelToken& token,
                 const rpc::NotifyFn&) -> rpc::Json {
        requireGitCli(context);
        auto repo = openRepo(context, params);
        std::vector<std::string> args = {"pull"};
        if (params.value("autoStash", false)) args.push_back("--autostash");
        runGitOrThrow(repo, std::move(args), token, "git pull");
        return rpc::Json::object();
      },
      rpc::Mode::Serial);

  dispatcher.method(
      "mutate/push",
      [&context](const rpc::Json& params, const CancelToken& token,
                 const rpc::NotifyFn&) -> rpc::Json {
        requireGitCli(context);
        const std::string force = params.value("force", "");
        if (!force.empty() && force != "with-lease") {
          throw rpc::HandlerError{
              {ErrorCode::InvalidParams, "'force' must be 'with-lease' when present"}};
        }
        auto repo = openRepo(context, params);
        std::vector<std::string> args = {"push"};
        if (params.value("setUpstream", false)) {
          args.push_back("-u");
          args.push_back("origin");
          args.push_back("HEAD");
        }
        if (force == "with-lease") args.push_back("--force-with-lease");
        runGitOrThrow(repo, std::move(args), token, "git push");
        return rpc::Json::object();
      },
      rpc::Mode::Serial);
}

}  // namespace gg::services
