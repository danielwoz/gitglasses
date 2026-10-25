#include "services/mutate/ref_methods.h"

#include <string>
#include <utility>
#include <vector>

#include "exec/git_process.h"
#include "services/mutate/mutate_common.h"
#include "services/params.h"

namespace gg::services {

namespace {

using mutate_detail::openRepo;
using mutate_detail::requirePositional;
using mutate_detail::runGit;
using mutate_detail::runGitOrThrow;

// A git config value, or "" when it is unset.
std::string configValue(const core::Repo& repo, const std::string& key, const CancelToken& token) {
  auto output = runGit(repo, {"config", "--get", key}, token);
  if (!output) throw rpc::HandlerError{{output.error()}};
  if (output.value().exitCode != 0 || output.value().lines.empty()) return "";
  return output.value().lines.front();
}

std::vector<std::string> remoteNames(const core::Repo& repo, const CancelToken& token) {
  return runGitOrThrow(repo, {"remote"}, token, "git remote").lines;
}

// The remote `git push` would pick for `branch`: its pushRemote, the
// repository's pushDefault, the remote it tracks, or the only remote there is.
std::string pushRemoteFor(const core::Repo& repo, const std::string& branch,
                          const CancelToken& token) {
  for (const std::string& key :
       {"branch." + branch + ".pushRemote", std::string("remote.pushDefault"),
        "branch." + branch + ".remote"}) {
    std::string value = configValue(repo, key, token);
    // "." names the local repository, which is no place to publish to.
    if (!value.empty() && value != ".") return value;
  }
  const std::vector<std::string> remotes = remoteNames(repo, token);
  if (remotes.size() == 1) return remotes.front();
  throw rpc::HandlerError{
      {ErrorCode::GitError, remotes.empty()
                                ? "the repository has no remote to push '" + branch + "' to"
                                : "'" + branch + "' has no configured remote; choose one of " +
                                      std::to_string(remotes.size()) + " remotes"}};
}

// The ref on `remote` that pushing `branch` updates. Publishing (setting the
// upstream) and pushing to a remote the branch does not track use the
// branch's own name, as `git push -u <remote> <branch>` does. Pushing a branch
// to the remote it tracks follows push.default: upstream/tracking update the
// tracked branch, current/matching/nothing use the branch's own name, and
// simple (git's default) refuses when the tracked branch has another name,
// so a branch started from origin/main never lands on origin/main unasked.
std::string pushDestination(const core::Repo& repo, const std::string& branch,
                            const std::string& remote, bool publishing, const CancelToken& token) {
  const std::string own = "refs/heads/" + branch;
  if (publishing || configValue(repo, "branch." + branch + ".remote", token) != remote) return own;
  const std::string merge = configValue(repo, "branch." + branch + ".merge", token);
  if (merge.empty() || merge == own) return own;
  const std::string mode = configValue(repo, "push.default", token);
  if (mode == "upstream" || mode == "tracking") return merge;
  if (mode == "current" || mode == "matching" || mode == "nothing") return own;
  const std::string tracked =
      merge.starts_with("refs/heads/") ? merge.substr(std::string("refs/heads/").size()) : merge;
  throw rpc::HandlerError{
      {ErrorCode::GitError,
       "'" + branch + "' tracks " + remote + "/" + tracked +
           ", which has a different name; with push.default=simple git only pushes a branch "
           "to one of the same name. Publish it as " +
           remote + "/" + branch + ", or set push.default to upstream to push to " + remote + "/" +
           tracked + "."}};
}

// Validates the optional 'force' param shared by the push methods.
bool forceWithLease(const rpc::Json& params) {
  const std::string force = params.value("force", "");
  if (!force.empty() && force != "with-lease") {
    throw rpc::HandlerError{
        {ErrorCode::InvalidParams, "'force' must be 'with-lease' when present"}};
  }
  return force == "with-lease";
}

}  // namespace

void registerRefMutateMethods(rpc::Dispatcher& dispatcher, ServiceContext& context) {
  dispatcher.method(
      "branch/rename",
      [&context](const rpc::Json& params, const CancelToken& token,
                 const rpc::NotifyFn&) -> rpc::Json {
        requireGitCli(context);
        const std::string name = requirePositional(requireString(params, "name"), "name");
        const std::string newName = requirePositional(requireString(params, "newName"), "newName");
        auto repo = openRepo(context, params);
        runGitOrThrow(repo, {"branch", "-m", "--", name, newName}, token, "git branch rename");
        return rpc::Json::object();
      },
      rpc::Mode::Serial);

  dispatcher.method(
      "branch/setUpstream",
      [&context](const rpc::Json& params, const CancelToken& token,
                 const rpc::NotifyFn&) -> rpc::Json {
        requireGitCli(context);
        const std::string name = requirePositional(requireString(params, "name"), "name");
        const std::string upstream =
            requirePositional(optionalString(params, "upstream"), "upstream");
        auto repo = openRepo(context, params);
        // Clearing an upstream that is not set is already done; git would
        // call it an error.
        if (upstream.empty() && configValue(repo, "branch." + name + ".merge", token).empty() &&
            configValue(repo, "branch." + name + ".remote", token).empty()) {
          return rpc::Json::object();
        }
        std::vector<std::string> args = {"branch"};
        args.push_back(upstream.empty() ? "--unset-upstream" : "--set-upstream-to=" + upstream);
        args.push_back("--");
        args.push_back(name);
        runGitOrThrow(repo, std::move(args), token, "git branch set upstream");
        return rpc::Json::object();
      },
      rpc::Mode::Serial);

  dispatcher.method(
      "branch/push",
      [&context](const rpc::Json& params, const CancelToken& token,
                 const rpc::NotifyFn&) -> rpc::Json {
        requireGitCli(context);
        const std::string name = requirePositional(requireString(params, "name"), "name");
        std::string remote = requirePositional(optionalString(params, "remote"), "remote");
        const bool force = forceWithLease(params);
        const bool setUpstream = params.value("setUpstream", false);
        auto repo = openRepo(context, params);
        if (remote.empty()) remote = pushRemoteFor(repo, name, token);
        const std::string destination = pushDestination(repo, name, remote, setUpstream, token);
        const std::string remoteBranch = destination.starts_with("refs/heads/")
                                             ? destination.substr(std::string("refs/heads/").size())
                                             : destination;
        rpc::Json result = {{"remote", remote}, {"branch", remoteBranch}};
        if (params.value("dryRun", false)) return result;
        std::vector<std::string> args = {"push"};
        if (setUpstream) args.push_back("--set-upstream");
        if (force) args.push_back("--force-with-lease");
        args.insert(args.end(), {"--", remote, "refs/heads/" + name + ":" + destination});
        runGitOrThrow(repo, std::move(args), token, "git push", exec::kNetworkGitTimeout);
        return result;
      },
      rpc::Mode::SerialNetwork);

  dispatcher.method(
      "tag/create",
      [&context](const rpc::Json& params, const CancelToken& token,
                 const rpc::NotifyFn&) -> rpc::Json {
        requireGitCli(context);
        const std::string name = requirePositional(requireString(params, "name"), "name");
        const std::string ref = requirePositional(optionalString(params, "ref"), "ref");
        // The message travels as its own argv element, so it may start with
        // anything.
        const std::string message = optionalString(params, "message");
        auto repo = openRepo(context, params);
        std::vector<std::string> args = {"tag"};
        if (!message.empty()) args.insert(args.end(), {"-a", "-m", message});
        args.push_back("--");
        args.push_back(name);
        if (!ref.empty()) args.push_back(ref);
        runGitOrThrow(repo, std::move(args), token, "git tag");
        return rpc::Json::object();
      },
      rpc::Mode::Serial);

  dispatcher.method(
      "tag/delete",
      [&context](const rpc::Json& params, const CancelToken& token,
                 const rpc::NotifyFn&) -> rpc::Json {
        requireGitCli(context);
        const std::string name = requirePositional(requireString(params, "name"), "name");
        auto repo = openRepo(context, params);
        runGitOrThrow(repo, {"tag", "-d", "--", name}, token, "git tag delete");
        return rpc::Json::object();
      },
      rpc::Mode::Serial);

  dispatcher.method(
      "tag/push",
      [&context](const rpc::Json& params, const CancelToken& token,
                 const rpc::NotifyFn&) -> rpc::Json {
        requireGitCli(context);
        const std::string name = requirePositional(requireString(params, "name"), "name");
        const std::string remote = requirePositional(requireString(params, "remote"), "remote");
        const bool remove = params.value("delete", false);
        auto repo = openRepo(context, params);
        std::vector<std::string> args = {"push"};
        if (remove) args.push_back("--delete");
        args.insert(args.end(), {"--", remote, "refs/tags/" + name});
        runGitOrThrow(repo, std::move(args), token, remove ? "git push --delete" : "git push",
                      exec::kNetworkGitTimeout);
        return rpc::Json::object();
      },
      rpc::Mode::SerialNetwork);

  dispatcher.method(
      "remote/add",
      [&context](const rpc::Json& params, const CancelToken& token,
                 const rpc::NotifyFn&) -> rpc::Json {
        requireGitCli(context);
        const std::string name = requirePositional(requireString(params, "name"), "name");
        const std::string url = requirePositional(requireString(params, "url"), "url");
        auto repo = openRepo(context, params);
        runGitOrThrow(repo, {"remote", "add", "--", name, url}, token, "git remote add");
        return rpc::Json::object();
      },
      rpc::Mode::Serial);

  dispatcher.method(
      "remote/remove",
      [&context](const rpc::Json& params, const CancelToken& token,
                 const rpc::NotifyFn&) -> rpc::Json {
        requireGitCli(context);
        const std::string name = requirePositional(requireString(params, "name"), "name");
        auto repo = openRepo(context, params);
        // No "--": git before 2.38 takes `remote remove` arguments without
        // option parsing and would read it as the name. requirePositional
        // keeps the name from being read as an option.
        runGitOrThrow(repo, {"remote", "remove", name}, token, "git remote remove");
        return rpc::Json::object();
      },
      rpc::Mode::Serial);
}

}  // namespace gg::services
