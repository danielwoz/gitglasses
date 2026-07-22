#pragma once

#include "rpc/dispatcher.h"
#include "services/context.h"

namespace gg::services {

// stash/push, stash/apply, stash/drop and worktree/list, worktree/add,
// worktree/remove. CLI-backed and Serial like the other mutations.
void registerStashWorktreeMethods(rpc::Dispatcher& dispatcher, ServiceContext& context);

}  // namespace gg::services
