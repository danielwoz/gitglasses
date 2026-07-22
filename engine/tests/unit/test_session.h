#pragma once

// Shared harness for end-to-end tests: drives the full server loop (framing +
// dispatcher + registry) over in-memory streams or real pipes, exactly as a
// client process would over stdio.

#include <gtest/gtest.h>
#include <nlohmann/json.hpp>

#include <ext/stdio_filebuf.h>
#include <poll.h>
#include <unistd.h>

#include <chrono>
#include <memory>
#include <optional>
#include <sstream>
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

// A live server session over real pipes: requests can await their responses,
// mirroring how the extension actually talks to the engine (a dependent
// request is only sent after its prerequisite completed).
class InteractiveSession {
 public:
  InteractiveSession() {
    int toServer[2], fromServer[2];
    EXPECT_EQ(pipe(toServer), 0);
    EXPECT_EQ(pipe(fromServer), 0);
    inWrite_ = toServer[1];
    outRead_ = fromServer[0];
    serverIn_ = std::make_unique<__gnu_cxx::stdio_filebuf<char>>(toServer[0], std::ios::in);
    serverOut_ = std::make_unique<__gnu_cxx::stdio_filebuf<char>>(fromServer[1], std::ios::out);
    clientRead_ = std::make_unique<__gnu_cxx::stdio_filebuf<char>>(fromServer[0], std::ios::in);
    serverThread_ = std::thread([this] {
      std::istream in(serverIn_.get());
      std::ostream out(serverOut_.get());
      runServer(in, out);
      serverOut_.reset();  // flush + close so pending client reads see EOF
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
    std::istream in(clientRead_.get());
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
    std::istream in(clientRead_.get());
    FrameReaderStream reader(in);
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(timeoutMs);
    for (;;) {
      // Only block in read() when bytes are known to be pending, so a missing
      // notification fails the test instead of hanging it.
      if (in.rdbuf()->in_avail() <= 0) {
        const auto remaining = std::chrono::duration_cast<std::chrono::milliseconds>(
                                   deadline - std::chrono::steady_clock::now())
                                   .count();
        if (remaining <= 0) {
          ADD_FAILURE() << "timed out waiting for notification: " << method;
          return {};
        }
        pollfd pfd{outRead_, POLLIN, 0};
        if (poll(&pfd, 1, static_cast<int>(remaining)) <= 0) continue;
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

  void closeInput() {
    if (inWrite_ != -1) {
      close(inWrite_);
      inWrite_ = -1;
    }
  }

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
    const std::string framed =
        "Content-Length: " + std::to_string(payload.size()) + "\r\n\r\n" + payload;
    ASSERT_EQ(write(inWrite_, framed.data(), framed.size()),
              static_cast<ssize_t>(framed.size()));
  }

  int inWrite_ = -1;
  int outRead_ = -1;
  std::unique_ptr<__gnu_cxx::stdio_filebuf<char>> serverIn_;
  std::unique_ptr<__gnu_cxx::stdio_filebuf<char>> serverOut_;
  std::unique_ptr<__gnu_cxx::stdio_filebuf<char>> clientRead_;
  std::thread serverThread_;
};

inline Json initRequest(std::int64_t id = 1) {
  return {{"jsonrpc", "2.0"},
          {"id", id},
          {"method", "initialize"},
          {"params", {{"protocolVersion", "0.1.0"}}}};
}

}  // namespace gg::testing
