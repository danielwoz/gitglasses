#include "repo/registry.h"

namespace gg::repo {

Result<RepoInfo> Registry::add(const std::string& path) {
  auto root = core::Repo::discover(path);
  if (!root) return root.error();

  std::lock_guard lock(mutex_);
  if (auto it = idByRoot_.find(root.value()); it != idByRoot_.end()) {
    return byId_.at(it->second);
  }

  auto repo = core::Repo::open(root.value());
  if (!repo) return repo.error();

  RepoInfo info;
  info.id = "r" + std::to_string(nextId_++);
  info.rootPath = root.value();
  info.bare = repo.value().isBare();
  byId_[info.id] = info;
  idByRoot_[info.rootPath] = info.id;
  return info;
}

std::optional<RepoInfo> Registry::byId(const std::string& id) const {
  std::lock_guard lock(mutex_);
  if (auto it = byId_.find(id); it != byId_.end()) return it->second;
  return std::nullopt;
}

std::vector<RepoInfo> Registry::list() const {
  std::lock_guard lock(mutex_);
  std::vector<RepoInfo> repos;
  repos.reserve(byId_.size());
  for (const auto& [_, info] : byId_) repos.push_back(info);
  return repos;
}

void Registry::remove(const std::string& id) {
  std::lock_guard lock(mutex_);
  if (auto it = byId_.find(id); it != byId_.end()) {
    idByRoot_.erase(it->second.rootPath);
    byId_.erase(it);
  }
}

Result<core::Repo> Registry::open(const std::string& id) const {
  std::string root;
  {
    std::lock_guard lock(mutex_);
    auto it = byId_.find(id);
    if (it == byId_.end()) return Error{ErrorCode::RepoNotFound, "unknown repo id: " + id};
    root = it->second.rootPath;
  }
  return core::Repo::open(root);
}

}  // namespace gg::repo
