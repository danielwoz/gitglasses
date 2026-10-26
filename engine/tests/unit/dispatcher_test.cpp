#include "rpc/dispatcher.h"

#include <gtest/gtest.h>

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <mutex>
#include <thread>
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

  template <typename Pred>
  size_t count(Pred pred) {
    std::lock_guard lock(mutex_);
    size_t n = 0;
    for (const auto& m : messages_) {
      if (pred(m)) ++n;
    }
    return n;
  }

  // Waits until `done` holds, checking whenever a message arrives and at
  // least every few milliseconds.
  template <typename Done>
  bool waitUntil(Done done) {
    const auto deadline = std::chrono::steady_clock::now() + 5s;
    while (!done()) {
      if (std::chrono::steady_clock::now() >= deadline) return false;
      std::unique_lock lock(mutex_);
      cv_.wait_for(lock, 5ms);
    }
    return true;
  }

  std::vector<Json> notifications(const std::string& method) {
    std::lock_guard lock(mutex_);
    std::vector<Json> matches;
    for (const auto& m : messages_) {
      if (m.value("method", "") == method) matches.push_back(m);
    }
    return matches;
  }

  // Responses carrying `id`, in the order they were sent.
  std::vector<Json> answers(std::int64_t id) {
    std::lock_guard lock(mutex_);
    std::vector<Json> matches;
    for (const auto& m : messages_) {
      if (m.contains("id") && m["id"] == id) matches.push_back(m);
    }
    return matches;
  }

 private:
  std::mutex mutex_;
  std::condition_variable cv_;
  std::vector<Json> messages_;
};

// A one-shot signal between a handler and the test, waited on with a bound so
// a broken dispatcher fails the test instead of hanging it.
class Gate {
 public:
  void open() {
    {
      std::lock_guard lock(mutex_);
      open_ = true;
    }
    cv_.notify_all();
  }

  bool wait() {
    std::unique_lock lock(mutex_);
    return cv_.wait_for(lock, 5s, [this] { return open_; });
  }

 private:
  std::mutex mutex_;
  std::condition_variable cv_;
  bool open_ = false;
};

// The result and error members of a response; null when absent, as in the
// null message MessageSink returns after timing out.
Json resultOf(const Json& response) {
  return response.contains("result") ? response["result"] : Json();
}
Json errorOf(const Json& response) {
  return response.contains("error") ? response["error"] : Json();
}

struct DispatcherTest : ::testing::Test {
  TaskPool pool{2};
  MessageSink sink;
  Dispatcher dispatcher{pool, [this](const Json& m) { sink.push(m); }};

  // Per the Dispatcher lifetime contract, drain handler tasks before the
  // dispatcher and sink members are destroyed.
  ~DispatcherTest() override { pool.shutdown(); }

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
#ifdef GG_SINGLE_THREADED
  GTEST_SKIP() << "inline task pool: requests complete before $/cancelRequest can land mid-flight";
#else
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
#endif
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

  dispatcher.method(
      "record",
      [&](const Json& params, const CancelToken&, const NotifyFn&) {
        // Stagger early tasks so misordered execution would surface reliably.
        std::this_thread::sleep_for(std::chrono::milliseconds(20 - params["n"].get<int>()));
        std::lock_guard lock(orderMutex);
        order.push_back(params["n"].get<int>());
        return Json::object();
      },
      Mode::Serial);

  // Same repoId: one strand, so submission order is the execution order.
  for (int n = 0; n < 10; ++n) {
    send({{"jsonrpc", "2.0"},
          {"id", 100 + n},
          {"method", "record"},
          {"params", {{"n", n}, {"repoId", "r1"}}}});
  }
  sink.waitForId(109);

  std::lock_guard lock(orderMutex);
  EXPECT_EQ(order, (std::vector<int>{0, 1, 2, 3, 4, 5, 6, 7, 8, 9}));
}

