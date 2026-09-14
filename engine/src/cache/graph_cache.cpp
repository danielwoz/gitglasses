#include "cache/graph_cache.h"

#include <utility>

namespace gg::cache {

std::size_t GraphPlan::byteSize() const {
  std::size_t bytes = commits.size() * sizeof(GraphPlanRow);
  for (const auto& row : commits) {
    bytes += row.sha.size() + row.parents.size() * sizeof(std::string);
    for (const auto& parent : row.parents) bytes += parent.size();
  }
  for (const auto& stash : stashes) {
    bytes += sizeof(GraphStash) + stash.sha.size() + stash.message.size();
  }
  for (const auto& [base, indices] : stashesByBase) {
    bytes += base.size() + indices.size() * sizeof(std::size_t);
  }
  return bytes;
}

std::string GraphCache::makeKey(const std::string& repoId, std::uint64_t generation) {
  return repoId + ":" + std::to_string(generation);
}

std::shared_ptr<const GraphPlan> GraphCache::get(const std::string& key) {
  std::lock_guard lock(mutex_);
  const auto it = entries_.find(key);
  if (it == entries_.end()) return nullptr;
  lru_.splice(lru_.begin(), lru_, it->second.lruPos);
  return it->second.plan;
}

void GraphCache::put(const std::string& key, std::shared_ptr<const GraphPlan> plan) {
  const std::size_t bytes = plan->byteSize();
  std::lock_guard lock(mutex_);
  eraseLocked(key);
  lru_.push_front(key);
  entries_[key] = {std::move(plan), lru_.begin(), bytes};
  used_ += bytes;
  evictLocked();
}

void GraphCache::dropRepo(const std::string& repoId) {
  const std::string prefix = repoId + ":";
  std::lock_guard lock(mutex_);
  for (auto it = entries_.lower_bound(prefix); it != entries_.end();) {
    if (it->first.compare(0, prefix.size(), prefix) != 0) break;
    used_ -= it->second.bytes;
    lru_.erase(it->second.lruPos);
    it = entries_.erase(it);
  }
}

std::size_t GraphCache::bytesUsed() const {
  std::lock_guard lock(mutex_);
  return used_;
}

void GraphCache::eraseLocked(const std::string& key) {
  const auto it = entries_.find(key);
  if (it == entries_.end()) return;
  used_ -= it->second.bytes;
  lru_.erase(it->second.lruPos);
  entries_.erase(it);
}

void GraphCache::evictLocked() {
  while (used_ > budget_ && lru_.size() > 1) {
    const auto it = entries_.find(lru_.back());
    used_ -= it->second.bytes;
    entries_.erase(it);
    lru_.pop_back();
  }
}

}  // namespace gg::cache
