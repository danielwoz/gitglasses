#include "server.h"

#include <spdlog/spdlog.h>

#include <atomic>

#include "core/git2.h"
#include "repo/registry.h"
#include "rpc/dispatcher.h"
#include "rpc/framing.h"

namespace gg {

namespace {

constexpr const char* kProtocolVersion = "0.1.0";
constexpr const char* kEngineVersion = "0.1.0";

}  // namespace

int runServer(std::istream& in, std::ostream& out) {
  core::LibGit2 libgit2;
  rpc::FrameReader reader(in);
  rpc::FrameWriter writer(out);
  TaskPool pool;
  repo::Registry registry;
  std::atomic<bool> shutdownRequested{false};

  rpc::Dispatcher dispatcher(pool, [&writer](const rpc::Json& message) {
    writer.write(message.dump());
  });

  dispatcher.method("initialize", [](const rpc::Json& params, const CancelToken&,
                                     const rpc::NotifyFn&) -> rpc::Json {
    const std::string clientProtocol = params.value("protocolVersion", "");
    if (clientProtocol != kProtocolVersion) {
      throw rpc::HandlerError{{ErrorCode::InvalidRequest,
                               std::string("protocol version mismatch: engine speaks ") +
                                   kProtocolVersion + ", client sent '" + clientProtocol + "'"}};
    }
    return {{"engineVersion", kEngineVersion},
            {"protocolVersion", kProtocolVersion},
            {"capabilities", rpc::Json::object()}};
  });

  dispatcher.method("shutdown", [&shutdownRequested](const rpc::Json&, const CancelToken&,
                                                     const rpc::NotifyFn&) -> rpc::Json {
    shutdownRequested = true;
    return rpc::Json::object();
  });

  dispatcher.method("repo/discover", [&registry](const rpc::Json& params, const CancelToken&,
                                                 const rpc::NotifyFn&) -> rpc::Json {
    const std::string path = params.value("path", "");
    if (path.empty()) {
      throw rpc::HandlerError{{ErrorCode::InvalidParams, "'path' is required"}};
    }
    auto info = registry.add(path);
    if (!info) throw rpc::HandlerError{{info.error()}};
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

  while (!shutdownRequested) {
    auto payload = reader.read();
    if (!payload) break;  // stdin closed: exit cleanly, never orphan
    dispatcher.dispatch(*payload);
  }

  pool.shutdown();
  spdlog::info("engine exiting");
  return 0;
}

}  // namespace gg
