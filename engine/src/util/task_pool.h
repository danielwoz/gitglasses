#pragma once

#include <condition_variable>
#include <deque>
#include <functional>
#include <mutex>
#include <thread>
#include <vector>

namespace gg {

enum class Priority {
  Interactive,  // blame for the visible editor, hover data, graph page-in
  Background,   // search sweeps, cache warmup, stats
};

// Fixed-size worker pool with two priority lanes. Interactive tasks always
// dequeue before background ones; there is no preemption of running tasks —
// long background work must stay cancellable instead.
//
// Under GG_SINGLE_THREADED the pool runs inline: post() executes the task
// immediately on the calling thread and no workers are spawned. Ordering
// semantics collapse naturally (everything runs in post order) and Strand
// works unchanged on top.
class TaskPool {
 public:
  explicit TaskPool(unsigned threads = defaultThreadCount());
  ~TaskPool();

  TaskPool(const TaskPool&) = delete;
  TaskPool& operator=(const TaskPool&) = delete;

  void post(Priority priority, std::function<void()> task);
  void shutdown();

  static unsigned defaultThreadCount();

 private:
  void workerLoop();

  std::mutex mutex_;
  std::condition_variable cv_;
  std::deque<std::function<void()>> interactive_;
  std::deque<std::function<void()>> background_;
  std::vector<std::thread> workers_;
  bool stopping_ = false;
};

}  // namespace gg
