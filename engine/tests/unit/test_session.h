#pragma once

// Shared harness for end-to-end tests: drives the full server loop (framing +
// dispatcher + registry) over in-memory streams, exactly as a client process
// would over stdio.

#include <gtest/gtest.h>
#include <nlohmann/json.hpp>

#include <algorithm>
#include <chrono>
#include <condition_variable>
#include <cstddef>
#include <deque>
#include <istream>
#include <mutex>
#include <optional>
#include <ostream>
#include <sstream>
#include <streambuf>
#include <string>
#include <thread>
#include <vector>

#include "server.h"

namespace gg::testing {

using Json = nlohmann::json;

inline std::string frame(const Json& message) {
  const std::string payload = message.dump();
  return "Content-Length: " + std::to_string(payload.size()) + "\r\n\r\n" + payload;
}

inline std::vector<Json> parseFrames(const std::string& output) {
  std::vector<Json> messages;
  size_t pos = 0;
  while ((pos = output.find("\r\n\r\n", pos)) != std::string::npos) {
    const size_t lengthPos = output.rfind("Content-Length:", pos);
    const size_t length = std::stoul(output.substr(lengthPos + 15, pos - lengthPos - 15));
    pos += 4;
    messages.push_back(Json::parse(output.substr(pos, length)));
    pos += length;
  }
  return messages;
}

inline Json responseFor(const std::vector<Json>& messages, std::int64_t id) {
  for (const auto& m : messages) {
    if (m.contains("id") && m["id"] == id) return m;
  }
  ADD_FAILURE() << "no response for id " << id;
  return {};
}

// Runs a full session: sends the given requests, closes stdin, returns all
// engine responses.
inline std::vector<Json> runSession(const std::vector<Json>& requests) {
  std::string input;
  for (const auto& r : requests) input += frame(r);
  std::istringstream in(input);
  std::ostringstream out;
  EXPECT_EQ(runServer(in, out), 0);
  return parseFrames(out.str());
}

// One direction of an in-memory pipe: a thread-safe byte queue exposed as a
// streambuf, so plain std::istream/std::ostream can be layered on top. Reads
// block until data arrives or the write end is closed (EOF); waitReadable
// gives readers a timed wait so tests fail instead of hanging.
class PipeStreamBuf : public std::streambuf {
 public:
  // Signals EOF to the read end once the queued bytes are drained; further
  // writes are rejected.
  void closeWrite() {
    std::lock_guard<std::mutex> lock(mutex_);
    closed_ = true;
    readable_.notify_all();
  }

  // Waits until bytes are available (or EOF is observable) before `deadline`;
  // returns false on timeout.
  bool waitReadable(std::chrono::steady_clock::time_point deadline) {
    std::unique_lock<std::mutex> lock(mutex_);
    return readable_.wait_until(lock, deadline,
                                [this] { return !queue_.empty() || closed_; });
  }

 protected:
  // No get/put areas are installed, so every transfer funnels through these
  // overrides and stays under the mutex.
  int_type overflow(int_type ch) override {
    if (traits_type::eq_int_type(ch, traits_type::eof())) return traits_type::not_eof(ch);
    std::lock_guard<std::mutex> lock(mutex_);
    if (closed_) return traits_type::eof();
    queue_.push_back(traits_type::to_char_type(ch));
    readable_.notify_all();
    return ch;
  }

  std::streamsize xsputn(const char* s, std::streamsize n) override {
    std::lock_guard<std::mutex> lock(mutex_);
    if (closed_) return 0;
    queue_.insert(queue_.end(), s, s + n);
    readable_.notify_all();
    return n;
  }

  int_type underflow() override {
    std::unique_lock<std::mutex> lock(mutex_);
    readable_.wait(lock, [this] { return !queue_.empty() || closed_; });
    if (queue_.empty()) return traits_type::eof();
    return traits_type::to_int_type(queue_.front());
  }

  int_type uflow() override {
    std::unique_lock<std::mutex> lock(mutex_);
    readable_.wait(lock, [this] { return !queue_.empty() || closed_; });
    if (queue_.empty()) return traits_type::eof();
    const char c = queue_.front();
    queue_.pop_front();
    return traits_type::to_int_type(c);
  }

  std::streamsize xsgetn(char* s, std::streamsize n) override {
    std::unique_lock<std::mutex> lock(mutex_);
    std::streamsize got = 0;
    while (got < n) {
      readable_.wait(lock, [this] { return !queue_.empty() || closed_; });
      if (queue_.empty()) break;  // closed and drained: short read = EOF
      const auto take =
          std::min<std::streamsize>(n - got, static_cast<std::streamsize>(queue_.size()));
      for (std::streamsize i = 0; i < take; ++i) {
        s[got + i] = queue_.front();
        queue_.pop_front();
      }
      got += take;
    }
    return got;
  }

