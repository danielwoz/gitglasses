#include "exec/parsers/incremental_blame.h"

#include <charconv>

namespace gg::exec {

namespace {

bool isHexSha(std::string_view s) {
  if (s.size() != 40) return false;
  for (char c : s) {
    if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return false;
  }
  return true;
}

// Splits "a b c" into fields; returns false if the count doesn't match.
bool parseHeader(std::string_view line, std::string& sha, std::uint32_t& orig, std::uint32_t& res,
                 std::uint32_t& count) {
  const size_t s1 = line.find(' ');
  if (s1 == std::string_view::npos || !isHexSha(line.substr(0, s1))) return false;
  sha = std::string(line.substr(0, s1));

  std::uint32_t* fields[] = {&orig, &res, &count};
  size_t pos = s1 + 1;
  for (int i = 0; i < 3; ++i) {
    const size_t end = i < 2 ? line.find(' ', pos) : line.size();
    if (end == std::string_view::npos) return false;
    auto [ptr, ec] = std::from_chars(line.data() + pos, line.data() + end, *fields[i]);
    if (ec != std::errc() || ptr != line.data() + end) return false;
    pos = end + 1;
  }
  return true;
}

// "author-mail <a@b.c>" -> "a@b.c"
std::string stripMailBrackets(std::string value) {
  if (value.size() >= 2 && value.front() == '<' && value.back() == '>') {
    return value.substr(1, value.size() - 2);
  }
  return value;
}

}  // namespace

void IncrementalBlameParser::feedLine(const std::string& line) {
  std::string sha;
  std::uint32_t orig = 0, res = 0, count = 0;
  if (parseHeader(line, sha, orig, res, count)) {
    emitPending();
    BlameHunk hunk;
    hunk.sha = std::move(sha);
    hunk.originalLine = orig;
    hunk.resultLine = res;
    hunk.lineCount = count;
    // Carry forward the path from the commit's prior mention; a `filename`
    // line will override it before the hunk is emitted.
    if (auto it = commits_.find(hunk.sha); it == commits_.end()) {
      commits_.emplace(hunk.sha, BlameCommit{.sha = hunk.sha});
    }
    pending_ = std::move(hunk);
    return;
  }

  if (!pending_) return;
  BlameCommit& commit = commits_[pending_->sha];

  const size_t space = line.find(' ');
  const std::string key = line.substr(0, space);
  const std::string value = space == std::string::npos ? "" : line.substr(space + 1);

  if (key == "author") {
    commit.author.name = value;
  } else if (key == "author-mail") {
    commit.author.email = stripMailBrackets(value);
  } else if (key == "author-time") {
    commit.author.time = std::atoll(value.c_str());
  } else if (key == "author-tz") {
    commit.author.timezone = value;
  } else if (key == "committer") {
    commit.committer.name = value;
  } else if (key == "committer-mail") {
    commit.committer.email = stripMailBrackets(value);
  } else if (key == "committer-time") {
    commit.committer.time = std::atoll(value.c_str());
  } else if (key == "committer-tz") {
    commit.committer.timezone = value;
  } else if (key == "summary") {
    commit.summary = value;
  } else if (key == "boundary") {
    commit.boundary = true;
  } else if (key == "previous") {
    const size_t shaEnd = value.find(' ');
    if (shaEnd != std::string::npos) {
      pending_->previousSha = value.substr(0, shaEnd);
      pending_->previousPath = value.substr(shaEnd + 1);
    }
  } else if (key == "filename") {
    pending_->path = value;
    emitPending();  // filename terminates the hunk group
  }
}

void IncrementalBlameParser::finish() { emitPending(); }

void IncrementalBlameParser::emitPending() {
  if (!pending_) return;
  BlameHunk hunk = std::move(*pending_);
  pending_.reset();
  onHunk_(hunk);
}

}  // namespace gg::exec
