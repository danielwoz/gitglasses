#pragma once

#include <iosfwd>
#include <mutex>
#include <optional>
#include <string>

namespace gg::rpc {

// Reads LSP-style framed messages: "Content-Length: N\r\n" headers, a blank
// line, then exactly N payload bytes. Unknown headers are skipped.
class FrameReader {
 public:
  explicit FrameReader(std::istream& in) : in_(in) {}

  // Returns the next payload, or nullopt on EOF / malformed stream.
  std::optional<std::string> read();

 private:
  std::istream& in_;
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
