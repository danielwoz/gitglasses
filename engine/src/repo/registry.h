#pragma once

#include <map>
#include <mutex>
#include <optional>
#include <string>
#include <vector>

#include "core/repo.h"

namespace gg::repo {

struct RepoInfo {
  std::string id;       // stable id: "r" + sequence number
  std::string rootPath; // working-directory root (or gitdir for bare repos)
  bool bare = false;
};

// Tracks the set of repositories the client has opened. Thread-safe. Handles
// are NOT cached here — callers open a fresh core::Repo per task (libgit2
// repository handles are not thread-safe; opens are cheap).
class Registry {
 public:
  // Discovers the repository containing `path` and registers it, reusing the
  // existing entry when already known.
  Result<RepoInfo> add(const std::string& path);

  std::optional<RepoInfo> byId(const std::string& id) const;
  std::vector<RepoInfo> list() const;
  void remove(const std::string& id);

  // Opens a fresh handle for the registered repo (call per task).
  Result<core::Repo> open(const std::string& id) const;

 private:
  mutable std::mutex mutex_;
  std::map<std::string, RepoInfo> byId_;
  std::map<std::string, std::string> idByRoot_;
  int nextId_ = 1;
};

}  // namespace gg::repo
