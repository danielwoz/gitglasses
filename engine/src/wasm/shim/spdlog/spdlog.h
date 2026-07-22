#pragma once

// spdlog-compatible logging surface for the wasm build, where spdlog is not
// linked. Messages go to stderr with fmt-style "{}" substitution. This header
// shadows the real <spdlog/spdlog.h> via the wasm target's include path only;
// native builds keep the real spdlog.

#include <cstdio>
#include <sstream>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace spdlog {

namespace shim {

template <typename T>
std::string toString(T&& value) {
  std::ostringstream out;
  out << value;
  return out.str();
}

// Replaces successive "{}" placeholders with the stringified arguments.
inline std::string substitute(std::string_view fmt, const std::vector<std::string>& parts) {
  std::string out;
  size_t next = 0;
  for (size_t pos = 0; pos < fmt.size();) {
    if (next < parts.size() && pos + 1 < fmt.size() && fmt[pos] == '{' && fmt[pos + 1] == '}') {
      out += parts[next++];
      pos += 2;
    } else {
      out += fmt[pos++];
    }
  }
  return out;
}

template <typename... Args>
void log(const char* level, std::string_view fmt, Args&&... args) {
  const std::string message = substitute(fmt, {toString(std::forward<Args>(args))...});
  std::fprintf(stderr, "[engine:%s] %s\n", level, message.c_str());
}

}  // namespace shim

template <typename... Args>
void debug(std::string_view fmt, Args&&... args) {
  shim::log("debug", fmt, std::forward<Args>(args)...);
}

template <typename... Args>
void info(std::string_view fmt, Args&&... args) {
  shim::log("info", fmt, std::forward<Args>(args)...);
}

template <typename... Args>
void warn(std::string_view fmt, Args&&... args) {
  shim::log("warn", fmt, std::forward<Args>(args)...);
}

template <typename... Args>
void error(std::string_view fmt, Args&&... args) {
  shim::log("error", fmt, std::forward<Args>(args)...);
}

}  // namespace spdlog
