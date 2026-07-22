#include "util/task_pool.h"

#include <algorithm>

namespace gg {

unsigned TaskPool::defaultThreadCount() {
  unsigned hw = std::thread::hardware_concurrency();
  return std::clamp(hw, 2u, 8u);
}

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
    task();
  }
}

}  // namespace gg
