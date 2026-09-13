#pragma once

#include <cstdint>
#include <string>
#include <vector>

#include "rpc/dispatcher.h"

namespace gg::services {

// Sanity ceiling on page sizes so a bad client cannot request an unbounded
// response frame.
inline constexpr std::int64_t kMaxLimit = 100000;

// Fetches a required non-empty string param or throws InvalidParams.
std::string requireString(const rpc::Json& params, const char* key);

// Fetches a required non-empty array of non-empty strings or throws
// InvalidParams.
std::vector<std::string> requireStringArray(const rpc::Json& params, const char* key);

// Fetches the required positive 'limit' param, clamped to kMaxLimit, or
// throws InvalidParams.
std::int64_t requireLimit(const rpc::Json& params);

}  // namespace gg::services
