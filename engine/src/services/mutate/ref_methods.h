#pragma once

#include "rpc/dispatcher.h"
#include "services/context.h"

namespace gg::services {

// Branch, tag and remote management the sidebar views act through:
// branch/rename, branch/setUpstream, branch/push, tag/create, tag/delete,
// tag/push, remote/add, remote/remove. Each runs the git CLI.
void registerRefMutateMethods(rpc::Dispatcher& dispatcher, ServiceContext& context);

}  // namespace gg::services
