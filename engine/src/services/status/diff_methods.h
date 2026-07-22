#pragma once

#include "rpc/dispatcher.h"
#include "services/context.h"

namespace gg::services {

// diff/commit, diff/refs (file lists with rename detection and line stats)
// and diff/fileHunks (hunks of one file's staged or unstaged diff), all
// concurrent.
void registerDiffMethods(rpc::Dispatcher& dispatcher, ServiceContext& context);

}  // namespace gg::services
