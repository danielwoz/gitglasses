#pragma once

#include <cstddef>

#include "rpc/dispatcher.h"
#include "services/context.h"

namespace gg::services {

// Files commit/details lists before it stops and reports `truncated`.
inline constexpr std::size_t kMaxCommitDetailFiles = 2000;

// Commits one commit/provenance request may ask about.
inline constexpr std::size_t kMaxProvenanceShas = 1000;

// commit/details (concurrent): everything one commit records, read through
// libgit2 alone, so it is served in Restricted Mode and without the git CLI.
// commit/provenance (concurrent): what a batch of commits declare about who
// wrote them, from a git-ai note, their trailers and known agent identities,
// read through libgit2 alone as well.
void registerCommitMethods(rpc::Dispatcher& dispatcher, ServiceContext& context);

}  // namespace gg::services
