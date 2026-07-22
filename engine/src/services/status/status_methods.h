#pragma once

#include "rpc/dispatcher.h"
#include "services/context.h"

namespace gg::services {

// status/summary: branch/upstream/ahead/behind plus staged, unstaged,
// untracked and conflicted paths (concurrent).
void registerStatusMethods(rpc::Dispatcher& dispatcher, ServiceContext& context);

}  // namespace gg::services
