#pragma once

#include "rpc/dispatcher.h"
#include "services/context.h"

namespace gg::services {

// refs/list (branches, remotes, tags) and stash/list.
void registerRefsMethods(rpc::Dispatcher& dispatcher, ServiceContext& context);

}  // namespace gg::services