// A method registered without a mode must not inherit serialization: ordering
// is opted into, so forgetting the argument cannot cost availability.
TEST_F(DispatcherTest, DefaultModeIsConcurrent) {
#ifdef GG_SINGLE_THREADED
  GTEST_SKIP() << "inline task pool: concurrent handlers cannot overlap";
#else
  std::mutex m;
  std::condition_variable cv;
  int running = 0;
  int peak = 0;

  dispatcher.method("implicit", [&](const Json&, const CancelToken&, const NotifyFn&) {
    {
      std::lock_guard lock(m);
      peak = std::max(peak, ++running);
    }
    cv.notify_all();
    {
      std::unique_lock lock(m);
      cv.wait_for(lock, 2s, [&] { return peak >= 2; });
      --running;
    }
    return Json::object();
  });

  send({{"jsonrpc", "2.0"}, {"id", 1}, {"method", "implicit"}});
  send({{"jsonrpc", "2.0"}, {"id", 2}, {"method", "implicit"}});
  sink.waitForId(1);
  sink.waitForId(2);

  std::lock_guard lock(m);
  EXPECT_EQ(peak, 2) << "handlers registered without a mode were serialized";
#endif
}

// Serial ordering is per repository: a slow mutation on one repo must not
// delay a mutation on another.
TEST_F(DispatcherTest, SerialStrandsAreKeyedByRepo) {
#ifdef GG_SINGLE_THREADED
  GTEST_SKIP() << "inline task pool: posts run to completion on the caller";
#else
  std::mutex m;
  std::condition_variable cv;
  bool slowStarted = false;
  bool fastDone = false;

  dispatcher.method(
      "slow",
      [&](const Json&, const CancelToken&, const NotifyFn&) {
        {
          std::lock_guard lock(m);
          slowStarted = true;
        }
        cv.notify_all();
        std::unique_lock lock(m);
        cv.wait_for(lock, 5s, [&] { return fastDone; });
        return Json::object();
      },
      Mode::Serial);

  dispatcher.method(
      "fast",
      [&](const Json&, const CancelToken&, const NotifyFn&) {
        {
          std::lock_guard lock(m);
          fastDone = true;
        }
        cv.notify_all();
        return Json::object();
      },
      Mode::Serial);

  send({{"jsonrpc", "2.0"}, {"id", 1}, {"method", "slow"}, {"params", {{"repoId", "r1"}}}});
  {
    std::unique_lock lock(m);
    ASSERT_TRUE(cv.wait_for(lock, 5s, [&] { return slowStarted; }));
  }
  send({{"jsonrpc", "2.0"}, {"id", 2}, {"method", "fast"}, {"params", {{"repoId", "r2"}}}});

  // r2 answers while r1 is still held; r1 only completes once it has.
  EXPECT_TRUE(sink.waitForId(2).contains("result"));
  EXPECT_TRUE(sink.waitForId(1).contains("result"));
#endif
}

// Network-lane methods take a second per-repo strand, so a long fetch does
// not delay index mutations on the same repository.
TEST_F(DispatcherTest, NetworkLaneIsIndependentOfIndexLane) {
#ifdef GG_SINGLE_THREADED
  GTEST_SKIP() << "inline task pool: posts run to completion on the caller";
#else
  std::mutex m;
  std::condition_variable cv;
  bool fetchStarted = false;
  bool stageDone = false;

  dispatcher.method(
      "fetchish",
      [&](const Json&, const CancelToken&, const NotifyFn&) {
        {
          std::lock_guard lock(m);
          fetchStarted = true;
        }
        cv.notify_all();
        std::unique_lock lock(m);
        cv.wait_for(lock, 5s, [&] { return stageDone; });
        return Json::object();
      },
      Mode::SerialNetwork);

  dispatcher.method(
      "stageish",
      [&](const Json&, const CancelToken&, const NotifyFn&) {
        {
          std::lock_guard lock(m);
          stageDone = true;
        }
        cv.notify_all();
        return Json::object();
      },
      Mode::Serial);

  send({{"jsonrpc", "2.0"}, {"id", 1}, {"method", "fetchish"}, {"params", {{"repoId", "r1"}}}});
  {
    std::unique_lock lock(m);
    ASSERT_TRUE(cv.wait_for(lock, 5s, [&] { return fetchStarted; }));
  }
  send({{"jsonrpc", "2.0"}, {"id", 2}, {"method", "stageish"}, {"params", {{"repoId", "r1"}}}});

  EXPECT_TRUE(sink.waitForId(2).contains("result"));
  EXPECT_TRUE(sink.waitForId(1).contains("result"));
#endif
}

