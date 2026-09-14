#include "server.h"

#include <spdlog/spdlog.h>

#include <atomic>

#include "core/git2.h"
#include "rpc/dispatcher.h"
#include "rpc/framing.h"
#include "services/blame/blame_methods.h"
#include "services/context.h"
#include "services/graph/graph_methods.h"
#include "services/history/history_methods.h"
#include "services/mutate/mutate_methods.h"
#include "services/mutate/rebase_methods.h"
#include "services/mutate/stash_worktree_methods.h"
#include "services/patch/patch_methods.h"
#include "services/refs/refs_methods.h"
#include "services/repo_methods.h"
#include "services/rev_methods.h"
#include "services/status/diff_methods.h"
#include "services/status/stage_methods.h"
#include "services/status/status_methods.h"

namespace gg {

namespace {

constexpr const char* kProtocolVersion = "0.1.0";
constexpr const char* kEngineVersion = "0.1.2";

// watch/threads are static truths of the build: single-threaded builds
// (wasm, debug-st) have no watcher threads and no worker pool.
#ifdef GG_SINGLE_THREADED
constexpr bool kWatchCapability = false;
constexpr bool kThreadsCapability = false;
#else
constexpr bool kWatchCapability = true;
constexpr bool kThreadsCapability = true;
#endif

// Which mechanism actually backs repo/didChange: "none" when the build has no
// watcher, "inotify" for the kernel watcher, "polling" for the degraded
// periodic stat sweep. Notifications are delivered either way; polling costs
// CPU per watched repo and reports changes up to one sweep interval late.
const char* watchBackendName(const services::ServiceContext& context) {
#ifdef GG_SINGLE_THREADED
  (void)context;
  return "none";
#else
  return context.watchManager.nativeBackendActive() ? "inotify" : "polling";
#endif
}

}  // namespace

void configureDispatcher(rpc::Dispatcher& dispatcher, services::ServiceContext& context,
                         std::atomic<bool>& shutdownRequested) {
  dispatcher.method(
      "initialize",
      [&context](const rpc::Json& params, const CancelToken&,
                 const rpc::NotifyFn&) -> rpc::Json {
        const std::string clientProtocol = params.value("protocolVersion", "");
        if (clientProtocol != kProtocolVersion) {
          throw rpc::HandlerError{
              {ErrorCode::InvalidRequest,
               std::string("protocol version mismatch: engine speaks ") + kProtocolVersion +
                   ", client sent '" + clientProtocol + "'"}};
        }
        return {{"engineVersion", kEngineVersion},
                {"protocolVersion", kProtocolVersion},
                {"capabilities",
                 {{"gitCli", context.cliAvailable},
                  {"watch", kWatchCapability},
                  {"watchBackend", watchBackendName(context)},
                  {"threads", kThreadsCapability}}}};
      },
      rpc::Mode::Serial);

  dispatcher.method(
      "shutdown",
      [&shutdownRequested](const rpc::Json&, const CancelToken&,
                           const rpc::NotifyFn&) -> rpc::Json {
        shutdownRequested = true;
        return rpc::Json::object();
      },
      rpc::Mode::Serial);

  services::registerRepoMethods(dispatcher, context);
  services::registerBlameMethods(dispatcher, context);
  services::registerRevMethods(dispatcher, context);
  services::registerHistoryMethods(dispatcher, context);
  services::registerRefsMethods(dispatcher, context);
  services::registerGraphMethods(dispatcher, context);
  services::registerStatusMethods(dispatcher, context);
  services::registerDiffMethods(dispatcher, context);
  services::registerStageMethods(dispatcher, context);
  services::registerMutateMethods(dispatcher, context);
  services::registerStashWorktreeMethods(dispatcher, context);
  services::registerRebaseMethods(dispatcher, context);
  services::registerPatchMethods(dispatcher, context);
}

int runServer(std::istream& in, std::ostream& out) {
  core::LibGit2 libgit2;
  rpc::FrameReader reader(in);
  rpc::FrameWriter writer(out);
  TaskPool pool;
  services::ServiceContext context;
  std::atomic<bool> shutdownRequested{false};

  rpc::Dispatcher dispatcher(pool, [&writer](const rpc::Json& message) {
    writer.write(rpc::dumpForWire(message));
  });

  // Server-initiated notifications (watcher pushes) go through the same
  // serialized frame writer as dispatcher responses.
  context.broadcast = [&writer](const std::string& method, const rpc::Json& params) {
    writer.write(rpc::dumpForWire(
        rpc::Json{{"jsonrpc", "2.0"}, {"method", method}, {"params", params}}));
  };

  configureDispatcher(dispatcher, context, shutdownRequested);

  while (!shutdownRequested) {
    auto payload = reader.read();
    if (!payload) {
      if (reader.failed()) {
        spdlog::error("malformed frame; the stream cannot be resynchronized");
        pool.shutdown();
        return 1;
      }
      break;  // stdin closed: exit cleanly, never orphan
    }
    dispatcher.dispatch(*payload);
  }

  pool.shutdown();
  spdlog::info("engine exiting");
  return 0;
}

}  // namespace gg
