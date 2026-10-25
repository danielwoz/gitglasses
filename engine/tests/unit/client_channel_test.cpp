// The dispatcher's other direction: requests the engine sends to the client
// and the responses that come back, error data, the request context handlers
// see, and cancelling everything when the client goes away.

#include "rpc/client_channel.h"

#include <gtest/gtest.h>

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <mutex>
#include <optional>
#include <thread>
#include <vector>

#include "rpc/dispatcher.h"
#include "util/request_context.h"

namespace gg::rpc {
namespace {

using namespace std::chrono_literals;

// Outbound messages, with a wait for one that matches.
class Outbox {
 public:
  void push(const Json& message) {
    {
      std::lock_guard lock(mutex_);
      messages_.push_back(message);
    }
    cv_.notify_all();
  }

  template <typename Pred>
  std::optional<Json> waitFor(Pred pred, std::chrono::milliseconds timeout = 5s) {
    std::unique_lock lock(mutex_);
    std::optional<Json> found;
    cv_.wait_for(lock, timeout, [&] {
      for (const auto& message : messages_) {
        if (pred(message)) {
          found = message;
          return true;
        }
      }
      return false;
    });
    return found;
  }

 private:
  std::mutex mutex_;
  std::condition_variable cv_;
  std::vector<Json> messages_;
};

struct ChannelTest : ::testing::Test {
  TaskPool pool{2};
  Outbox outbox;
  Dispatcher dispatcher{pool, [this](const Json& m) { outbox.push(m); }};
  ClientChannel channel{[this](const Json& m) { outbox.push(m); }};

  ChannelTest() {
    dispatcher.onResponse([this](const Json& m) { channel.handleResponse(m); });
  }
  ~ChannelTest() override {
    channel.close();
    pool.shutdown();
  }

  void send(const Json& message) { dispatcher.dispatch(message.dump()); }

