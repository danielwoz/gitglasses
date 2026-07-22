#pragma once

#include <cstdint>
#include <functional>
#include <map>
#include <optional>
#include <string>

namespace gg::exec {

// The all-zeros SHA git uses for lines not yet committed (working tree /
// dirty buffer edits).
inline constexpr const char* kUncommittedSha = "0000000000000000000000000000000000000000";

struct BlameSignature {
  std::string name;
  std::string email;  // without the <> wrapping
  std::int64_t time = 0;
  std::string timezone;
};

struct BlameCommit {
  std::string sha;
  BlameSignature author;
  BlameSignature committer;
  std::string summary;
  bool boundary = false;
};

struct BlameHunk {
  std::string sha;
  std::uint32_t resultLine = 0;    // 1-based line in the blamed file version
  std::uint32_t originalLine = 0;  // 1-based line in the blamed commit's file
  std::uint32_t lineCount = 0;
  std::string path;                // path in the blamed commit (renames differ)
  std::optional<std::string> previousSha;
  std::optional<std::string> previousPath;
};

// Streaming parser for `git blame --incremental` output. Feed lines in order;
// onHunk fires as each hunk group completes (metadata lines for a commit only
// appear the first time git mentions it — the parser carries them forward).
class IncrementalBlameParser {
 public:
  using HunkFn = std::function<void(const BlameHunk&)>;

  explicit IncrementalBlameParser(HunkFn onHunk) : onHunk_(std::move(onHunk)) {}

  void feedLine(const std::string& line);
  void finish();

  const std::map<std::string, BlameCommit>& commits() const { return commits_; }

 private:
  void emitPending();

  HunkFn onHunk_;
  std::map<std::string, BlameCommit> commits_;
  std::optional<BlameHunk> pending_;
};

}  // namespace gg::exec
