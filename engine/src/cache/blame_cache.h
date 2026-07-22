#pragma once

#include <list>
#include <map>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

#include "exec/parsers/incremental_blame.h"

namespace gg::cache {

struct BlameResult {
  std::vector<exec::BlameHunk> hunks;
  std::map<std::string, exec::BlameCommit> commits;

  size_t byteSize() const;
};

// Byte-budgeted LRU of parsed blame results. Keys are content-addressed —
// (blamed commit OID, blob OID) — so entries never go stale; they are only
// evicted. Thread-safe.
class BlameCache {
 public:
  explicit BlameCache(size_t byteBudget = 64 << 20) : budget_(byteBudget) {}

  std::shared_ptr<const BlameResult> get(const std::string& key);
  void put(const std::string& key, std::shared_ptr<const BlameResult> result);

  static std::string makeKey(const std::string& commitOid, const std::string& blobOid);

  size_t bytesUsed() const;

 private:
  void evictLocked();

  mutable std::mutex mutex_;
  size_t budget_;
  size_t used_ = 0;
  std::list<std::string> lru_;  // front = most recent
  struct Entry {
    std::shared_ptr<const BlameResult> result;
    std::list<std::string>::iterator lruPos;
    size_t bytes;
  };
  std::map<std::string, Entry> entries_;
};

}  // namespace gg::cache
