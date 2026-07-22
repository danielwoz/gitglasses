#pragma once

#include "rpc/dispatcher.h"
#include "services/context.h"

namespace gg::services {

// repo/discover, repo/list, repo/state + doc overlay notifications.
void registerRepoMethods(rpc::Dispatcher& dispatcher, ServiceContext& context);

}  // namespace gg::services
