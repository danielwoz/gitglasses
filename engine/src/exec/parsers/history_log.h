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
  // Line mode only, when kept: the diff `git log -L` shows for the range in
  // this commit, cut at the parser's byte cap (patchTruncated).
  std::string patch;
  bool patchTruncated = false;
};

// Resolves git's numstat rename syntax to the file's post-rename path:
// "old => new" -> "new", "pre{old => new}post" -> "prenewpost". Plain paths
// pass through unchanged.
std::string numstatCurrentPath(std::string_view path);

// Streaming parser for `git log` output using the record format
// %x1e%H%x1f%an%x1f%ae%x1f%at%x1f%s (one line per commit, 0x1e record start,
// 0x1f field separators). In Numstat mode the first "adds<TAB>dels<TAB>path"
// line after a record fills in that entry's diff stats and per-commit path
// (binary files report "-" and parse as 0). In None mode every other line is
// skipped. In LinePatch mode the record is followed by the diff `git log -L`
// shows for the followed range: its added and removed lines are counted, its
// "+++ b/<path>" header names the file at that commit (the range follows
// renames), and with keepPatch() the diff text itself is kept.
class HistoryLogParser {
 public:
  enum class Stats { Numstat, None, LinePatch };
  using EntryFn = std::function<void(const HistoryEntry&)>;

  // `defaultPath` seeds entry.path for records without a numstat line (and
  // all records in None mode).
  HistoryLogParser(Stats stats, std::string defaultPath, EntryFn onEntry)
      : stats_(stats), defaultPath_(std::move(defaultPath)), onEntry_(std::move(onEntry)) {}

  // LinePatch mode: keep each record's diff text, up to `maxBytes` of it.
  void keepPatch(size_t maxBytes) {
    keepPatch_ = true;
    maxPatchBytes_ = maxBytes;
  }

  void feedLine(const std::string& line);
  void finish();

 private:
  void emitPending();
  void feedPatchLine(const std::string& line);
  void appendPatch(const std::string& line);

  // Where LinePatch mode is within a record's diff.
  enum class PatchState { BeforeDiff, Header, Hunk };

  Stats stats_;
  std::string defaultPath_;
  EntryFn onEntry_;
  std::optional<HistoryEntry> pending_;
  bool sawStats_ = false;
  PatchState patchState_ = PatchState::BeforeDiff;
  bool keepPatch_ = false;
  size_t maxPatchBytes_ = 0;
};

}  // namespace gg::exec
