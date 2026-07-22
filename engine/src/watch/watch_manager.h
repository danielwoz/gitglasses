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

// Watches registered repositories' gitdirs and reports coalesced change
// batches. Each watched repo runs on its own thread; callbacks are invoked
// from that thread, so they must be thread-safe. Batches are debounced and
// classified into the repo/didChange protocol categories ('HEAD', 'refs',
// 'index', 'stash', 'sequencer'), with a per-repo generation counter that
// starts at 1 and increases by one per batch.
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

  bool isWatching(const std::string& repoId) const;

 private:
  Callback callback_;
  Backend backend_;
  mutable std::mutex mutex_;
  std::map<std::string, std::unique_ptr<RepoWatch>> watches_;
};

}  // namespace gg::watch
