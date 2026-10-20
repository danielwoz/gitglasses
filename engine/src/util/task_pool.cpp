#include "util/task_pool.h"
#include <spdlog/spdlog.h>

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

TaskPool::TaskPool(unsigned threads, unsigned maxThreads) {
  (void)threads;
  (void)maxThreads;
}

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

unsigned TaskPool::threadCount() { return 0; }

void TaskPool::workerLoop(bool) {}

void TaskPool::supervisorLoop() {}

#else

TaskPool::TaskPool(unsigned threads, unsigned maxThreads)
    : coreThreads_(std::max(threads, 1u)), maxThreads_(std::max(maxThreads, threads)) {
  std::lock_guard lock(mutex_);
  lastDequeue_ = std::chrono::steady_clock::now();
  for (unsigned i = 0; i < coreThreads_; ++i) {
    workers_.emplace_back();
    workers_.back().thread = std::thread([this] { workerLoop(/*core=*/true); });
    ++live_;
  }
  supervisor_ = std::thread([this] { supervisorLoop(); });
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
  supervisorCv_.notify_all();
  if (supervisor_.joinable()) supervisor_.join();
  // Workers finish what is queued before they exit; the list no longer
  // changes once the supervisor has stopped.
  for (auto& worker : workers_) {
    if (worker.thread.joinable()) worker.thread.join();
  }
}

unsigned TaskPool::threadCount() {
  std::lock_guard lock(mutex_);
  return live_;
}

void TaskPool::supervisorLoop() {
  std::unique_lock lock(mutex_);
  while (!stopping_) {
    supervisorCv_.wait_for(lock, kStarvationDelay / 2);
    if (stopping_) break;

    // Retired workers have returned, so joining them cannot block for long.
    std::list<Worker> retired;
    for (auto it = workers_.begin(); it != workers_.end();) {
      if (it->finished) {
        retired.splice(retired.end(), workers_, it++);
      } else {
        ++it;
      }
    }
    if (!retired.empty()) {
      lock.unlock();
      for (auto& worker : retired) worker.thread.join();
      lock.lock();
      if (stopping_) break;
    }

    const bool queued = !interactive_.empty() || !background_.empty();
    const auto now = std::chrono::steady_clock::now();
    if (queued && idle_ == 0 && live_ < maxThreads_ && now - lastDequeue_ >= kStarvationDelay) {
      workers_.emplace_back();
      workers_.back().thread = std::thread([this] { workerLoop(/*core=*/false); });
      ++live_;
      // The next worker, if one is needed, waits for another full delay.
      lastDequeue_ = now;
    }
  }
}

void TaskPool::workerLoop(bool core) {
  for (;;) {
    std::function<void()> task;
    {
      std::unique_lock lock(mutex_);
      ++idle_;
      const auto ready = [this] {
        return stopping_ || !interactive_.empty() || !background_.empty();
      };
      if (core) {
        cv_.wait(lock, ready);
      } else if (!cv_.wait_for(lock, kIdleRetire, ready)) {
        // An added worker with nothing to do goes away again.
        --idle_;
        --live_;
        for (auto& worker : workers_) {
          if (worker.thread.get_id() == std::this_thread::get_id()) worker.finished = true;
        }
        return;
      }
      --idle_;
      if (interactive_.empty() && background_.empty()) {
        if (stopping_) {
          --live_;
          return;
        }
        continue;
      }
      auto& queue = interactive_.empty() ? background_ : interactive_;
      task = std::move(queue.front());
      queue.pop_front();
      lastDequeue_ = std::chrono::steady_clock::now();
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

#endif  // GG_SINGLE_THREADED

}  // namespace gg
