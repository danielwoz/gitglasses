#pragma once

#include "cache/blame_cache.h"
#include "cache/doc_overlay.h"
#include "repo/registry.h"
#include "services/blame/blame_service.h"

namespace gg::services {

// Shared state for all RPC method handlers. Owned by the server loop;
// outlives the dispatcher and task pool.
struct ServiceContext {
  repo::Registry registry;
  cache::BlameCache blameCache;
  cache::DocOverlay docOverlay;
  BlameService blameService{blameCache};
};

}  // namespace gg::services
