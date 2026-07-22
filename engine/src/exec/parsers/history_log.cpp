#include "exec/parsers/history_log.h"

#include <charconv>

namespace gg::exec {

namespace {

constexpr char kRecordStart = '\x1e';
constexpr char kFieldSep = '\x1f';

// Parses a numstat count: a decimal number, or "-" for binary files (counted
// as zero). Returns false for anything else.
bool parseCount(std::string_view field, std::uint32_t& out) {
  if (field == "-") {
    out = 0;
    return true;
  }
  if (field.empty()) return false;
  auto [ptr, ec] = std::from_chars(field.data(), field.data() + field.size(), out);
  return ec == std::errc() && ptr == field.data() + field.size();
}

}  // namespace

std::string numstatCurrentPath(std::string_view path) {
  // Compact form: common-prefix{old => new}common-suffix.
  const size_t open = path.find('{');
  if (open != std::string_view::npos) {
    const size_t arrow = path.find(" => ", open);
    const size_t close = path.find('}', open);
    if (arrow != std::string_view::npos && close != std::string_view::npos && arrow < close) {
      std::string result(path.substr(0, open));
      result += path.substr(arrow + 4, close - (arrow + 4));
      result += path.substr(close + 1);
      return result;
    }
  }
  // Full form: old => new.
  const size_t arrow = path.find(" => ");
  if (arrow != std::string_view::npos) return std::string(path.substr(arrow + 4));
  return std::string(path);
}

void HistoryLogParser::feedLine(const std::string& line) {
  if (!line.empty() && line[0] == kRecordStart) {
    emitPending();
    std::string_view rest(line);
    rest.remove_prefix(1);
    // sha SEP author-name SEP author-email SEP author-time SEP summary. The
    // summary is the unsplit remainder, so separators inside it are inert.
    std::string_view fields[4];
    for (auto& field : fields) {
      const size_t sep = rest.find(kFieldSep);
      if (sep == std::string_view::npos) return;  // malformed record: drop it
      field = rest.substr(0, sep);
      rest.remove_prefix(sep + 1);
    }
    HistoryEntry entry;
    entry.sha = std::string(fields[0]);
    entry.author.name = std::string(fields[1]);
    entry.author.email = std::string(fields[2]);
    std::from_chars(fields[3].data(), fields[3].data() + fields[3].size(), entry.author.time);
    entry.summary = std::string(rest);
    entry.path = defaultPath_;
    pending_ = std::move(entry);
    sawStats_ = false;
    return;
  }

  if (stats_ != Stats::Numstat || !pending_ || sawStats_) return;

  // adds TAB dels TAB path. Only the followed file appears, so the first
  // matching line belongs to this record; everything else (blank separators)
  // is skipped.
  const size_t tab1 = line.find('\t');
  if (tab1 == std::string::npos) return;
  const size_t tab2 = line.find('\t', tab1 + 1);
  if (tab2 == std::string::npos) return;
  std::uint32_t additions = 0;
  std::uint32_t deletions = 0;
  const std::string_view view(line);
  if (!parseCount(view.substr(0, tab1), additions)) return;
  if (!parseCount(view.substr(tab1 + 1, tab2 - tab1 - 1), deletions)) return;
  pending_->additions = additions;
  pending_->deletions = deletions;
  pending_->path = numstatCurrentPath(view.substr(tab2 + 1));
  sawStats_ = true;
}

void HistoryLogParser::finish() { emitPending(); }

void HistoryLogParser::emitPending() {
  if (!pending_) return;
  HistoryEntry entry = std::move(*pending_);
  pending_.reset();
  onEntry_(entry);
}

}  // namespace gg::exec
