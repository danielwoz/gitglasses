#pragma once

#include <git2.h>

#include <chrono>
#include <condition_variable>
#include <cstddef>
#include <list>
#include <map>
#include <memory>
#include <mutex>
#include <string>
#include <utility>
#include <vector>

#include "util/cancel.h"

namespace gg::services::history_detail {

// The commit sequence log/commits pages through for one history: every
// commit reachable from a tip, children before parents (libgit2's
// topological + time sort). It is filled lazily. Until the full sort has run
// (`complete` false), `oids` holds only the tip's forced run: the tip, then
// the sole parent of each commit that has exactly one, up to and including
// the first merge. No topological order can put any other commit before
// those, so the run is a prefix of the full order and pages inside it never
// pay for the whole-history walk.
struct LogOrder {
  // Whether a request holds the sequence, guarded by `mutex`; `released` is
  // signalled when it lets go. Only the holder reads or extends the members
  // below, so one request walks a given history while concurrent requests
  // for it wait.
  std::mutex mutex;
  std::condition_variable released;
  bool held = false;
  std::vector<git_oid> oids;
  bool complete = false;  // `oids` is the whole history
  bool runEnded = false;  // the forced run stops at a merge (the last oid)
};

// Holds a sequence (see LogOrder) for its lifetime, waiting in slices so a
// cancelled request stops waiting for another request's walk. The wait is on
// a condition variable rather than a std::timed_mutex: libstdc++ times
// try_lock_for with pthread_mutex_clocklock, which the ThreadSanitizer
// runtime of older clang releases does not intercept, so every unlock would
// be reported as one of an unlocked mutex.
class OrderHold {
 public:
  OrderHold(LogOrder& order, const CancelToken& token) : order_(order) {
    std::unique_lock lock(order_.mutex);
    while (order_.held) {
      order_.released.wait_for(lock, std::chrono::milliseconds(50));
      if (order_.held) token.throwIfCancelled();
    }
    order_.held = true;
  }

  ~OrderHold() {
    {
      std::lock_guard lock(order_.mutex);
      order_.held = false;
    }
    order_.released.notify_all();
  }

  OrderHold(const OrderHold&) = delete;
  OrderHold& operator=(const OrderHold&) = delete;

 private:
  LogOrder& order_;
};

// Byte-budgeted LRU of commit sequences, keyed by repository, tip commit and
// anything else that changes what the tip reaches (the shallow boundary).
// A key names an immutable history, so entries never go stale; they are only
// evicted. Thread-safe; an evicted sequence stays valid for requests still
// holding it.
class LogOrderCache {
 public:
  explicit LogOrderCache(std::size_t byteBudget = 64 << 20) : budget_(byteBudget) {}

  LogOrderCache(const LogOrderCache&) = delete;
  LogOrderCache& operator=(const LogOrderCache&) = delete;

  // The sequence for `key`, created empty on a miss, and marked most recently
  // used.
  std::shared_ptr<LogOrder> acquire(const std::string& key) {
    std::lock_guard lock(mutex_);
    if (const auto it = entries_.find(key); it != entries_.end()) {
      lru_.splice(lru_.begin(), lru_, it->second.lruPos);
      return it->second.order;
    }
    lru_.push_front(key);
    auto order = std::make_shared<LogOrder>();
    const std::size_t bytes = entryBytes(key, 0);
    entries_[key] = {order, lru_.begin(), bytes};
    used_ += bytes;
    evictLocked();
    return order;
  }

  // Records the size a sequence reached after growing, evicting the least
  // recently used sequences while the total exceeds the budget. The most
  // recent one always stays, however large. A sequence evicted in the
  // meantime is no longer accounted for and is left alone.
  void resized(const std::string& key, const LogOrder& order, std::size_t oidCount) {
    std::lock_guard lock(mutex_);
    const auto it = entries_.find(key);
    if (it == entries_.end() || it->second.order.get() != &order) return;
    const std::size_t bytes = entryBytes(key, oidCount);
    used_ = used_ - it->second.bytes + bytes;
    it->second.bytes = bytes;
    evictLocked();
  }

  std::size_t bytesUsed() const {
    std::lock_guard lock(mutex_);
    return used_;
  }

  std::size_t size() const {
    std::lock_guard lock(mutex_);
    return entries_.size();
  }

 private:
  static std::size_t entryBytes(const std::string& key, std::size_t oidCount) {
    return sizeof(LogOrder) + key.size() + oidCount * sizeof(git_oid);
  }

  void evictLocked() {
    while (used_ > budget_ && lru_.size() > 1) {
      const auto victim = entries_.find(lru_.back());
      used_ -= victim->second.bytes;
      entries_.erase(victim);
      lru_.pop_back();
    }
  }

  struct Entry {
    std::shared_ptr<LogOrder> order;
    std::list<std::string>::iterator lruPos;
    std::size_t bytes = 0;
  };

  mutable std::mutex mutex_;
  std::size_t budget_;
  std::size_t used_ = 0;
  std::list<std::string> lru_;  // front = most recent
  std::map<std::string, Entry> entries_;
};

}  // namespace gg::services::history_detail
