#include "server.h"

#include <spdlog/spdlog.h>

#include <atomic>

#include "core/git2.h"
#include "rpc/dispatcher.h"
#include "rpc/framing.h"
#include "services/blame/blame_methods.h"
#include "services/context.h"
#include "services/repo_methods.h"
#include "services/rev_methods.h"

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
  services::ServiceContext context;
  std::atomic<bool> shutdownRequested{false};

  rpc::Dispatcher dispatcher(pool, [&writer](const rpc::Json& message) {
    writer.write(message.dump());
  });

  // Server-initiated notifications (watcher pushes) go through the same
  // serialized frame writer as dispatcher responses.
  context.broadcast = [&writer](const std::string& method, const rpc::Json& params) {
    writer.write(rpc::Json{{"jsonrpc", "2.0"}, {"method", method}, {"params", params}}.dump());
  };

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

  services::registerRepoMethods(dispatcher, context);
  services::registerBlameMethods(dispatcher, context);
  services::registerRevMethods(dispatcher, context);

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
