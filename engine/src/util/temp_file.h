#pragma once

#include <filesystem>
#include <string>

#include "util/result.h"

namespace gg::util {

// A path in the system temp directory with a random component:
// <tmp>/<prefix><16 hex chars><suffix>. The file is not created.
std::filesystem::path randomTempPath(const std::string& prefix, const std::string& suffix);

// RAII temp file holding `contents` (written byte-exact), removed on scope
// exit. Used wherever git needs a file argument for data the engine holds in
// memory (blame --contents, apply patches, rebase control files).
class TempFile {
 public:
  static Result<TempFile> create(const std::string& contents, const std::string& prefix,
                                 const std::string& suffix = "");

  TempFile(TempFile&& other) noexcept
      : file_(std::move(other.file_)), path_(std::move(other.path_)) {
    other.file_.clear();
    other.path_.clear();
  }
  TempFile(const TempFile&) = delete;
  TempFile& operator=(const TempFile&) = delete;
  TempFile& operator=(TempFile&&) = delete;
  ~TempFile();

  // UTF-8, like every other path the engine hands to git's argv.
  const std::string& path() const { return path_; }

 private:
  TempFile() = default;
  // The native path is what the filesystem calls use: on Windows a narrow
  // string would go through the ANSI code page and miss a %TEMP% with
  // characters outside it.
  std::filesystem::path file_;
  std::string path_;
};

}  // namespace gg::util
