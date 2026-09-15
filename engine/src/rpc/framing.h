#pragma once

#include <iosfwd>
#include <mutex>
#include <optional>
#include <string>

namespace gg::rpc {

// Largest frame accepted. Content-Length sizes the payload buffer before any
// body byte is read, so it is capped here. 64 MiB is far above any real
// message (the largest are streamed blame/graph batches).
inline constexpr size_t kMaxFrameBytes = 64u * 1024u * 1024u;

// Reads LSP-style framed messages: "Content-Length: N\r\n" headers, a blank
// line, then exactly N payload bytes. Unknown headers are skipped.
class FrameReader {
 public:
  explicit FrameReader(std::istream& in) : in_(in) {}

  // Returns the next payload, or nullopt on EOF / malformed stream.
  std::optional<std::string> read();

  /** True when read() stopped on a protocol violation rather than end of input.
   * The body of a refused frame is never consumed, so the stream is desynced
   * and no further frame can be trusted. */
  bool failed() const { return failed_; }

 private:
  std::istream& in_;
  bool failed_ = false;
};

// Writes framed messages. Thread-safe: a single mutex serializes writers so
// concurrent responses and streamed notifications never interleave bytes.
class FrameWriter {
 public:
  explicit FrameWriter(std::ostream& out) : out_(out) {}

  void write(const std::string& payload);

 private:
  std::ostream& out_;
  std::mutex mutex_;
};

}  // namespace gg::rpc
