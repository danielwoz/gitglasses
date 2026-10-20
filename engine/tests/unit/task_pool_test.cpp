// The worker pool under tasks that block for a long time, as a fetch over a
// slow link or a blame of a huge file does: quick work must not queue behind
// them.

#include "util/task_pool.h"

#include <gtest/gtest.h>

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <future>
#include <mutex>

namespace gg {
namespace {

using namespace std::chrono_literals;

#ifndef GG_SINGLE_THREADED

// A latch the blocked tasks wait on until the test releases them.
struct Gate {
  std::mutex mutex;
  std::condition_variable cv;
  bool open = false;
  void wait() {
    std::unique_lock lock(mutex);
    cv.wait(lock, [this] { return open; });
  }
  void release() {
    {
      std::lock_guard lock(mutex);
      open = true;
    }
    cv.notify_all();
  }
};

TEST(TaskPool, QuickTasksRunWhileEveryWorkerIsBlocked) {
  TaskPool pool(2);
  Gate gate;
  std::atomic<int> started{0};
  for (int i = 0; i < 6; ++i) {
    pool.post(Priority::Interactive, [&] {
      ++started;
      gate.wait();
    });
  }

  std::promise<void> ran;
  const auto posted = std::chrono::steady_clock::now();
  pool.post(Priority::Interactive, [&ran] { ran.set_value(); });
  const bool finished = ran.get_future().wait_for(10s) == std::future_status::ready;
  const auto waited = std::chrono::steady_clock::now() - posted;
  gate.release();
  ASSERT_TRUE(finished) << "the quick task never ran while the workers were blocked";
  EXPECT_LT(std::chrono::duration_cast<std::chrono::milliseconds>(waited).count(), 5000);
  EXPECT_GT(pool.threadCount(), 2u);
  pool.shutdown();
  EXPECT_EQ(started.load(), 6);
}

TEST(TaskPool, GrowsNoFurtherThanItsCeiling) {
  TaskPool pool(1, 3);
  Gate gate;
  std::atomic<int> started{0};
  for (int i = 0; i < 8; ++i) {
    pool.post(Priority::Background, [&] {
      ++started;
      gate.wait();
    });
  }
  const auto giveUp = std::chrono::steady_clock::now() + 5s;
  while (started.load() < 3 && std::chrono::steady_clock::now() < giveUp) {
    std::this_thread::sleep_for(10ms);
  }
  // Long enough for several more starvation checks.
  std::this_thread::sleep_for(TaskPool::kStarvationDelay * 5);
  EXPECT_EQ(started.load(), 3);
  EXPECT_EQ(pool.threadCount(), 3u);
  gate.release();
  pool.shutdown();
  EXPECT_EQ(started.load(), 8) << "queued work must still run before shutdown returns";
}

TEST(TaskPool, QuickWorkNeedsNoExtraWorkers) {
  TaskPool pool(2);
  std::atomic<int> done{0};
  for (int i = 0; i < 200; ++i) pool.post(Priority::Interactive, [&done] { ++done; });
  pool.shutdown();
  EXPECT_EQ(done.load(), 200);
}

#endif  // !GG_SINGLE_THREADED

}  // namespace
}  // namespace gg
