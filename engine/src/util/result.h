#pragma once

#include <string>
#include <utility>
#include <variant>

namespace gg {

// Error codes surfaced across the RPC boundary. Values in the -32000..-32099
// range follow JSON-RPC's reserved implementation-defined error band.
enum class ErrorCode {
  Cancelled = -32800,
  InvalidRequest = -32600,
  MethodNotFound = -32601,
  InvalidParams = -32602,
  Internal = -32603,
  RepoNotFound = -32000,
  GitError = -32001,
  NotInitialized = -32002,
};

struct Error {
  ErrorCode code = ErrorCode::Internal;
  std::string message;
};

// Minimal expected-like result type (std::expected requires C++23).
template <typename T>
class Result {
 public:
  Result(T value) : value_(std::move(value)) {}
  Result(Error error) : value_(std::move(error)) {}

  bool ok() const { return std::holds_alternative<T>(value_); }
  explicit operator bool() const { return ok(); }

  T& value() & { return std::get<T>(value_); }
  const T& value() const& { return std::get<T>(value_); }
  T&& value() && { return std::get<T>(std::move(value_)); }

  const Error& error() const { return std::get<Error>(value_); }

 private:
  std::variant<T, Error> value_;
};

template <>
class Result<void> {
 public:
  Result() = default;
  Result(Error error) : error_(std::move(error)), ok_(false) {}

  bool ok() const { return ok_; }
  explicit operator bool() const { return ok_; }
  const Error& error() const { return error_; }

 private:
  Error error_;
  bool ok_ = true;
};

}  // namespace gg
