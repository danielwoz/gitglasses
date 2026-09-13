#include "services/params.h"

#include <algorithm>

namespace gg::services {

std::string requireString(const rpc::Json& params, const char* key) {
  const std::string value = params.value(key, "");
  if (value.empty()) {
    throw rpc::HandlerError{
        {ErrorCode::InvalidParams, std::string("'") + key + "' is required"}};
  }
  return value;
}

std::vector<std::string> requireStringArray(const rpc::Json& params, const char* key) {
  if (!params.contains(key) || !params[key].is_array() || params[key].empty()) {
    throw rpc::HandlerError{{ErrorCode::InvalidParams,
                             std::string("'") + key + "' must be a non-empty array"}};
  }
  std::vector<std::string> values;
  for (const auto& entry : params[key]) {
    if (!entry.is_string() || entry.get<std::string>().empty()) {
      throw rpc::HandlerError{{ErrorCode::InvalidParams,
                               std::string("'") + key + "' entries must be non-empty strings"}};
    }
    values.push_back(entry.get<std::string>());
  }
  return values;
}

std::int64_t requireLimit(const rpc::Json& params) {
  const std::int64_t limit = params.value("limit", std::int64_t{0});
  if (limit <= 0) {
    throw rpc::HandlerError{{ErrorCode::InvalidParams, "'limit' must be a positive integer"}};
  }
  return std::min(limit, kMaxLimit);
}

}  // namespace gg::services