// Queued notifications leave the read loop free but keep their order.
TEST_F(DispatcherTest, QueuedNotificationsRunOffTheReadLoopInOrder) {
  std::mutex m;
  std::condition_variable cv;
  std::vector<int> seen;

  dispatcher.notification(
      "note",
      [&](Json params) {
        std::lock_guard lock(m);
        seen.push_back(params["n"].get<int>());
        cv.notify_all();
      },
      NotificationMode::Queued);

  for (int n = 0; n < 5; ++n) {
    send({{"jsonrpc", "2.0"}, {"method", "note"}, {"params", {{"n", n}}}});
  }

  std::unique_lock lock(m);
  ASSERT_TRUE(cv.wait_for(lock, 5s, [&] { return seen.size() == 5; }));
  EXPECT_EQ(seen, (std::vector<int>{0, 1, 2, 3, 4}));
}

// A payload over the inline-parse limit is parsed on a worker, so the small
// message behind it is answered without waiting for it.
TEST_F(DispatcherTest, LargePayloadDoesNotDelayTheNextMessage) {
#ifdef GG_SINGLE_THREADED
  GTEST_SKIP() << "inline task pool: everything runs on the caller";
#else
  std::mutex m;
  std::condition_variable cv;
  bool release = false;

  dispatcher.notification(
      "bulk",
      [&](Json) {
        std::unique_lock lock(m);
        cv.wait_for(lock, 5s, [&] { return release; });
      },
      NotificationMode::Queued);
  dispatcher.method(
      "ping", [](const Json&, const CancelToken&, const NotifyFn&) { return Json::object(); });

  send({{"jsonrpc", "2.0"},
        {"method", "bulk"},
        {"params", {{"blob", std::string(kInlineParseLimit + 1024, 'x')}}}});
  send({{"jsonrpc", "2.0"}, {"id", 1}, {"method", "ping"}});

  // The bulk handler is still blocked; ping must answer anyway.
  EXPECT_TRUE(sink.waitForId(1).contains("result"));
  {
    std::lock_guard lock(m);
    release = true;
  }
  cv.notify_all();
  // The released handler still has to reacquire `m` on its way out, so the
  // pool is drained here rather than in the fixture destructor: `m`, `cv` and
  // `release` are locals of this frame and must outlive the last use of them.
  pool.shutdown();
#endif
}

// A cancel that overtakes a deferred request still applies to it.
TEST_F(DispatcherTest, CancelBeforeDeferredRequestIsParsedStillApplies) {
#ifdef GG_SINGLE_THREADED
  GTEST_SKIP() << "inline task pool: the request finishes before the cancel is sent";
#else
  dispatcher.method(
      "slowread",
      [](const Json&, const CancelToken& token, const NotifyFn&) {
        for (int i = 0; i < 500; ++i) {
          token.throwIfCancelled();
          std::this_thread::sleep_for(1ms);
        }
        return Json::object();
      },
      Mode::Concurrent);

  Json big = {{"jsonrpc", "2.0"},
              {"id", 1},
              {"method", "slowread"},
              {"params", {{"blob", std::string(kInlineParseLimit + 1024, 'x')}}}};
  send(big);
  send({{"jsonrpc", "2.0"}, {"method", "$/cancelRequest"}, {"params", {{"id", 1}}}});

  Json response = sink.waitForId(1);
  ASSERT_TRUE(response.contains("error")) << response.dump();
  EXPECT_EQ(response["error"]["code"], static_cast<int>(ErrorCode::Cancelled));
#endif
}

TEST_F(DispatcherTest, ConcurrentMethodsOverlap) {
#ifdef GG_SINGLE_THREADED
  GTEST_SKIP() << "inline task pool: concurrent handlers cannot overlap";
#else
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
#endif
}

// A request that reads what notifications write starts only after the
// notifications sent ahead of it have run.
TEST_F(DispatcherTest, AfterNotificationsRequestSeesEarlierNotifications) {
  std::mutex m;
  int stored = 0;
  dispatcher.notification(
      "store",
      [&](Json params) {
        // Slow enough that a request racing it on another worker would win.
        std::this_thread::sleep_for(2ms);
        std::lock_guard lock(m);
        stored = params["n"].get<int>();
      },
      NotificationMode::Queued);
  dispatcher.method(
      "load",
      [&](const Json&, const CancelToken&, const NotifyFn&) {
        std::lock_guard lock(m);
        return Json{{"n", stored}};
      },
      Mode::AfterNotifications);

  for (int n = 1; n <= 20; ++n) {
    send({{"jsonrpc", "2.0"}, {"method", "store"}, {"params", {{"n", n}}}});
    send({{"jsonrpc", "2.0"}, {"id", n}, {"method", "load"}});
    EXPECT_EQ(sink.waitForId(n)["result"]["n"], n) << "request " << n;
  }
  // The handlers use this frame's locals.
  pool.shutdown();
}

