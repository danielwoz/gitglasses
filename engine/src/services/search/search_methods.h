#pragma once

#include <string>
#include <string_view>

#include "rpc/dispatcher.h"
#include "services/context.h"

namespace gg::services {

// search/log: commit search through `git log`, for the criteria libgit2 alone
// cannot answer cheaply (pickaxe, pathspec, commit-date window). Streams
// search/matches batches like search/commits.
void registerSearchMethods(rpc::Dispatcher& dispatcher, ServiceContext& context);

// A basic regular expression matching `needle` as a literal, ignoring the
// case of ASCII letters. Spelling the case into the pattern, instead of
// passing -i, keeps the pickaxe of the same `git log` case-sensitive.
std::string caseInsensitiveLiteralPattern(std::string_view needle);

}  // namespace gg::services
