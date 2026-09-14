#pragma once

#include <spdlog/spdlog.h>

#include <cstdint>
#include <list>
#include <map>
#include <mutex>
#include <optional>
#include <string>

namespace gg::cache {

// Largest editor buffer kept in the overlay. Past this the buffer is dropped
// rather than stored, and blame/diff fall back to the on-disk file.
inline constexpr size_t kMaxDocBytes = 8u << 20;

// Total overlay budget across all documents; the least recently used entries
// are evicted to stay under it.
inline constexpr size_t kDocOverlayBudget = 64u << 20;

// Holds unsaved editor buffer contents pushed by the client, keyed by
// (repoId, repo-relative path). Blame and diff requests consult this store so
// results reflect what the user sees, not what's on disk. Byte-budgeted:
// documents over kMaxDocBytes are refused and the total is held under
// kDocOverlayBudget by LRU eviction. Thread-safe.
class DocOverlay {
 public:
  explicit DocOverlay(size_t maxDocBytes = kMaxDocBytes, size_t budget = kDocOverlayBudget)
      : maxDocBytes_(maxDocBytes), budget_(budget) {}

  void update(const std::string& repoId, const std::string& path, std::string contents,
              std::int64_t version) {
    const std::string k = key(repoId, path);
    std::lock_guard lock(mutex_);
    // An oversized buffer also invalidates whatever is stored for the path:
    // serving an older version would be worse than falling back to disk.
    if (contents.size() > maxDocBytes_) {
      spdlog::warn("doc overlay: dropping '{}' ({} bytes exceeds the {}-byte per-document cap)",
                   path, contents.size(), maxDocBytes_);
      eraseLocked(k);
      return;
    }
    eraseLocked(k);
    lru_.push_front(k);
    const size_t bytes = k.size() + contents.size();
    docs_[k] = {{std::move(contents), version}, lru_.begin(), bytes};
    used_ += bytes;
    evictLocked();
  }

  void close(const std::string& repoId, const std::string& path) {
    std::lock_guard lock(mutex_);
    eraseLocked(key(repoId, path));
  }

  // Drops every document belonging to a repository (repo/close).
  void closeRepo(const std::string& repoId) {
    const std::string prefix = repoId + '\0';
    std::lock_guard lock(mutex_);
    for (auto it = docs_.lower_bound(prefix); it != docs_.end();) {
      if (it->first.compare(0, prefix.size(), prefix) != 0) break;
      used_ -= it->second.bytes;
      lru_.erase(it->second.lruPos);
      it = docs_.erase(it);
    }
  }

  struct Doc {
    std::string contents;
    std::int64_t version = 0;
  };

  std::optional<Doc> get(const std::string& repoId, const std::string& path) const {
    std::lock_guard lock(mutex_);
    const auto it = docs_.find(key(repoId, path));
    if (it == docs_.end()) return std::nullopt;
    lru_.splice(lru_.begin(), lru_, it->second.lruPos);
    return it->second.doc;
  }

  size_t bytesUsed() const {
    std::lock_guard lock(mutex_);
    return used_;
  }

 private:
  static std::string key(const std::string& repoId, const std::string& path) {
    return repoId + '\0' + path;
  }

  void eraseLocked(const std::string& k) {
    const auto it = docs_.find(k);
    if (it == docs_.end()) return;
    used_ -= it->second.bytes;
    lru_.erase(it->second.lruPos);
    docs_.erase(it);
  }

  void evictLocked() {
    while (used_ > budget_ && lru_.size() > 1) {
      const auto it = docs_.find(lru_.back());
      used_ -= it->second.bytes;
      docs_.erase(it);
      lru_.pop_back();
    }
  }

  struct Entry {
    Doc doc;
    std::list<std::string>::iterator lruPos;
    size_t bytes;
  };

  mutable std::mutex mutex_;
  size_t maxDocBytes_;
  size_t budget_;
  size_t used_ = 0;
  mutable std::list<std::string> lru_;  // front = most recent
  std::map<std::string, Entry> docs_;
};

}  // namespace gg::cache
