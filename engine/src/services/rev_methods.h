#pragma once

#include "rpc/dispatcher.h"
#include "services/context.h"

namespace gg::services {

// rev/fileAtRev (concurrent, reads blob contents at a revision).
void registerRevMethods(rpc::Dispatcher& dispatcher, ServiceContext& context);

}  // namespace gg::services
