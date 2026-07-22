#pragma once

#include "rpc/dispatcher.h"
#include "services/context.h"

namespace gg::services {

// stage/files and stage/hunks. Both mutate the index, so they run in Serial
// mode: index writes are ordered against each other and every other serial
// method.
void registerStageMethods(rpc::Dispatcher& dispatcher, ServiceContext& context);

}  // namespace gg::services