// A small payload sent behind one big enough to be parsed off the read loop
// is routed after it, not ahead of it.
TEST_F(DispatcherTest, PayloadsBehindADeferredParseKeepArrivalOrder) {
  std::mutex m;
  int stored = 0;
  dispatcher.notification(
      "store",
      [&](Json params) {
        // Slow enough that a request routed ahead of it would win.
        std::this_thread::sleep_for(2ms);
        std::lock_guard lock(m);
        stored = params["n"].get<int>();
      },
      NotificationMode::Queued);
  dispatcher.method(
      "load",
      [&](const Json&, const CancelToken&, const NotifyFn&) {
        std::lock_guard lock(m);
        return Json{{"n", stored}};
      },
      Mode::AfterNotifications);

  const std::string blob(kInlineParseLimit + 1024, 'x');
  for (int n = 1; n <= 5; ++n) {
    send({{"jsonrpc", "2.0"}, {"method", "store"}, {"params", {{"n", n}, {"blob", blob}}}});
    send({{"jsonrpc", "2.0"}, {"id", n}, {"method", "load"}});
    EXPECT_EQ(sink.waitForId(n)["result"]["n"], n) << "request " << n;
  }
  // The handlers use this frame's locals.
  pool.shutdown();
}

// Once a deferred parse has finished, a payload sent while one queued behind
// that parse is still waiting to be routed is routed after it, not ahead.
TEST_F(DispatcherTest, PayloadsBehindAFinishedDeferredParseKeepArrivalOrder) {
#ifdef GG_SINGLE_THREADED
  GTEST_SKIP() << "inline task pool: every payload is routed as it arrives";
#else
  Gate held;
  Gate release;
  Gate responseHeld;
  Gate responseRelease;
  std::mutex m;
  std::vector<int> order;
  // Holds the strand so everything below is queued before any of it runs.
  dispatcher.notification(
      "hold",
      [&](Json) {
        held.open();
        release.wait();
      },
      NotificationMode::Queued);
  // A response is routed on the strand when queued, so holding its handler
  // stops routing after the deferred parse has released its budget.
  dispatcher.onResponse([&](const Json&) {
    responseHeld.open();
    responseRelease.wait();
  });
  dispatcher.notification(
      "mark",
      [&](Json params) {
        std::lock_guard lock(m);
        order.push_back(params["n"].get<int>());
      },
      NotificationMode::Queued);

  send({{"jsonrpc", "2.0"}, {"method", "hold"}});
  EXPECT_TRUE(held.wait());
  send({{"jsonrpc", "2.0"},
        {"method", "mark"},
        {"params", {{"n", 1}, {"blob", std::string(kInlineParseLimit + 1024, 'x')}}}});
  send({{"jsonrpc", "2.0"}, {"id", 1}, {"result", Json::object()}});
  send({{"jsonrpc", "2.0"}, {"method", "mark"}, {"params", {{"n", 2}}}});
  release.open();
  EXPECT_TRUE(responseHeld.wait());
  // The deferred parse is done and mark 2 is still waiting to be routed.
  send({{"jsonrpc", "2.0"}, {"method", "mark"}, {"params", {{"n", 3}}}});
  responseRelease.open();

  EXPECT_TRUE(sink.waitUntil([&] {
    std::lock_guard lock(m);
    return order.size() == 3;
  }));
  // The handlers use this frame's locals.
  pool.shutdown();
  EXPECT_EQ(order, (std::vector<int>{1, 2, 3}));
#endif
}

