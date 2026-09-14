#pragma once

#include <cstdint>
#include <list>
#include <map>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

namespace gg::cache {

// One commit of the deterministic graph sequence. Per-row presentation data
// (author, time, summary, decorations) is not stored: it is read from the
// object database only for the rows a page actually emits.
struct GraphPlanRow {
  std::string sha;
  std::vector<std::string> parents;
};

// A stash entry as the graph reports it.
struct GraphStash {
  std::size_t index = 0;
  std::string sha;
  std::string message;
};

// The whole topological walk for one repository state, plus where stash rows
// attach to it. Everything here is a function of the commit DAG and the ref
// tips, so it is valid for exactly one refs fingerprint.
struct GraphPlan {
  std::vector<GraphPlanRow> commits;  // topological order, children first
  std::vector<GraphStash> stashes;    // newest first (stash@{0} first)
  // Base commit sha -> indices into `stashes`, ascending.
  std::map<std::string, std::vector<std::size_t>> stashesByBase;

  std::size_t byteSize() const;
};

// Byte-budgeted LRU of graph plans, keyed by (repoId, refs fingerprint).
// The fingerprint changes whenever any ref moves, so entries never go stale;
// they are only evicted. Thread-safe.
class GraphCache {
 public:
  explicit GraphCache(std::size_t byteBudget = 64 << 20) : budget_(byteBudget) {}

  std::shared_ptr<const GraphPlan> get(const std::string& key);
  void put(const std::string& key, std::shared_ptr<const GraphPlan> plan);

  static std::string makeKey(const std::string& repoId, std::uint64_t refsFingerprint);

  // Drops every plan belonging to a repository (repo/close).
  void dropRepo(const std::string& repoId);

  std::size_t bytesUsed() const;

 private:
  void eraseLocked(const std::string& key);
  void evictLocked();

  mutable std::mutex mutex_;
  std::size_t budget_;
  std::size_t used_ = 0;
  std::list<std::string> lru_;  // front = most recent
  struct Entry {
    std::shared_ptr<const GraphPlan> plan;
    std::list<std::string>::iterator lruPos;
    std::size_t bytes;
  };
  std::map<std::string, Entry> entries_;
};

}  // namespace gg::cache
