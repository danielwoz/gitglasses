#pragma once

#include "rpc/dispatcher.h"
#include "services/context.h"

namespace gg::services {

// log/commits, history/file, history/line, search/commits (all concurrent;
// search streams search/matches batches).
void registerHistoryMethods(rpc::Dispatcher& dispatcher, ServiceContext& context);

}  // namespace gg::services
