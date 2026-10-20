#pragma once

#include <cstddef>

#include "rpc/dispatcher.h"
#include "services/context.h"

namespace gg::services {

// Commits one notes/read request may ask about.
inline constexpr std::size_t kMaxNotesReadShas = 64;

// Longest note notes/read returns; a longer one is listed in `omitted`.
inline constexpr std::size_t kMaxNotesReadBytes = 128 * 1024;

// notes/read (concurrent): the notes a notes ref attaches to a batch of
// commits, read through libgit2 alone and cached per commit, so it is served
// in Restricted Mode and without the git CLI.
// notes/addFetchRefspec (serial): makes a remote's fetches bring a notes ref
// along, through `git config --add`.
void registerNotesMethods(rpc::Dispatcher& dispatcher, ServiceContext& context);

}  // namespace gg::services
