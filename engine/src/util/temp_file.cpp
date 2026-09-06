#include "util/temp_file.h"

#include <cstdint>
#include <cstdio>
#include <fstream>
#include <random>

namespace gg::util {

namespace {

std::string randomHex16() {
  static thread_local std::mt19937_64 generator(std::random_device{}());
  std::uniform_int_distribution<std::uint64_t> any;
  char buffer[17];
  std::snprintf(buffer, sizeof(buffer), "%016llx",
                static_cast<unsigned long long>(any(generator)));
  return buffer;
}

}  // namespace

std::filesystem::path randomTempPath(const std::string& prefix, const std::string& suffix) {
  return std::filesystem::temp_directory_path() / (prefix + randomHex16() + suffix);
}

Result<TempFile> TempFile::create(const std::string& contents, const std::string& prefix,
                                  const std::string& suffix) {
  TempFile file;
  file.path_ = randomTempPath(prefix, suffix).string();
  std::ofstream out(file.path_, std::ios::binary | std::ios::trunc);
  if (!out) return Error{ErrorCode::Internal, "failed to create temp file"};
  // These files hold the user's source and diffs and live in a world-readable
  // shared directory, so drop group/other access before any contents land.
  // Narrowed while the file is still empty, so nothing is ever exposed.
  std::error_code permsEc;
  std::filesystem::permissions(
      file.path_, std::filesystem::perms::owner_read | std::filesystem::perms::owner_write,
      std::filesystem::perm_options::replace, permsEc);
  out.write(contents.data(), static_cast<std::streamsize>(contents.size()));
  out.flush();
  if (!out) {
    out.close();
    std::error_code ec;
    std::filesystem::remove(file.path_, ec);
    file.path_.clear();
    return Error{ErrorCode::Internal, "failed to write temp file"};
  }
  return file;
}

TempFile::~TempFile() {
  if (path_.empty()) return;
  std::error_code ec;
  std::filesystem::remove(path_, ec);
}

}  // namespace gg::util
