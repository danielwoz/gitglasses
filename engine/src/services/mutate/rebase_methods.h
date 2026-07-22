#pragma once

#include "rpc/dispatcher.h"
#include "services/context.h"

namespace gg::services {

// rebase/preview, rebase/start, rebase/continue, rebase/abort. rebase/start
// drives `git rebase -i` non-interactively by pointing GIT_SEQUENCE_EDITOR
// and GIT_EDITOR back at this binary's --edit-sequence/--edit-message shim
// modes, which rewrite the todo and messages from the client-supplied plan.
void registerRebaseMethods(rpc::Dispatcher& dispatcher, ServiceContext& context);

}  // namespace gg::services
