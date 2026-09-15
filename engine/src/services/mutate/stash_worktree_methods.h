#pragma once

#include "rpc/dispatcher.h"
#include "services/context.h"

namespace gg::services {

// stash/push, stash/apply, stash/drop and worktree/list, worktree/add,
// worktree/remove. All CLI-backed; the stash and worktree mutations run
// Serial, worktree/list is a concurrent read.
void registerStashWorktreeMethods(rpc::Dispatcher& dispatcher, ServiceContext& context);

}  // namespace gg::services
