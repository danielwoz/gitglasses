#pragma once

#include "rpc/dispatcher.h"
#include "services/context.h"

namespace gg::services {

// stash/push, stash/apply, stash/drop and worktree/list, worktree/status,
// worktree/add, worktree/remove. The mutations are CLI-backed and run Serial;
// the two worktree reads are concurrent and fall back to libgit2 where git
// may not run (worktree/status then leaves its merge check unanswered). The
// wasm engine, which sees no file outside the mirrored workspace, refuses
// them.
void registerStashWorktreeMethods(rpc::Dispatcher& dispatcher, ServiceContext& context);

}  // namespace gg::services
