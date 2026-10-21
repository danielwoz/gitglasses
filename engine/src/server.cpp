#include "server.h"

#include <spdlog/spdlog.h>

#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <string_view>

#include "core/git2.h"
#include "exec/askpass.h"
#include "rpc/client_channel.h"
#include "rpc/dispatcher.h"
#include "rpc/framing.h"
#include "services/blame/blame_methods.h"
#include "services/commit/commit_methods.h"
#include "services/context.h"
#include "services/graph/graph_methods.h"
#include "services/history/history_methods.h"
#include "services/mutate/git_errors.h"
#include "services/mutate/mutate_methods.h"
#include "services/mutate/rebase_methods.h"
#include "services/mutate/ref_methods.h"
#include "services/mutate/stash_worktree_methods.h"
#include "services/notes/notes_methods.h"
#include "services/patch/patch_methods.h"
#include "services/refs/refs_methods.h"
#include "services/repo_methods.h"
#include "services/rev_methods.h"
#include "services/search/search_methods.h"
#include "services/status/diff_methods.h"
#include "services/status/stage_methods.h"
#include "services/status/status_methods.h"
#include "version.h"

namespace gg {

namespace {

constexpr const char* kProtocolVersion = "0.1.0";

// How long requests in flight when stdin closes may run on before they are
// cancelled.
constexpr std::chrono::milliseconds kDrainOnClose{2000};

// watch/threads are static truths of the build: single-threaded builds
// (wasm, debug-st) have no watcher threads and no worker pool.
#ifdef GG_SINGLE_THREADED
constexpr bool kWatchCapability = false;
constexpr bool kThreadsCapability = false;
#else
constexpr bool kWatchCapability = true;
constexpr bool kThreadsCapability = true;
#endif

// The methods a Restricted Mode engine serves: reads that go through libgit2
// alone (blame/file switches to its libgit2 backend), so no program the
// repository configures can run, and none of which changes the repository.
// Every other request method is refused with ErrorCode::Restricted before its
// handler runs, including methods added later, until they are vetted and
// listed here. Notifications only feed these reads and stay registered.
// Mirrors RESTRICTED_MODE_METHODS in packages/protocol; the protocol contract
// test checks the two agree.
constexpr std::array<std::string_view, 25> kRestrictedModeMethods = {
    "initialize",  "shutdown",      "repo/discover",   "repo/close",     "repo/list",
    "repo/state",  "blame/file",    "log/commits",     "search/commits", "rev/fileAtRev",
    "refs/list",   "stash/list",    "status/summary",  "graph/rows",     "graph/find",
    "diff/commit", "diff/refs",     "diff/fileHunks",  "remote/list",    "commit/details",
    "log/compare", "worktree/list", "worktree/status", "notes/read",     "commit/provenance",
};

// Replaces the handler of every method Restricted Mode does not serve.
void refuseOutsideRestrictedMode(rpc::Dispatcher& dispatcher) {
  for (const std::string& name : dispatcher.methodNames()) {
    if (std::find(kRestrictedModeMethods.begin(), kRestrictedModeMethods.end(), name) !=
        kRestrictedModeMethods.end()) {
      continue;
    }
    dispatcher.method(
        name, [](const rpc::Json&, const CancelToken&, const rpc::NotifyFn&) -> rpc::Json {
          throw rpc::HandlerError{{ErrorCode::Restricted, exec::kRestrictedModeMessage}};
        });
  }
}

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
      [&context](const rpc::Json& params, const CancelToken&, const rpc::NotifyFn&) -> rpc::Json {
        const std::string clientProtocol = params.value("protocolVersion", "");
        if (clientProtocol != kProtocolVersion) {
          throw rpc::HandlerError{
              {ErrorCode::InvalidRequest, std::string("protocol version mismatch: engine speaks ") +
                                              kProtocolVersion + ", client sent '" +
                                              clientProtocol + "'"}};
        }
        const rpc::Json clientCapabilities =
            params.value("clientCapabilities", rpc::Json::object());
        exec::setClientAnswersPrompts(clientCapabilities.is_object() &&
                                      clientCapabilities.value("askpass", false));
        return {{"engineVersion", kVersion},
                {"protocolVersion", kProtocolVersion},
                {"capabilities",
                 {{"gitCli", context.cliAvailable},
                  {"restricted", context.restricted},
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
  services::registerSearchMethods(dispatcher, context);
  services::registerCommitMethods(dispatcher, context);
  services::registerNotesMethods(dispatcher, context);
  services::registerRefsMethods(dispatcher, context);
  services::registerGraphMethods(dispatcher, context);
  services::registerStatusMethods(dispatcher, context);
  services::registerDiffMethods(dispatcher, context);
  services::registerStageMethods(dispatcher, context);
  services::registerMutateMethods(dispatcher, context);
  services::registerStashWorktreeMethods(dispatcher, context);
  services::registerRebaseMethods(dispatcher, context);
  services::registerRefMutateMethods(dispatcher, context);
  services::registerPatchMethods(dispatcher, context);

  // A GitError thrown without data gets it from git's output, whichever
  // method threw it.
  dispatcher.setErrorData(services::gitErrorData);

  if (context.restricted) refuseOutsideRestrictedMode(dispatcher);
}

namespace {

#ifndef GG_WASM
// Answers a git, ssh or gpg prompt by asking the client (ui/askpass), when
// the client said it can.
exec::AskpassAnswer askClient(rpc::ClientChannel& channel, const exec::AskpassPrompt& prompt,
                              const exec::AskpassOrigin& origin,
                              const std::function<bool()>& abandoned) {
  if (!exec::clientAnswersPrompts()) return {};
  rpc::Json params = {{"kind", exec::askpassKindName(prompt.kind)},
                      {"prompt", prompt.prompt},
                      {"secret", prompt.secret},
                      {"interactive", origin.interactive}};
  if (origin.requestId >= 0) params["requestId"] = origin.requestId;
  if (!origin.method.empty()) params["method"] = origin.method;
  if (!origin.repoId.empty()) params["repoId"] = origin.repoId;
  if (!prompt.protocol.empty()) params["protocol"] = prompt.protocol;
  if (!prompt.host.empty()) params["host"] = prompt.host;
  if (!prompt.username.empty()) params["username"] = prompt.username;
  if (!prompt.fingerprint.empty()) params["fingerprint"] = prompt.fingerprint;
  const auto reply =
      channel.call("ui/askpass", std::move(params), abandoned, "ui/askpassCancelled");
  if (!reply || !reply->is_object()) return {};
  const auto value = reply->find("value");
  if (value == reply->end() || !value->is_string()) {
    exec::AskpassAnswer declined;
    declined.declined = reply->value("cancelled", false);
    return declined;
  }
  return {true, value->get<std::string>(), false};
}
#endif

}  // namespace

int runServer(std::istream& in, std::ostream& out) {
  core::LibGit2 libgit2;
  rpc::FrameReader reader(in);
  rpc::FrameWriter writer(out);
  TaskPool pool;
  services::ServiceContext context;
  std::atomic<bool> shutdownRequested{false};

  const auto send = [&writer](const rpc::Json& message) {
    writer.write(rpc::dumpForWire(message));
  };
  rpc::Dispatcher dispatcher(pool, send);
  rpc::ClientChannel clientChannel(send);
  dispatcher.onResponse(
      [&clientChannel](const rpc::Json& message) { clientChannel.handleResponse(message); });

#ifndef GG_WASM
  // Prompts from the git this engine runs reach the client through the
  // broker. Restricted Mode runs no git, so it has nothing to prompt for.
  std::unique_ptr<exec::AskpassBroker> askpass;
  if (!context.restricted) {
    askpass = exec::AskpassBroker::start([&clientChannel](const exec::AskpassPrompt& prompt,
                                                          const exec::AskpassOrigin& origin,
                                                          const std::function<bool()>& abandoned) {
      return askClient(clientChannel, prompt, origin, abandoned);
    });
    if (askpass) exec::installAskpassBroker(askpass.get());
  }
#endif

  // Server-initiated notifications (watcher pushes) go through the same
  // serialized frame writer as dispatcher responses.
  context.broadcast = [&writer](const std::string& method, const rpc::Json& params) {
    writer.write(
        rpc::dumpForWire(rpc::Json{{"jsonrpc", "2.0"}, {"method", method}, {"params", params}}));
  };

  configureDispatcher(dispatcher, context, shutdownRequested);

  // Once the client is gone no prompt can be answered, so open ones are
  // withdrawn. Requests still running after `drain` are cancelled, which stops
  // their git: the engine exits promptly instead of when the slowest git
  // finishes or times out, while requests a client wrote just before closing
  // its end still get their answers.
  const auto stop = [&](std::chrono::milliseconds drain) {
    clientChannel.close();
#ifndef GG_WASM
    if (askpass) askpass->cancelAll();
#endif
    if (!dispatcher.waitIdle(drain)) dispatcher.cancelAll();
    pool.shutdown();
  };

  while (!shutdownRequested) {
    auto payload = reader.read();
    if (!payload) {
      if (reader.failed()) {
        spdlog::error("malformed frame; the stream cannot be resynchronized");
        stop(std::chrono::milliseconds(0));
        return 1;
      }
      break;  // stdin closed: exit cleanly, never orphan
    }
    dispatcher.dispatch(*payload);
  }

  // A shutdown request asked for an exit; a closed stdin may still have
  // requests in flight that a scripted client is waiting for.
  stop(shutdownRequested ? std::chrono::milliseconds(0) : kDrainOnClose);
  spdlog::info("engine exiting");
  return 0;
}

}  // namespace gg
