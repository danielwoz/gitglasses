#include "services/repo_methods.h"

#include <utility>

#include "services/mutate/mutate_common.h"

namespace gg::services {

void registerRepoMethods(rpc::Dispatcher& dispatcher, ServiceContext& context) {
  auto& registry = context.registry;

  dispatcher.method(
      "repo/discover",
      [&context](const rpc::Json& params, const CancelToken&,
                 const rpc::NotifyFn&) -> rpc::Json {
        const std::string path = params.value("path", "");
        if (path.empty()) {
          throw rpc::HandlerError{{ErrorCode::InvalidParams, "'path' is required"}};
        }
        auto info = context.registry.add(path);
        if (!info) throw rpc::HandlerError{{info.error()}};
        // Watch the gitdir so external ref/index changes push repo/didChange.
        if (auto repo = context.registry.open(info.value().id)) {
          context.watchManager.watch(info.value().id, repo.value().gitdir());
        }
        return {{"repoId", info.value().id},
                {"rootPath", info.value().rootPath},
                {"bare", info.value().bare}};
      },
      rpc::Mode::Serial);

  // Releases everything held for a repository: its watch (thread, inotify
  // watch descriptors), its cached graph plans, and its registry entry. Later
  // requests for the id fail with RepoNotFound; repo/discover re-registers
  // the path under a new id.
  dispatcher.method(
      "repo/close",
      [&context](const rpc::Json& params, const CancelToken&,
                 const rpc::NotifyFn&) -> rpc::Json {
        const std::string repoId = params.value("repoId", "");
        if (!context.registry.byId(repoId)) {
          throw rpc::HandlerError{{ErrorCode::RepoNotFound, "unknown repo id: " + repoId}};
        }
        context.watchManager.unwatch(repoId);
        context.graphCache.dropRepo(repoId);
        context.docOverlay.closeRepo(repoId);
        context.registry.remove(repoId);
        return rpc::Json::object();
      },
      rpc::Mode::Serial);

  dispatcher.method("repo/list", [&registry](const rpc::Json&, const CancelToken&,
                                             const rpc::NotifyFn&) -> rpc::Json {
    rpc::Json repos = rpc::Json::array();
    for (const auto& info : registry.list()) {
      repos.push_back({{"repoId", info.id}, {"rootPath", info.rootPath}, {"bare", info.bare}});
    }
    return {{"repos", repos}};
  });

  // HEAD plus the sequencer state: a repository stopped mid-rebase reports a
  // detached HEAD, and only `sequencer` tells a client why.
  dispatcher.method("repo/state", [&registry](const rpc::Json& params, const CancelToken&,
                                              const rpc::NotifyFn&) -> rpc::Json {
    auto repo = registry.open(params.value("repoId", ""));
    if (!repo) throw rpc::HandlerError{{repo.error()}};
    auto head = repo.value().head();
    if (!head) throw rpc::HandlerError{{head.error()}};

    const auto state = mutate_detail::sequencerState(repo.value());
    rpc::Json sequencer = {{"operation", state.operation}, {"conflicted", state.conflicted}};
    if (state.step) sequencer["step"] = *state.step;
    if (state.total) sequencer["total"] = *state.total;

    return {{"head",
             {{"oid", head.value().oid},
              {"branch", head.value().branch},
              {"detached", head.value().detached},
              {"unborn", head.value().unborn}}},
            {"sequencer", std::move(sequencer)}};
  });

  // Queued: an editor buffer can be tens of megabytes, and copying it into
  // the overlay on the read loop delays every request behind it.
  dispatcher.notification(
      "doc/didChange",
      [&context](rpc::Json params) {
        std::string contents;
        if (const auto it = params.find("contents"); it != params.end() && it->is_string()) {
          contents = std::move(it->get_ref<std::string&>());
        }
        context.docOverlay.update(params.value("repoId", ""), params.value("path", ""),
                                  std::move(contents),
                                  params.value("version", std::int64_t{0}));
      },
      rpc::NotificationMode::Queued);

  dispatcher.notification(
      "doc/didClose",
      [&context](rpc::Json params) {
        context.docOverlay.close(params.value("repoId", ""), params.value("path", ""));
      },
      rpc::NotificationMode::Queued);
}

}  // namespace gg::services
