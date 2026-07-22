#include "cache/blame_cache.h"

namespace gg::cache {

size_t BlameResult::byteSize() const {
  size_t bytes = hunks.size() * sizeof(exec::BlameHunk);
  for (const auto& h : hunks) {
    bytes += h.sha.size() + h.path.size();
    if (h.previousSha) bytes += h.previousSha->size();
    if (h.previousPath) bytes += h.previousPath->size();
  }
  for (const auto& [sha, commit] : commits) {
    bytes += sha.size() + sizeof(exec::BlameCommit) + commit.author.name.size() +
             commit.author.email.size() + commit.committer.name.size() +
             commit.committer.email.size() + commit.summary.size();
  }
  return bytes;
}

std::string BlameCache::makeKey(const std::string& commitOid, const std::string& blobOid) {
  return commitOid + ":" + blobOid;
}

std::shared_ptr<const BlameResult> BlameCache::get(const std::string& key) {
  std::lock_guard lock(mutex_);
  auto it = entries_.find(key);
  if (it == entries_.end()) return nullptr;
  lru_.splice(lru_.begin(), lru_, it->second.lruPos);
  return it->second.result;
}

void BlameCache::put(const std::string& key, std::shared_ptr<const BlameResult> result) {
  const size_t bytes = result->byteSize();
  std::lock_guard lock(mutex_);
  if (auto it = entries_.find(key); it != entries_.end()) {
    used_ -= it->second.bytes;
    lru_.erase(it->second.lruPos);
    entries_.erase(it);
  }
  lru_.push_front(key);
  entries_[key] = {std::move(result), lru_.begin(), bytes};
  used_ += bytes;
  evictLocked();
}

size_t BlameCache::bytesUsed() const {
  std::lock_guard lock(mutex_);
  return used_;
}

void BlameCache::evictLocked() {
  while (used_ > budget_ && lru_.size() > 1) {
    auto it = entries_.find(lru_.back());
    used_ -= it->second.bytes;
    entries_.erase(it);
    lru_.pop_back();
  }
}

}  // namespace gg::cache
