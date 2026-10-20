#pragma once

#include "rpc/dispatcher.h"
#include "services/context.h"

namespace gg::services {

// graph/rows: topologically ordered commit rows over all local/remote branch
// tips plus HEAD, with the deterministic lane layout from
// docs/specs/commit-graph-lanes.md (concurrent, paged via an opaque cursor).
// graph/find: the rows of the same walk that match a find query, with their
// positions in it.
void registerGraphMethods(rpc::Dispatcher& dispatcher, ServiceContext& context);

}  // namespace gg::services