  std::streamsize showmanyc() override {
    std::lock_guard<std::mutex> lock(mutex_);
    if (!queue_.empty()) return static_cast<std::streamsize>(queue_.size());
    return closed_ ? -1 : 0;
  }

 private:
  std::mutex mutex_;
  std::condition_variable readable_;
  std::deque<char> queue_;
  bool closed_ = false;
};

// A live server session over in-memory pipes: requests can await their
// responses, mirroring how the extension actually talks to the engine (a
// dependent request is only sent after its prerequisite completed).
class InteractiveSession {
 public:
  InteractiveSession() {
    serverThread_ = std::thread([this] {
      std::istream in(&toServer_);
      std::ostream out(&fromServer_);
      runServer(in, out);
      fromServer_.closeWrite();  // pending client reads see EOF
    });
  }

  ~InteractiveSession() {
    closeInput();
    serverThread_.join();
  }

  void notify(const Json& message) { writeFrame(message); }

  // Sends the request and blocks until its response arrives; interleaved
  // notifications are collected into `notifications`.
  Json request(const Json& message) {
    writeFrame(message);
    std::istream in(&fromServer_);
    FrameReaderStream reader(in);
    for (;;) {
      auto payload = reader.read();
      if (!payload) {
        ADD_FAILURE() << "server closed stream before response";
        return {};
      }
      Json m = Json::parse(*payload);
      if (m.contains("id") && m["id"] == message["id"]) return m;
      notifications.push_back(std::move(m));
    }
  }

  // Reads frames until a notification named `method` arrives and returns it;
  // other frames read along the way are collected into `notifications`. Fails
  // the test and returns an empty message on timeout.
  Json readNotificationUntil(const std::string& method, int timeoutMs) {
    // A matching notification may already have been collected while waiting
    // for an earlier response (slow git makes this timing common).
    for (auto it = notifications.begin(); it != notifications.end(); ++it) {
      if (it->value("method", "") == method) {
        Json found = *it;
        notifications.erase(it);
        return found;
      }
    }
    std::istream in(&fromServer_);
    FrameReaderStream reader(in);
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(timeoutMs);
    for (;;) {
      // Only block in read() once bytes are known to be pending, so a missing
      // notification fails the test instead of hanging it.
      if (!fromServer_.waitReadable(deadline)) {
        ADD_FAILURE() << "timed out waiting for notification: " << method;
        return {};
      }
      auto payload = reader.read();
      if (!payload) {
        ADD_FAILURE() << "server closed stream before notification: " << method;
        return {};
      }
      Json m = Json::parse(*payload);
      if (!m.contains("id") && m.value("method", "") == method) return m;
      notifications.push_back(std::move(m));
    }
  }

  void closeInput() { toServer_.closeWrite(); }

  std::vector<Json> notifications;

 private:
  // Minimal blocking frame reader over the client end of the pipe.
  struct FrameReaderStream {
    std::istream& in;
    explicit FrameReaderStream(std::istream& s) : in(s) {}
    std::optional<std::string> read() {
      std::string line;
      size_t length = 0;
      while (std::getline(in, line)) {
        if (!line.empty() && line.back() == '\r') line.pop_back();
        if (line.empty()) {
          std::string payload(length, '\0');
          in.read(payload.data(), static_cast<std::streamsize>(length));
          if (in.gcount() != static_cast<std::streamsize>(length)) return std::nullopt;
          return payload;
        }
        if (line.rfind("Content-Length:", 0) == 0) {
          length = std::stoul(line.substr(15));
        }
      }
      return std::nullopt;
    }
  };

  void writeFrame(const Json& message) {
    const std::string payload = message.dump();
    std::ostream out(&toServer_);
    out << "Content-Length: " << payload.size() << "\r\n\r\n" << payload;
    ASSERT_TRUE(out.good()) << "write to closed session input";
  }

  PipeStreamBuf toServer_;    // client writes, server reads
  PipeStreamBuf fromServer_;  // server writes, client reads
  std::thread serverThread_;
};

inline Json initRequest(std::int64_t id = 1) {
  return {{"jsonrpc", "2.0"},
          {"id", id},
          {"method", "initialize"},
          {"params", {{"protocolVersion", "0.1.0"}}}};
}

}  // namespace gg::testing