// A cancel is not held behind a deferred parse; it still reaches the request
// queued behind that parse.
TEST_F(DispatcherTest, CancelReachesARequestQueuedBehindADeferredParse) {
#ifdef GG_SINGLE_THREADED
  GTEST_SKIP() << "inline task pool: the request finishes before the cancel is sent";
#else
  dispatcher.notification("bulk", [](Json) {}, NotificationMode::Queued);
  dispatcher.method(
      "slowread",
      [](const Json&, const CancelToken& token, const NotifyFn&) {
        for (int i = 0; i < 500; ++i) {
          token.throwIfCancelled();
          std::this_thread::sleep_for(1ms);
        }
        return Json::object();
      },
      Mode::Concurrent);

  send({{"jsonrpc", "2.0"},
        {"method", "bulk"},
        {"params", {{"blob", std::string(kInlineParseLimit + 1024, 'x')}}}});
  send({{"jsonrpc", "2.0"}, {"id", 1}, {"method", "slowread"}});
  send({{"jsonrpc", "2.0"}, {"method", "$/cancelRequest"}, {"params", {{"id", 1}}}});

  Json response = sink.waitForId(1);
  ASSERT_TRUE(response.contains("error")) << response.dump();
  EXPECT_EQ(response["error"]["code"], static_cast<int>(ErrorCode::Cancelled));
#endif
}

// A client may reuse an id once it holds the response; the second request
// is answered too, however quickly it follows the first answer.
TEST_F(DispatcherTest, IdReusedAfterTheResponseIsAnsweredAgain) {
  // A writer that is still busy after the client has the bytes, which is
  // when the client's next request can arrive.
  MessageSink slowSink;
  Dispatcher slow{pool, [&slowSink](const Json& m) {
                    slowSink.push(m);
                    std::this_thread::sleep_for(5ms);
                  }};
  slow.method("noop",
              [](const Json&, const CancelToken&, const NotifyFn&) { return Json::object(); });
  const auto answers = [&slowSink] {
    return slowSink.count([](const Json& m) { return m.contains("id") && m["id"] == 9; });
  };
  for (size_t round = 1; round <= 5; ++round) {
    slow.dispatch(Json({{"jsonrpc", "2.0"}, {"id", 9}, {"method", "noop"}}).dump());
    ASSERT_TRUE(slowSink.waitUntil([&] { return answers() >= round; })) << "round " << round;
  }
  pool.shutdown();
}

// On a Serial lane the request reusing an id the moment its answer is sent
// queues on the strand still running the first one, and is answered too.
TEST_F(DispatcherTest, IdReusedFromTheSendPathOnASerialStrandIsAnswered) {
  MessageSink serialSink;
  Dispatcher* serialDispatcher = nullptr;
  std::atomic<bool> reused{false};
  const auto request = [](int n) {
    return Json({{"jsonrpc", "2.0"},
                 {"id", 5},
                 {"method", "mutate"},
                 {"params", {{"repoId", "r1"}, {"n", n}}}})
        .dump();
  };
  // The client sends its next request with the id before the first answer
  // has left the send path.
  Dispatcher serial{pool, [&](const Json& m) {
                      serialSink.push(m);
                      if (m.contains("id") && m["id"] == 5 && !reused.exchange(true)) {
                        serialDispatcher->dispatch(request(2));
                      }
                    }};
  serialDispatcher = &serial;
  serial.method(
      "mutate",
      [](const Json& params, const CancelToken&, const NotifyFn&) {
        return Json{{"n", params["n"]}};
      },
      Mode::Serial);

  serial.dispatch(request(1));
  EXPECT_TRUE(serialSink.waitUntil([&] { return serialSink.answers(5).size() >= 2; }));
  pool.shutdown();

  const std::vector<Json> answers = serialSink.answers(5);
  ASSERT_EQ(answers.size(), 2u);
  EXPECT_EQ(resultOf(answers[0]), (Json{{"n", 1}})) << answers[0].dump();
  EXPECT_EQ(resultOf(answers[1]), (Json{{"n", 2}})) << answers[1].dump();
}

