#include "services/repo_methods.h"

namespace gg::services {

void registerRepoMethods(rpc::Dispatcher& dispatcher, ServiceContext& context) {
  auto& registry = context.registry;

  dispatcher.method("repo/discover", [&context](const rpc::Json& params, const CancelToken&,
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
  });

  dispatcher.method("repo/list", [&registry](const rpc::Json&, const CancelToken&,
                                             const rpc::NotifyFn&) -> rpc::Json {
    rpc::Json repos = rpc::Json::array();
    for (const auto& info : registry.list()) {
      repos.push_back({{"repoId", info.id}, {"rootPath", info.rootPath}, {"bare", info.bare}});
    }
    return {{"repos", repos}};
  });

  dispatcher.method("repo/state", [&registry](const rpc::Json& params, const CancelToken&,
                                              const rpc::NotifyFn&) -> rpc::Json {
    auto repo = registry.open(params.value("repoId", ""));
    if (!repo) throw rpc::HandlerError{{repo.error()}};
    auto head = repo.value().head();
    if (!head) throw rpc::HandlerError{{head.error()}};
    return {{"head",
             {{"oid", head.value().oid},
              {"branch", head.value().branch},
              {"detached", head.value().detached},
              {"unborn", head.value().unborn}}}};
  });

  dispatcher.notification("doc/didChange", [&context](const rpc::Json& params) {
    context.docOverlay.update(params.value("repoId", ""), params.value("path", ""),
                              params.value("contents", ""),
                              params.value("version", std::int64_t{0}));
  });

  dispatcher.notification("doc/didClose", [&context](const rpc::Json& params) {
    context.docOverlay.close(params.value("repoId", ""), params.value("path", ""));
  });
}

}  // namespace gg::services
