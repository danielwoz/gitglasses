#pragma once

#include <nlohmann/json.hpp>

#include <cstdint>
#include <functional>
#include <string>
#include <vector>

#include "cache/blame_cache.h"
#include "cache/doc_overlay.h"
#include "repo/registry.h"
#include "services/blame/blame_service.h"
#include "watch/watch_manager.h"

namespace gg::services {

// Shared state for all RPC method handlers. Owned by the server loop;
// outlives the dispatcher and task pool.
struct ServiceContext {
  repo::Registry registry;
  cache::BlameCache blameCache;
  cache::DocOverlay docOverlay;
  BlameService blameService{blameCache};

  // Sends a server->client notification. Set by the server loop before any
  // request is dispatched; safe to call from watcher threads (the frame
  // writer serializes concurrent writes).
  std::function<void(const std::string& method, const nlohmann::json& params)> broadcast;

  // Pushes repo/didChange when a watched repository's git state changes.
  // Declared last so its threads stop before the state they observe goes away.
  watch::WatchManager watchManager{
      [this](const std::string& repoId, std::uint64_t generation,
             const std::vector<std::string>& changed) {
        if (!broadcast) return;
        broadcast("repo/didChange",
                  {{"repoId", repoId}, {"generation", generation}, {"changed", changed}});
      }};
};

}  // namespace gg::services