// A request reusing the id of one still in flight is refused at once, on
// every lane, while the request holding the id runs on and answers once.
TEST_F(DispatcherTest, RequestReusingAnInFlightIdIsRefused) {
#ifdef GG_SINGLE_THREADED
  GTEST_SKIP() << "inline task pool: a request is answered before the next one is sent";
#else
  struct Lane {
    const char* method;
    Mode mode;
    std::int64_t id;
    Gate started;
    Gate release;
    std::atomic<int> calls{0};
  };
  // Outlives the pool's tasks, which the handlers below reach into.
  Lane lanes[] = {{"concurrentHold", Mode::Concurrent, 3}, {"serialHold", Mode::Serial, 4}};

  for (Lane& lane : lanes) {
    dispatcher.method(
        lane.method,
        [&lane](const Json& params, const CancelToken&, const NotifyFn&) {
          if (lane.calls++ == 0) {
            lane.started.open();
            lane.release.wait();
          }
          return Json{{"from", params["from"]}};
        },
        lane.mode);
    const auto request = [&lane](const char* from) {
      return Json{{"jsonrpc", "2.0"},
                  {"id", lane.id},
                  {"method", lane.method},
                  {"params", {{"repoId", "r1"}, {"from", from}}}};
    };

    send(request("first"));
    EXPECT_TRUE(lane.started.wait()) << lane.method;
    send(request("second"));

    // The refusal comes while the first request is still held.
    const Json refusal =
        sink.waitFor([&lane](const Json& m) { return m.contains("id") && m["id"] == lane.id; });
    EXPECT_EQ(errorOf(refusal),
              (Json{{"code", static_cast<int>(ErrorCode::InvalidRequest)},
                    {"message", "request id " + std::to_string(lane.id) + " is already in use"}}))
        << refusal.dump();

    lane.release.open();
    EXPECT_TRUE(sink.waitUntil([&] { return sink.answers(lane.id).size() >= 2; }));
  }

  // Drains every task, so no further answer can still be on its way.
  pool.shutdown();
  for (Lane& lane : lanes) {
    const std::vector<Json> answers = sink.answers(lane.id);
    ASSERT_EQ(answers.size(), 2u) << lane.method;
    EXPECT_EQ(resultOf(answers[1]), (Json{{"from", "first"}})) << answers[1].dump();
    EXPECT_EQ(lane.calls.load(), 1) << lane.method;
  }
#endif
}

// A cancel that crosses the answer to its request is dropped: a later request
// reusing the id runs to completion.
TEST_F(DispatcherTest, CancelForAnAnsweredIdSparesTheNextRequestWithIt) {
  dispatcher.method(
      "noop", [](const Json&, const CancelToken&, const NotifyFn&) { return Json::object(); });

  send({{"jsonrpc", "2.0"}, {"id", 7}, {"method", "noop"}});
  EXPECT_TRUE(sink.waitForId(7).contains("result"));
  send({{"jsonrpc", "2.0"}, {"method", "$/cancelRequest"}, {"params", {{"id", 7}}}});
  send({{"jsonrpc", "2.0"}, {"id", 7}, {"method", "noop"}});
  EXPECT_TRUE(sink.waitUntil([&] { return sink.answers(7).size() >= 2; }));

  for (const Json& answer : sink.answers(7)) {
    EXPECT_EQ(errorOf(answer), nullptr) << answer.dump();
  }
}

// While payloads wait to be routed, a cancel for an id not in flight is kept
// for a request queued ahead of it, but not for one with the id queued after
// it, whether the cancel is handled on arrival or parsed off the read loop.
TEST_F(DispatcherTest, CancelForAnAnsweredIdSparesARequestQueuedAfterIt) {
#ifdef GG_SINGLE_THREADED
  GTEST_SKIP() << "inline task pool: every payload is routed as it arrives";
#else
  Gate held;
  Gate release;
  // Holds the strand that deferred parses and the payloads behind them run
  // on, so everything sent meanwhile waits to be routed.
  dispatcher.notification(
      "hold",
      [&](Json) {
        held.open();
        release.wait();
      },
      NotificationMode::Queued);
  dispatcher.notification("bulk", [](Json) {}, NotificationMode::Queued);
  dispatcher.method(
      "noop", [](const Json&, const CancelToken&, const NotifyFn&) { return Json::object(); });
  const std::string blob(kInlineParseLimit + 1024, 'x');

  for (const int id : {7, 8}) {
    send({{"jsonrpc", "2.0"}, {"id", id}, {"method", "noop"}});
    EXPECT_TRUE(sink.waitForId(id).contains("result"));
  }
  send({{"jsonrpc", "2.0"}, {"method", "hold"}});
  EXPECT_TRUE(held.wait());
  send({{"jsonrpc", "2.0"}, {"method", "bulk"}, {"params", {{"blob", blob}}}});
  // Handled on arrival, ahead of the second request with id 7.
  send({{"jsonrpc", "2.0"}, {"method", "$/cancelRequest"}, {"params", {{"id", 7}}}});
  // Large enough to be parsed off the read loop, behind the bulk payload.
  send({{"jsonrpc", "2.0"}, {"method", "$/cancelRequest"}, {"params", {{"id", 8}, {"pad", blob}}}});
  send({{"jsonrpc", "2.0"}, {"id", 7}, {"method", "noop"}});
  send({{"jsonrpc", "2.0"}, {"id", 8}, {"method", "noop"}});
  release.open();

  for (const int id : {7, 8}) {
    EXPECT_TRUE(sink.waitUntil([&] { return sink.answers(id).size() >= 2; })) << "id " << id;
    for (const Json& answer : sink.answers(id)) {
      EXPECT_EQ(errorOf(answer), nullptr) << answer.dump();
    }
  }
  // The hold handler uses this frame's locals.
  pool.shutdown();
#endif
}

