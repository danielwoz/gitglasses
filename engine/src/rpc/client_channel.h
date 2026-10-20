#pragma once

#include <nlohmann/json.hpp>

#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <functional>
#include <map>
#include <memory>
#include <mutex>
#include <optional>
#include <string>

namespace gg::rpc {

// Requests from the engine to the client: the other direction of JSON-RPC.
// Ids are strings ("e1", "e2", ...), so they never collide with the client's
// integer ids, and the dispatcher hands their responses back through
// handleResponse(). A caller blocks in call() until the answer arrives, the
// caller abandons the request, or the channel closes.
class ClientChannel {
 public:
  using Json = nlohmann::json;
  using SendFn = std::function<void(const Json& message)>;

  explicit ClientChannel(SendFn send) : send_(std::move(send)) {}

  // Sends `method` and waits for the client's result. Returns nullopt when
  // the client answered with an error, when `abandoned()` turned true (the
  // client is then told through `cancelNotification` {id}), or when the
  // channel closed.
  std::optional<Json> call(const std::string& method, Json params,
                           const std::function<bool()>& abandoned,
                           const std::string& cancelNotification) {
    auto slot = std::make_shared<Slot>();
    std::string id;
    {
      std::lock_guard lock(mutex_);
      if (closed_) return std::nullopt;
      id = "e" + std::to_string(++nextId_);
      pending_[id] = slot;
    }
    send_({{"jsonrpc", "2.0"}, {"id", id}, {"method", method}, {"params", std::move(params)}});

    std::unique_lock lock(mutex_);
    for (;;) {
      if (slot->done) {
        pending_.erase(id);
        return std::move(slot->result);
      }
      if (closed_) {
        pending_.erase(id);
        return std::nullopt;
      }
      lock.unlock();
      const bool gone = abandoned();
      lock.lock();
      if (gone && !slot->done) {
        pending_.erase(id);
        lock.unlock();
        send_({{"jsonrpc", "2.0"}, {"method", cancelNotification}, {"params", {{"id", id}}}});
        return std::nullopt;
      }
      cv_.wait_for(lock, std::chrono::milliseconds(50));
    }
  }

  // Delivers a response message; ones for no outstanding call are dropped.
  void handleResponse(const Json& message) {
    const auto idIt = message.find("id");
    if (idIt == message.end() || !idIt->is_string()) return;
    std::lock_guard lock(mutex_);
    const auto it = pending_.find(idIt->get<std::string>());
    if (it == pending_.end()) return;
    if (const auto result = message.find("result"); result != message.end()) {
      it->second->result = *result;
    }
    it->second->done = true;
    cv_.notify_all();
  }

  // Fails every waiting call and refuses new ones: the client is gone.
  void close() {
    std::lock_guard lock(mutex_);
    closed_ = true;
    cv_.notify_all();
  }

 private:
  struct Slot {
    bool done = false;
    std::optional<Json> result;
  };

  SendFn send_;
  std::mutex mutex_;
  std::condition_variable cv_;
  std::map<std::string, std::shared_ptr<Slot>> pending_;
  std::int64_t nextId_ = 0;
  bool closed_ = false;
};

}  // namespace gg::rpc
