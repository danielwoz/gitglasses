#pragma once

#include <cstdint>
#include <functional>
#include <map>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

namespace gg::watch {

class RepoWatch;
class InotifyHub;

// Watches registered repositories' gitdirs and reports coalesced change
// batches. Callbacks are invoked from a watcher thread, so they must be
// thread-safe. Batches are debounced and classified into the repo/didChange
// protocol categories ('HEAD', 'refs', 'index', 'stash', 'sequencer'), with a
// per-repo generation counter that starts at 1 and increases by one per batch.
//
// The kernel watcher is a single inotify instance shared by every repository,
// with one watch descriptor per watched directory: instances are capped per
// uid (fs.inotify.max_user_instances, typically 128, shared with the editor
// process) while descriptors are not (max_user_watches, ~1M). When no inotify
// instance can be obtained each repository falls back to its own periodic
// stat sweep thread, which costs CPU and reports changes late;
// nativeBackendActive() reports which mechanism is live.
class WatchManager {
 public:
  using Callback = std::function<void(const std::string& repoId, std::uint64_t generation,
                                      const std::vector<std::string>& changed)>;

  enum class Backend {
    kAuto,     // inotify when available, polling otherwise
    kPolling,  // periodic stat sweep of the gitdir
  };

  explicit WatchManager(Callback callback, Backend backend = Backend::kAuto);
  ~WatchManager();  // stops and joins all watch threads

  WatchManager(const WatchManager&) = delete;
  WatchManager& operator=(const WatchManager&) = delete;

  // Starts watching the repo's gitdir. Idempotent for already-watched repos.
  void watch(const std::string& repoId, const std::string& gitdir);

  // Stops watching the repo and releases its watch descriptors or thread.
  // Idempotent for repos that are not watched.
  void unwatch(const std::string& repoId);

  bool isWatching(const std::string& repoId) const;

  // True when the shared kernel watcher is in use, false when watching has
  // degraded to the polling sweep (or the platform has no kernel watcher).
  bool nativeBackendActive() const;

 private:
  Callback callback_;
  Backend backend_;
  mutable std::mutex mutex_;
  // Present only while the kernel watcher is available; one instance total.
  std::unique_ptr<InotifyHub> hub_;
  // Per-repo polling threads, used only for repos the hub cannot take.
  std::map<std::string, std::unique_ptr<RepoWatch>> polls_;
};

}  // namespace gg::watch
