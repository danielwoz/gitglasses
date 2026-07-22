#pragma once

#include <cstdint>
#include <functional>
#include <optional>
#include <string>
#include <string_view>

#include "exec/parsers/incremental_blame.h"

namespace gg::exec {

struct HistoryEntry {
  std::string sha;
  BlameSignature author;
  std::string summary;
  std::string path;  // the file's name at this commit (differs across renames)
  std::uint32_t additions = 0;
  std::uint32_t deletions = 0;
};

// Resolves git's numstat rename syntax to the file's post-rename path:
// "old => new" -> "new", "pre{old => new}post" -> "prenewpost". Plain paths
// pass through unchanged.
std::string numstatCurrentPath(std::string_view path);

// Streaming parser for `git log` output using the record format
// %x1e%H%x1f%an%x1f%ae%x1f%at%x1f%s (one line per commit, 0x1e record start,
// 0x1f field separators). In Numstat mode the first "adds<TAB>dels<TAB>path"
// line after a record fills in that entry's diff stats and per-commit path
// (binary files report "-" and parse as 0). Every other line is skipped,
// which also makes the parser usable for `git log -L` output, where patch
// text cannot be suppressed and must be ignored.
class HistoryLogParser {
 public:
  enum class Stats { Numstat, None };
  using EntryFn = std::function<void(const HistoryEntry&)>;

  // `defaultPath` seeds entry.path for records without a numstat line (and
  // all records in None mode).
  HistoryLogParser(Stats stats, std::string defaultPath, EntryFn onEntry)
      : stats_(stats), defaultPath_(std::move(defaultPath)), onEntry_(std::move(onEntry)) {}

  void feedLine(const std::string& line);
  void finish();

 private:
  void emitPending();

  Stats stats_;
  std::string defaultPath_;
  EntryFn onEntry_;
  std::optional<HistoryEntry> pending_;
  bool sawStats_ = false;
};

}  // namespace gg::exec