// A cancel for a request still waiting to be routed, whether its own parse is
// deferred or it is queued behind one, applies once the request is routed.
TEST_F(DispatcherTest, CancelForAQueuedRequestAppliesOnceItIsRouted) {
#ifdef GG_SINGLE_THREADED
  GTEST_SKIP() << "inline task pool: a request is routed before its cancel is sent";
#else
  Gate held;
  Gate release;
  dispatcher.notification(
      "hold",
      [&](Json) {
        held.open();
        release.wait();
      },
      NotificationMode::Queued);
  dispatcher.method("read", [](const Json&, const CancelToken& token, const NotifyFn&) {
    return Json{{"cancelled", token.cancelled()}};
  });

  send({{"jsonrpc", "2.0"}, {"method", "hold"}});
  EXPECT_TRUE(held.wait());
  send({{"jsonrpc", "2.0"},
        {"id", 1},
        {"method", "read"},
        {"params", {{"blob", std::string(kInlineParseLimit + 1024, 'x')}}}});
  send({{"jsonrpc", "2.0"}, {"id", 2}, {"method", "read"}});
  send({{"jsonrpc", "2.0"}, {"id", 3}, {"method", "read"}});
  send({{"jsonrpc", "2.0"}, {"method", "$/cancelRequest"}, {"params", {{"id", 1}}}});
  send({{"jsonrpc", "2.0"}, {"method", "$/cancelRequest"}, {"params", {{"id", 2}}}});
  release.open();

  for (const int id : {1, 2}) {
    const Json response = sink.waitForId(id);
    EXPECT_EQ(errorOf(response), (Json{{"code", static_cast<int>(ErrorCode::Cancelled)},
                                       {"message", "request cancelled"}}))
        << response.dump();
  }
  EXPECT_EQ(resultOf(sink.waitForId(3)), (Json{{"cancelled", false}}));
  // The hold handler uses this frame's locals.
  pool.shutdown();
#endif
}

// A payload still waiting to be routed counts as work outstanding, though its
// request is not yet in flight.
TEST_F(DispatcherTest, WaitIdleCountsPayloadsWaitingToBeRouted) {
#ifdef GG_SINGLE_THREADED
  GTEST_SKIP() << "inline task pool: every payload is routed as it arrives";
#else
  Gate held;
  Gate release;
  dispatcher.notification(
      "hold",
      [&](Json) {
        held.open();
        release.wait();
      },
      NotificationMode::Queued);
  dispatcher.method(
      "noop", [](const Json&, const CancelToken&, const NotifyFn&) { return Json::object(); });

  send({{"jsonrpc", "2.0"}, {"method", "hold"}});
  EXPECT_TRUE(held.wait());
  send({{"jsonrpc", "2.0"},
        {"id", 1},
        {"method", "noop"},
        {"params", {{"blob", std::string(kInlineParseLimit + 1024, 'x')}}}});
  send({{"jsonrpc", "2.0"}, {"id", 2}, {"method", "noop"}});
  EXPECT_EQ(dispatcher.inflight(), 0u);
  EXPECT_FALSE(dispatcher.waitIdle(0ms));

  release.open();
  EXPECT_TRUE(dispatcher.waitIdle(5s));
  EXPECT_TRUE(sink.waitForId(1).contains("result"));
  EXPECT_TRUE(sink.waitForId(2).contains("result"));
  // The hold handler uses this frame's locals.
  pool.shutdown();
#endif
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
