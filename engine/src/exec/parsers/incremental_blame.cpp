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

std::string unquoteCPath(std::string_view text) {
  if (text.size() < 2 || text.front() != '"' || text.back() != '"') return std::string(text);
  const std::string_view body = text.substr(1, text.size() - 2);
  std::string out;
  out.reserve(body.size());
  for (size_t i = 0; i < body.size(); ++i) {
    const char c = body[i];
    if (c != '\\' || i + 1 == body.size()) {
      out.push_back(c);
      continue;
    }
    const char next = body[++i];
    // Single-letter escapes, as git's quote_c_style writes them.
    constexpr std::string_view kLetters = "abtnvfr";
    constexpr std::string_view kBytes = "\a\b\t\n\v\f\r";
    if (const size_t k = kLetters.find(next); k != std::string_view::npos) {
      out.push_back(kBytes[k]);
    } else if (next >= '0' && next <= '3' && i + 2 < body.size() && body[i + 1] >= '0' &&
               body[i + 1] <= '7' && body[i + 2] >= '0' && body[i + 2] <= '7') {
      // Three octal digits name one byte of the path.
      out.push_back(static_cast<char>(((next - '0') << 6) | ((body[i + 1] - '0') << 3) |
                                      (body[i + 2] - '0')));
      i += 2;
    } else {
      // \" and \\, and anything git does not emit, stand for themselves.
      out.push_back(next);
    }
  }
  return out;
}

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
      BlameCommit commit;
      commit.sha = hunk.sha;
      commits_.emplace(hunk.sha, std::move(commit));
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
      pending_->previousPath = unquoteCPath(std::string_view(value).substr(shaEnd + 1));
    }
  } else if (key == "filename") {
    pending_->path = unquoteCPath(value);
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
