#include <spdlog/spdlog.h>
#include "util/task_pool.h"

#include <algorithm>

namespace gg {

unsigned TaskPool::defaultThreadCount() {
#ifdef GG_SINGLE_THREADED
  return 1;
#else
  unsigned hw = std::thread::hardware_concurrency();
  return std::clamp(hw, 2u, 8u);
#endif
}

#ifdef GG_SINGLE_THREADED

TaskPool::TaskPool(unsigned threads) { (void)threads; }

TaskPool::~TaskPool() { shutdown(); }

void TaskPool::post(Priority priority, std::function<void()> task) {
  (void)priority;
  {
    std::lock_guard lock(mutex_);
    if (stopping_) return;
  }
  // Inline execution: priority lanes are irrelevant because the caller waits
  // for the task either way.
  task();
}

void TaskPool::shutdown() {
  std::lock_guard lock(mutex_);
  stopping_ = true;
}

void TaskPool::workerLoop() {}

#else

TaskPool::TaskPool(unsigned threads) {
  workers_.reserve(threads);
  for (unsigned i = 0; i < threads; ++i) {
    workers_.emplace_back([this] { workerLoop(); });
  }
}

TaskPool::~TaskPool() { shutdown(); }

void TaskPool::post(Priority priority, std::function<void()> task) {
  {
    std::lock_guard lock(mutex_);
    if (stopping_) return;
    (priority == Priority::Interactive ? interactive_ : background_).push_back(std::move(task));
  }
  cv_.notify_one();
}

void TaskPool::shutdown() {
  {
    std::lock_guard lock(mutex_);
    if (stopping_) return;
    stopping_ = true;
  }
  cv_.notify_all();
  for (auto& w : workers_) {
    if (w.joinable()) w.join();
  }
}

#endif  // GG_SINGLE_THREADED

#ifndef GG_SINGLE_THREADED
void TaskPool::workerLoop() {
  for (;;) {
    std::function<void()> task;
    {
      std::unique_lock lock(mutex_);
      cv_.wait(lock, [this] { return stopping_ || !interactive_.empty() || !background_.empty(); });
      if (interactive_.empty() && background_.empty()) {
        if (stopping_) return;
        continue;
      }
      auto& queue = interactive_.empty() ? background_ : interactive_;
      task = std::move(queue.front());
      queue.pop_front();
    }
    // Worker threads are the outermost frame: an exception escaping here
    // reaches the thread entry point and terminates the process.
    try {
      task();
    } catch (const std::exception& e) {
      spdlog::error("pool task threw: {}", e.what());
    } catch (...) {
      spdlog::error("pool task threw a non-std exception");
    }
  }
}
#endif  // !GG_SINGLE_THREADED

}  // namespace gg
