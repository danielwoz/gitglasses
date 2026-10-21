#pragma once

#include <cstddef>

#include "rpc/dispatcher.h"
#include "services/context.h"

namespace gg::services {

// Files commit/details lists before it stops and reports `truncated`.
inline constexpr std::size_t kMaxCommitDetailFiles = 2000;

// commit/details (concurrent): everything one commit records, read through
// libgit2 alone, so it is served in Restricted Mode and without the git CLI.
void registerCommitMethods(rpc::Dispatcher& dispatcher, ServiceContext& context);

}  // namespace gg::services
