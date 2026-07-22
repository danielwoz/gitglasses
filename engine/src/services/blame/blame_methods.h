#pragma once

#include "rpc/dispatcher.h"
#include "services/context.h"

namespace gg::services {

// blame/file (concurrent, streams blame/hunks batches).
void registerBlameMethods(rpc::Dispatcher& dispatcher, ServiceContext& context);

}  // namespace gg::services
