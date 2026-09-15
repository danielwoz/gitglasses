#pragma once

#include <cstdint>
#include <string>
#include <vector>

#include "rpc/dispatcher.h"

namespace gg::services {

// Page size served when a request omits 'limit'.
inline constexpr std::int64_t kDefaultLimit = 100;

// Sanity ceiling on page sizes so a bad client cannot request an unbounded
// response frame.
inline constexpr std::int64_t kMaxLimit = 100000;

// Bytes of file content rev/fileAtRev returns when the request omits
// 'maxBytes', and the largest a request may ask for. The ceiling keeps the
// response frame inside rpc::kMaxFrameBytes once JSON escaping is applied.
inline constexpr std::int64_t kDefaultFileBytes = 4 * 1024 * 1024;
inline constexpr std::int64_t kMaxFileBytes = 16 * 1024 * 1024;

// Fetches a required non-empty string param or throws InvalidParams.
std::string requireString(const rpc::Json& params, const char* key);

// Fetches an optional string param: absent yields "", present yields a
// non-empty string. A present empty value is rejected, so "" always means
// "absent".
std::string optionalString(const rpc::Json& params, const char* key);

// Fetches a required non-empty array of non-empty strings or throws
// InvalidParams.
std::vector<std::string> requireStringArray(const rpc::Json& params, const char* key);

// Fetches a required boolean param or throws InvalidParams.
bool requireBool(const rpc::Json& params, const char* key);

// Fetches a required integer param within [min, max] or throws InvalidParams.
// Fractional numbers are rejected rather than truncated.
std::int64_t requireInteger(const rpc::Json& params, const char* key, std::int64_t min,
                            std::int64_t max);

// Same, yielding `fallback` when the key is absent.
std::int64_t optionalInteger(const rpc::Json& params, const char* key, std::int64_t min,
                             std::int64_t max, std::int64_t fallback);

// Fetches the 'limit' page size, defaulting to kDefaultLimit. Values outside
// [1, kMaxLimit] are rejected.
std::int64_t pageLimit(const rpc::Json& params);

// Fetches an optional object param, yielding an empty object when absent. A
// present non-object is rejected.
rpc::Json optionalObject(const rpc::Json& params, const char* key);

}  // namespace gg::services
