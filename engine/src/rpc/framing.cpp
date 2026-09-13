#include "rpc/framing.h"

#include <charconv>
#include <istream>
#include <ostream>

namespace gg::rpc {

namespace {

// Strips a trailing '\r' left by getline() splitting on '\n'.
void chomp(std::string& line) {
  if (!line.empty() && line.back() == '\r') line.pop_back();
}

}  // namespace

std::optional<std::string> FrameReader::read() {
  size_t contentLength = 0;
  bool sawLength = false;

  std::string line;
  while (std::getline(in_, line)) {
    chomp(line);
    if (line.empty()) {
      if (!sawLength) return std::nullopt;
      std::string payload(contentLength, '\0');
      in_.read(payload.data(), static_cast<std::streamsize>(contentLength));
      if (in_.gcount() != static_cast<std::streamsize>(contentLength)) return std::nullopt;
      return payload;
    }

    constexpr std::string_view kHeader = "Content-Length:";
    if (line.rfind(kHeader, 0) == 0) {
      std::string_view value(line);
      value.remove_prefix(kHeader.size());
      while (!value.empty() && value.front() == ' ') value.remove_prefix(1);
      auto [ptr, ec] = std::from_chars(value.data(), value.data() + value.size(), contentLength);
      if (ec != std::errc()) return std::nullopt;
      // Refuse before allocating: the body has not been read yet.
      if (contentLength > kMaxFrameBytes) return std::nullopt;
      (void)ptr;
      sawLength = true;
    }
  }
  return std::nullopt;
}

void FrameWriter::write(const std::string& payload) {
  std::lock_guard lock(mutex_);
  out_ << "Content-Length: " << payload.size() << "\r\n\r\n" << payload;
  out_.flush();
}

}  // namespace gg::rpc
