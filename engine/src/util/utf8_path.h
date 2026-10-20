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

}  // namespace gg::util
