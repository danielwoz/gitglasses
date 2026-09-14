#pragma once

#include <nlohmann/json.hpp>

#include <cstdint>
#include <functional>
#include <string>
#include <vector>

#include "cache/blame_cache.h"
#include "cache/doc_overlay.h"
#include "cache/graph_cache.h"
#include "exec/cli_detect.h"
#include "repo/registry.h"
#include "rpc/dispatcher.h"
#include "services/blame/blame_service.h"

#ifndef GG_SINGLE_THREADED
#include "watch/watch_manager.h"
#endif

namespace gg::services {

// Shared state for all RPC method handlers. Owned by the server loop;
// outlives the dispatcher and task pool.
struct ServiceContext {
  repo::Registry registry;
  cache::BlameCache blameCache;
  cache::GraphCache graphCache;
  cache::DocOverlay docOverlay;
  // Whether this process has a usable git CLI. Probed once per context (not
  // statically) so capability reporting, method guards and the blame backend
  // choice always agree for one server instance.
  bool cliAvailable = exec::gitCliAvailable();
  BlameService blameService{blameCache, cliAvailable};

  // Sends a server->client notification. Set by the server loop before any
  // request is dispatched; safe to call from watcher threads (the frame
  // writer serializes concurrent writes).
  std::function<void(const std::string& method, const nlohmann::json& params)> broadcast;

#ifdef GG_SINGLE_THREADED
  // Single-threaded builds (wasm, debug-st) have no watcher threads; the
  // capability is reported as watch:false and watch requests are ignored.
  struct NullWatchManager {
    void watch(const std::string&, const std::string&) {}
    void unwatch(const std::string&) {}
    bool isWatching(const std::string&) const { return false; }
    bool nativeBackendActive() const { return false; }
  };
  NullWatchManager watchManager;
#else
  // Pushes repo/didChange when a watched repository's git state changes.
  // Declared last so its threads stop before the state they observe goes away.
  watch::WatchManager watchManager{
      [this](const std::string& repoId, std::uint64_t generation,
             const std::vector<std::string>& changed) {
        if (!broadcast) return;
        broadcast("repo/didChange",
                  {{"repoId", repoId}, {"generation", generation}, {"changed", changed}});
      }};
#endif
};

// Rejects a method that shells out to the git CLI when this build/environment
// has none, as a typed error the client can branch on.
inline void requireGitCli(const ServiceContext& context) {
  if (context.cliAvailable) return;
  throw rpc::HandlerError{{ErrorCode::MethodNotSupported,
                           "requires the git CLI (not available in this engine build)"}};
}

}  // namespace gg::services
