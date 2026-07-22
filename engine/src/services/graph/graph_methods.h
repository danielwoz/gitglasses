#pragma once

#include "rpc/dispatcher.h"
#include "services/context.h"

namespace gg::services {

// graph/rows: topologically ordered commit rows over all local/remote branch
// tips plus HEAD, with the deterministic lane layout from
// docs/specs/commit-graph-lanes.md (concurrent, paged via an opaque cursor).
void registerGraphMethods(rpc::Dispatcher& dispatcher, ServiceContext& context);

}  // namespace gg::services
