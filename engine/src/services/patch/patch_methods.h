#pragma once

#include "rpc/dispatcher.h"
#include "services/context.h"

namespace gg::services {

// Registers remote/list, patch/create and patch/apply.
void registerPatchMethods(rpc::Dispatcher& dispatcher, ServiceContext& context);

}  // namespace gg::services
