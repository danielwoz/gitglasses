#pragma once

#include "rpc/dispatcher.h"
#include "services/context.h"

namespace gg::services {

// mutate/*: commit, branch create/delete, switch, merge, cherry-pick,
// revert, reset, fetch, pull, push. Every method shells out to the git CLI
// (hooks, signing and credential helpers keep working) and runs Serial so
// repository mutations never interleave.
void registerMutateMethods(rpc::Dispatcher& dispatcher, ServiceContext& context);

}  // namespace gg::services
