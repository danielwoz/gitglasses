#pragma once

#include <filesystem>
#include <string>

namespace gg::util {

// A filesystem path from UTF-8 text, the encoding libgit2 and the protocol
// use for paths. On Windows a path built from a narrow string goes through
// the ANSI code page and misreads non-ASCII names.
inline std::filesystem::path pathFromUtf8(const std::string& text) {
  std::u8string utf8;
  utf8.reserve(text.size());
  for (const char c : text) utf8.push_back(static_cast<char8_t>(c));
  return std::filesystem::path(utf8);
}

// The UTF-8 text of a path, with forward slashes: the form git's `sh -c`
// accepts on every platform (Git for Windows included).
inline std::string genericUtf8(const std::filesystem::path& path) {
  const std::u8string utf8 = path.generic_u8string();
  return std::string(utf8.begin(), utf8.end());
}

// The UTF-8 text of a path in its native form.
inline std::string utf8FromPath(const std::filesystem::path& path) {
  const std::u8string utf8 = path.u8string();
  return std::string(utf8.begin(), utf8.end());
}

}  // namespace gg::util
