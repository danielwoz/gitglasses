#include "rpc/dispatcher.h"

#include <gtest/gtest.h>

#include <chrono>
#include <condition_variable>
#include <mutex>
#include <vector>

namespace gg::rpc {
namespace {

using namespace std::chrono_literals;

// Collects outbound messages and lets tests block until one matching a
// predicate arrives.
class MessageSink {
 public:
  void push(const Json& message) {
    {
      std::lock_guard lock(mutex_);
      messages_.push_back(message);
    }
    cv_.notify_all();
  }

  template <typename Pred>
  Json waitFor(Pred pred) {
    std::unique_lock lock(mutex_);
    Json found;
    bool ok = cv_.wait_for(lock, 5s, [&] {
      for (const auto& m : messages_) {
        if (pred(m)) {
          found = m;
          return true;
        }
      }
      return false;
    });
    EXPECT_TRUE(ok) << "timed out waiting for matching message";
    return found;
  }

  Json waitForId(std::int64_t id) {
    return waitFor([id](const Json& m) { return m.contains("id") && m["id"] == id; });
  }

  std::vector<Json> notifications(const std::string& method) {
    std::lock_guard lock(mutex_);
    std::vector<Json> matches;
    for (const auto& m : messages_) {
      if (m.value("method", "") == method) matches.push_back(m);
    }
    return matches;
  }

 private:
  std::mutex mutex_;
  std::condition_variable cv_;
  std::vector<Json> messages_;
};

struct DispatcherTest : ::testing::Test {
  TaskPool pool{2};
  MessageSink sink;
  Dispatcher dispatcher{pool, [this](const Json& m) { sink.push(m); }};

  void send(const Json& message) { dispatcher.dispatch(message.dump()); }
};

TEST_F(DispatcherTest, RoutesRequestAndReturnsResult) {
  dispatcher.method("echo", [](const Json& params, const CancelToken&, const NotifyFn&) {
    return params;
  });

  send({{"jsonrpc", "2.0"}, {"id", 1}, {"method", "echo"}, {"params", {{"x", 42}}}});
  Json response = sink.waitForId(1);
  EXPECT_EQ(response["result"]["x"], 42);
}

TEST_F(DispatcherTest, UnknownMethodReturnsMethodNotFound) {
  send({{"jsonrpc", "2.0"}, {"id", 2}, {"method", "nope"}});
  Json response = sink.waitForId(2);
  EXPECT_EQ(response["error"]["code"], -32601);
}

TEST_F(DispatcherTest, MalformedJsonReturnsInvalidRequest) {
  dispatcher.dispatch("{not json");
  Json response = sink.waitFor([](const Json& m) {
    return m.contains("error") && m.value("id", Json()) == nullptr;
  });
  EXPECT_EQ(response["error"]["code"], -32600);
}

TEST_F(DispatcherTest, HandlerErrorsMapToJsonRpcErrors) {
  dispatcher.method("fail", [](const Json&, const CancelToken&, const NotifyFn&) -> Json {
    throw HandlerError{{ErrorCode::RepoNotFound, "no such repo"}};
  });

  send({{"jsonrpc", "2.0"}, {"id", 3}, {"method", "fail"}});
  Json response = sink.waitForId(3);
  EXPECT_EQ(response["error"]["code"], -32000);
  EXPECT_EQ(response["error"]["message"], "no such repo");
}

TEST_F(DispatcherTest, CancelRequestFlipsTokenAndAnswersCancelled) {
  std::mutex startedMutex;
  std::condition_variable startedCv;
  bool started = false;

  dispatcher.method("slow", [&](const Json&, const CancelToken& token, const NotifyFn&) -> Json {
    {
      std::lock_guard lock(startedMutex);
      started = true;
    }
    startedCv.notify_all();
    // Cooperative loop: exits promptly once $/cancelRequest lands.
    for (int i = 0; i < 500; ++i) {
      token.throwIfCancelled();
      std::this_thread::sleep_for(10ms);
    }
    return Json::object();
  });

  send({{"jsonrpc", "2.0"}, {"id", 4}, {"method", "slow"}});
  {
    std::unique_lock lock(startedMutex);
    ASSERT_TRUE(startedCv.wait_for(lock, 5s, [&] { return started; }));
  }
  send({{"jsonrpc", "2.0"}, {"method", "$/cancelRequest"}, {"params", {{"id", 4}}}});

  Json response = sink.waitForId(4);
  EXPECT_EQ(response["error"]["code"], -32800);
}

TEST_F(DispatcherTest, StreamingHandlerEmitsNotificationsBeforeResult) {
  dispatcher.method("stream", [](const Json&, const CancelToken&, const NotifyFn& notify) {
    for (int i = 0; i < 3; ++i) notify("test/chunk", {{"seq", i}});
    return Json{{"total", 3}};
  });

  send({{"jsonrpc", "2.0"}, {"id", 5}, {"method", "stream"}});
  Json response = sink.waitForId(5);
  EXPECT_EQ(response["result"]["total"], 3);
  EXPECT_EQ(sink.notifications("test/chunk").size(), 3u);
}

TEST_F(DispatcherTest, SerialMethodsRunInSubmissionOrder) {
  std::mutex orderMutex;
  std::vector<int> order;

  dispatcher.method("record", [&](const Json& params, const CancelToken&, const NotifyFn&) {
    // Stagger early tasks so misordered execution would surface reliably.
    std::this_thread::sleep_for(std::chrono::milliseconds(20 - params["n"].get<int>()));
    std::lock_guard lock(orderMutex);
    order.push_back(params["n"].get<int>());
    return Json::object();
  });

  for (int n = 0; n < 10; ++n) {
    send({{"jsonrpc", "2.0"}, {"id", 100 + n}, {"method", "record"}, {"params", {{"n", n}}}});
  }
  sink.waitForId(109);

  std::lock_guard lock(orderMutex);
  EXPECT_EQ(order, (std::vector<int>{0, 1, 2, 3, 4, 5, 6, 7, 8, 9}));
}

TEST_F(DispatcherTest, ConcurrentMethodsOverlap) {
  std::mutex m;
  std::condition_variable cv;
  int running = 0;
  int peak = 0;

  dispatcher.method(
      "parallel",
      [&](const Json&, const CancelToken&, const NotifyFn&) {
        {
          std::lock_guard lock(m);
          peak = std::max(peak, ++running);
        }
        cv.notify_all();
        {
          // Hold until both handlers are in flight, proving overlap.
          std::unique_lock lock(m);
          cv.wait_for(lock, 2s, [&] { return peak >= 2; });
          --running;
        }
        return Json::object();
      },
      Mode::Concurrent);

  send({{"jsonrpc", "2.0"}, {"id", 200}, {"method", "parallel"}});
  send({{"jsonrpc", "2.0"}, {"id", 201}, {"method", "parallel"}});
  sink.waitForId(200);
  sink.waitForId(201);

  std::lock_guard lock(m);
  EXPECT_GE(peak, 2);
}

TEST_F(DispatcherTest, InflightDrainsAfterCompletion) {
  dispatcher.method("noop", [](const Json&, const CancelToken&, const NotifyFn&) {
    return Json::object();
  });
  send({{"jsonrpc", "2.0"}, {"id", 6}, {"method", "noop"}});
  sink.waitForId(6);

  // The inflight entry is erased after the response is sent.
  for (int i = 0; i < 100 && dispatcher.inflight() != 0; ++i) {
    std::this_thread::sleep_for(10ms);
  }
  EXPECT_EQ(dispatcher.inflight(), 0u);
}

}  // namespace
}  // namespace gg::rpc
