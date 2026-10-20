#pragma once

#include <chrono>
#include <condition_variable>
#include <deque>
#include <functional>
#include <list>
#include <mutex>
#include <thread>
#include <vector>

namespace gg {

enum class Priority {
  Interactive,  // blame for the visible editor, hover data, graph page-in
  Background,   // search sweeps, cache warmup, stats
};

// Worker pool with two priority lanes. Interactive tasks always dequeue
// before background ones; there is no preemption of running tasks — long
// background work must stay cancellable instead.
//
// Many tasks spend most of their time blocked on a git child (a fetch over a
// slow link, a blame of a huge file, a commit hook), so a pool sized to the
// CPU count can be filled by a handful of them while quick requests queue
// behind. When tasks are queued, no worker is idle and nothing has been
// dequeued for kStarvationDelay, the pool adds a worker, up to `maxThreads`;
// workers added that way retire after kIdleRetire without work.
//
// Under GG_SINGLE_THREADED the pool runs inline: post() executes the task
// immediately on the calling thread and no workers are spawned. Ordering
// semantics collapse naturally (everything runs in post order) and Strand
// works unchanged on top.
class TaskPool {
 public:
  static constexpr unsigned kMaxThreads = 64;
  static constexpr std::chrono::milliseconds kStarvationDelay{100};
  static constexpr std::chrono::seconds kIdleRetire{10};

  explicit TaskPool(unsigned threads = defaultThreadCount(), unsigned maxThreads = kMaxThreads);
  ~TaskPool();

  TaskPool(const TaskPool&) = delete;
  TaskPool& operator=(const TaskPool&) = delete;

  void post(Priority priority, std::function<void()> task);
  void shutdown();

  // Workers alive right now (for tests).
  unsigned threadCount();

  static unsigned defaultThreadCount();

 private:
  void workerLoop(bool core);
  void supervisorLoop();

  struct Worker {
    std::thread thread;
    bool finished = false;
  };

  std::mutex mutex_;
  std::condition_variable cv_;
  std::condition_variable supervisorCv_;
  std::deque<std::function<void()>> interactive_;
  std::deque<std::function<void()>> background_;
  std::list<Worker> workers_;
  std::thread supervisor_;
#ifndef GG_SINGLE_THREADED
  unsigned coreThreads_ = 0;
  unsigned maxThreads_ = 0;
  unsigned live_ = 0;
  unsigned idle_ = 0;
#endif
  std::chrono::steady_clock::time_point lastDequeue_;
  bool stopping_ = false;
};

}  // namespace gg