  std::optional<Json> request(const std::string& method) {
    return outbox.waitFor([&](const Json& m) { return m.value("method", "") == method; });
  }
};

TEST_F(ChannelTest, ACallReturnsTheClientsResult) {
  std::optional<Json> result;
  std::thread caller([&] {
    result = channel.call(
        "ui/askpass", {{"prompt", "Password: "}}, [] { return false; }, "ui/askpassCancelled");
  });
  const auto sent = request("ui/askpass");
  ASSERT_TRUE(sent.has_value());
  ASSERT_TRUE((*sent)["id"].is_string());
  // The answer arrives as any inbound message does.
  send({{"jsonrpc", "2.0"}, {"id", (*sent)["id"]}, {"result", {{"value", "s3cret"}}}});
  caller.join();
  ASSERT_TRUE(result.has_value());
  EXPECT_EQ((*result)["value"], "s3cret");
}

TEST_F(ChannelTest, AnAbandonedCallIsWithdrawnFromTheClient) {
  std::atomic<bool> abandoned{false};
  std::optional<Json> result = Json("unset");
  std::thread caller([&] {
    result = channel.call(
        "ui/askpass", Json::object(), [&] { return abandoned.load(); }, "ui/askpassCancelled");
  });
  const auto sent = request("ui/askpass");
  ASSERT_TRUE(sent.has_value());
  abandoned = true;
  caller.join();
  EXPECT_FALSE(result.has_value());
  const auto withdrawn = request("ui/askpassCancelled");
  ASSERT_TRUE(withdrawn.has_value());
  EXPECT_EQ((*withdrawn)["params"]["id"], (*sent)["id"]);
  // A late answer is dropped quietly.
  send({{"jsonrpc", "2.0"}, {"id", (*sent)["id"]}, {"result", {{"value", "late"}}}});
}

TEST_F(ChannelTest, ClosingFailsWaitingCalls) {
  std::optional<Json> result = Json("unset");
  std::thread caller(
      [&] { result = channel.call("ui/askpass", Json::object(), [] { return false; }, "x"); });
  ASSERT_TRUE(request("ui/askpass").has_value());
  channel.close();
  caller.join();
  EXPECT_FALSE(result.has_value());
  EXPECT_FALSE(channel.call("ui/askpass", Json::object(), [] { return false; }, "x").has_value());
}

TEST_F(ChannelTest, ErrorsCarryTheirData) {
  dispatcher.method("explicit", [](const Json&, const CancelToken&, const NotifyFn&) -> Json {
    throw HandlerError{{ErrorCode::GitError, "push failed"}, {{"kind", "rejected"}}};
  });
  dispatcher.method("described", [](const Json&, const CancelToken&, const NotifyFn&) -> Json {
    throw HandlerError{{ErrorCode::GitError, "fetch failed: Authentication failed"}};
  });
  dispatcher.method("plain", [](const Json&, const CancelToken&, const NotifyFn&) -> Json {
    throw HandlerError{{ErrorCode::InvalidParams, "bad"}};
  });
  dispatcher.setErrorData([](const Error& error) -> Json {
    if (error.message.find("Authentication failed") == std::string::npos) return nullptr;
    return {{"kind", "auth"}};
  });

  for (const auto& [id, method] :
       std::vector<std::pair<int, std::string>>{{1, "explicit"}, {2, "described"}, {3, "plain"}}) {
    send({{"jsonrpc", "2.0"}, {"id", id}, {"method", method}});
  }
  const auto byId = [&](int id) {
    return outbox.waitFor([id](const Json& m) { return m.value("id", Json()) == id; });
  };
  EXPECT_EQ((*byId(1))["error"]["data"]["kind"], "rejected");
  EXPECT_EQ((*byId(2))["error"]["data"]["kind"], "auth");
  EXPECT_FALSE((*byId(3))["error"].contains("data"));
}

TEST_F(ChannelTest, HandlersSeeTheRequestTheyServe) {
  dispatcher.method("whoami", [](const Json&, const CancelToken&, const NotifyFn&) -> Json {
    const RequestContext& context = currentRequest();
    return {{"id", context.id}, {"method", context.method}, {"repoId", context.repoId}};
  });
  send({{"jsonrpc", "2.0"}, {"id", 9}, {"method", "whoami"}, {"params", {{"repoId", "r7"}}}});
  const auto response = outbox.waitFor([](const Json& m) { return m.value("id", Json()) == 9; });
  ASSERT_TRUE(response.has_value());
  EXPECT_EQ((*response)["result"]["id"], 9);
  EXPECT_EQ((*response)["result"]["method"], "whoami");
  EXPECT_EQ((*response)["result"]["repoId"], "r7");
  EXPECT_EQ(currentRequest().id, -1) << "the context leaked out of the handler";
}

TEST_F(ChannelTest, CancelAllStopsEveryRequestInFlight) {
#ifdef GG_SINGLE_THREADED
  GTEST_SKIP() << "inline task pool: requests complete before they can be cancelled";
#else
  std::atomic<int> running{0};
  dispatcher.method("wait", [&](const Json&, const CancelToken& token, const NotifyFn&) -> Json {
    ++running;
    for (int i = 0; i < 1000; ++i) {
      token.throwIfCancelled();
      std::this_thread::sleep_for(10ms);
    }
    return Json::object();
  });
  send({{"jsonrpc", "2.0"}, {"id", 1}, {"method", "wait"}});
  send({{"jsonrpc", "2.0"}, {"id", 2}, {"method", "wait"}});
  const auto giveUp = std::chrono::steady_clock::now() + 5s;
  while (running.load() < 2 && std::chrono::steady_clock::now() < giveUp) {
    std::this_thread::sleep_for(5ms);
  }
  EXPECT_FALSE(dispatcher.waitIdle(50ms));
  dispatcher.cancelAll();
  EXPECT_TRUE(dispatcher.waitIdle(5s));
  for (int id : {1, 2}) {
    const auto response =
        outbox.waitFor([id](const Json& m) { return m.value("id", Json()) == id; });
    ASSERT_TRUE(response.has_value());
    EXPECT_EQ((*response)["error"]["code"], static_cast<int>(ErrorCode::Cancelled));
  }
#endif
}

}  // namespace
}  // namespace gg::rpc
