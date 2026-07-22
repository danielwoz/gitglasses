// Wasm entry point. There is no stdio loop and no framing: the host JS hands
// complete JSON-RPC payloads to gg_wasm_handle, and every outbound message
// (responses and notifications) is pushed through the gg_wasm_emit callback,
// which the host installs on the Emscripten Module object before init.

#include <emscripten/emscripten.h>
#include <git2.h>

#include <atomic>
#include <memory>
#include <string>

#include "core/git2.h"
#include "rpc/dispatcher.h"
#include "server.h"
#include "services/context.h"

// Delivers one serialized JSON-RPC message to the host. The host assigns
// Module["gg_wasm_emit"] = (json: string) => void before calling init.
EM_JS(void, gg_wasm_emit, (const char* payload), {
  Module["gg_wasm_emit"](UTF8ToString(payload));
});

namespace {

void emitJson(const gg::rpc::Json& message) { gg_wasm_emit(message.dump().c_str()); }

// All engine state, constructed once by gg_wasm_init. The task pool runs
// inline (GG_SINGLE_THREADED), so every dispatch completes synchronously
// inside gg_wasm_handle.
struct EngineState {
  gg::core::LibGit2 libgit2;
  gg::TaskPool pool{1};
  gg::services::ServiceContext context;
  std::atomic<bool> shutdownRequested{false};
  gg::rpc::Dispatcher dispatcher{pool, [](const gg::rpc::Json& message) { emitJson(message); }};

  EngineState() {
    // Emscripten's FS layers (NODEFS mounts included) don't carry meaningful
    // ownership, so libgit2's dubious-ownership check would reject every
    // mounted repository.
    git_libgit2_opts(GIT_OPT_SET_OWNER_VALIDATION, 0);
    context.broadcast = [](const std::string& method, const gg::rpc::Json& params) {
      emitJson({{"jsonrpc", "2.0"}, {"method", method}, {"params", params}});
    };
    gg::configureDispatcher(dispatcher, context, shutdownRequested);
  }
};

std::unique_ptr<EngineState> state;

}  // namespace

extern "C" {

EMSCRIPTEN_KEEPALIVE void gg_wasm_init() {
  if (state) return;
  state = std::make_unique<EngineState>();
}

EMSCRIPTEN_KEEPALIVE void gg_wasm_handle(const char* payload) {
  if (!state || payload == nullptr) return;
  state->dispatcher.dispatch(payload);
}

}  // extern "C"
