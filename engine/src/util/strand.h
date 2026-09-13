#pragma once

#include <spdlog/spdlog.h>

#include <deque>
#include <functional>
#include <mutex>

#include "util/task_pool.h"

namespace gg {

// FIFO executor layered on a TaskPool: tasks run in submission order, one at
// a time, without dedicating a thread. Used for engine-state mutations where
// clients rely on request order (discover-then-query, staging ops).
class Strand {
 public:
  Strand(TaskPool& pool, Priority priority) : pool_(pool), priority_(priority) {}

  void post(std::function<void()> task) {
    {
      std::lock_guard lock(mutex_);
      queue_.push_back(std::move(task));
      if (draining_) return;
      draining_ = true;
    }
    pool_.post(priority_, [this] { drain(); });
  }

 private:
  void drain() {
    for (;;) {
      std::function<void()> task;
      {
        std::lock_guard lock(mutex_);
        if (queue_.empty()) {
          draining_ = false;
          return;
        }
        task = std::move(queue_.front());
        queue_.pop_front();
      }
      // A task that throws must not escape: unwinding out of drain() leaves
      // draining_ true forever, wedging every later post on this strand, and
      // reaches the pool's thread entry where it would terminate the process.
      try {
        task();
      } catch (const std::exception& e) {
        spdlog::error("strand task threw: {}", e.what());
      } catch (...) {
        spdlog::error("strand task threw a non-std exception");
      }
    }
  }

  TaskPool& pool_;
  Priority priority_;
  std::mutex mutex_;
  std::deque<std::function<void()>> queue_;
  bool draining_ = false;
};

}  // namespace gg
