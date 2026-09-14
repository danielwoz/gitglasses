#include "services/params.h"

#include <limits>

namespace gg::services {

namespace {

[[noreturn]] void reject(const char* key, const std::string& what) {
  throw rpc::HandlerError{
      {ErrorCode::InvalidParams, std::string("'") + key + "' " + what}};
}

// Locates a param, treating a non-object params payload as carrying none.
const rpc::Json* find(const rpc::Json& params, const char* key) {
  if (!params.is_object()) return nullptr;
  const auto it = params.find(key);
  return it == params.end() ? nullptr : &*it;
}

std::int64_t checkedInteger(const rpc::Json& value, const char* key, std::int64_t min,
                            std::int64_t max) {
  if (!value.is_number_integer()) reject(key, "must be an integer");
  const auto number = value.get<std::int64_t>();
  if (number < min || number > max) {
    reject(key, max == std::numeric_limits<std::int64_t>::max()
                    ? "must be at least " + std::to_string(min)
                    : "must be between " + std::to_string(min) + " and " + std::to_string(max));
  }
  return number;
}

}  // namespace

std::string requireString(const rpc::Json& params, const char* key) {
  const std::string value = params.value(key, "");
  if (value.empty()) reject(key, "is required");
  return value;
}

std::string optionalString(const rpc::Json& params, const char* key) {
  const rpc::Json* value = find(params, key);
  if (!value) return {};
  if (!value->is_string()) reject(key, "must be a string");
  std::string text = value->get<std::string>();
  if (text.empty()) reject(key, "must not be empty when present");
  return text;
}

std::vector<std::string> requireStringArray(const rpc::Json& params, const char* key) {
  const rpc::Json* value = find(params, key);
  if (!value || !value->is_array() || value->empty()) {
    reject(key, "must be a non-empty array");
  }
  std::vector<std::string> values;
  for (const auto& entry : *value) {
    if (!entry.is_string() || entry.get<std::string>().empty()) {
      reject(key, "entries must be non-empty strings");
    }
    values.push_back(entry.get<std::string>());
  }
  return values;
}

bool requireBool(const rpc::Json& params, const char* key) {
  const rpc::Json* value = find(params, key);
  if (!value) reject(key, "is required");
  if (!value->is_boolean()) reject(key, "must be a boolean");
  return value->get<bool>();
}

std::int64_t requireInteger(const rpc::Json& params, const char* key, std::int64_t min,
                            std::int64_t max) {
  const rpc::Json* value = find(params, key);
  if (!value) reject(key, "is required");
  return checkedInteger(*value, key, min, max);
}

std::int64_t optionalInteger(const rpc::Json& params, const char* key, std::int64_t min,
                             std::int64_t max, std::int64_t fallback) {
  const rpc::Json* value = find(params, key);
  if (!value) return fallback;
  return checkedInteger(*value, key, min, max);
}

std::int64_t pageLimit(const rpc::Json& params) {
  return optionalInteger(params, "limit", 1, kMaxLimit, kDefaultLimit);
}

rpc::Json optionalObject(const rpc::Json& params, const char* key) {
  const rpc::Json* value = find(params, key);
  if (!value) return rpc::Json::object();
  if (!value->is_object()) reject(key, "must be an object");
  return *value;
}

}  // namespace gg::services
