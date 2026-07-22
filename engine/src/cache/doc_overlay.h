#pragma once

#include <cstdint>
#include <map>
#include <mutex>
#include <optional>
#include <string>

namespace gg::cache {

// Holds unsaved editor buffer contents pushed by the client, keyed by
// (repoId, repo-relative path). Blame and diff requests consult this store so
// results reflect what the user sees, not what's on disk. Thread-safe.
class DocOverlay {
 public:
  void update(const std::string& repoId, const std::string& path, std::string contents,
              std::int64_t version) {
    std::lock_guard lock(mutex_);
    docs_[key(repoId, path)] = {std::move(contents), version};
  }

  void close(const std::string& repoId, const std::string& path) {
    std::lock_guard lock(mutex_);
    docs_.erase(key(repoId, path));
  }

  struct Doc {
    std::string contents;
    std::int64_t version = 0;
  };

  std::optional<Doc> get(const std::string& repoId, const std::string& path) const {
    std::lock_guard lock(mutex_);
    if (auto it = docs_.find(key(repoId, path)); it != docs_.end()) return it->second;
    return std::nullopt;
  }

 private:
  static std::string key(const std::string& repoId, const std::string& path) {
    return repoId + '\0' + path;
  }

  mutable std::mutex mutex_;
  std::map<std::string, Doc> docs_;
};

}  // namespace gg::cache
