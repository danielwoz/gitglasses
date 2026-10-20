#pragma once

#include <chrono>
#include <cstddef>
#include <cstdint>
#include <functional>
#include <map>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <vector>

namespace gg::watch {

class RepoWatch;
class InotifyHub;

// Cadence of the polling fallback.
struct PollTiming {
  // Between sweeps while changes are recent.
  std::chrono::milliseconds active{500};
  // Between sweeps once nothing has changed for `idleAfter`.
  std::chrono::milliseconds idle{2000};
  std::chrono::milliseconds idleAfter{5000};
  // Between full sweeps, which re-stat every loose ref file.
  std::chrono::milliseconds fullSweep{30000};
  // A ref directory listed within this time of its last change is listed
  // again on the next sweep: a filesystem that keeps coarse timestamps
  // (whole seconds on HFS+, two seconds on FAT, the system timer's tick on
  // NTFS) gives a second change in the same tick the same mtime. This is the
  // rule git applies to racily clean index entries.
  std::chrono::milliseconds racyWindow{2000};
};

// What the latest polling sweep of a repository cost.
struct SweepCost {
  std::size_t entries = 0;   // filesystem entries it examined
  bool full = false;         // it re-stat every loose ref file
  std::uint64_t sweeps = 0;  // sweeps run so far, this one included
};

// Watches registered repositories' gitdirs (and, for linked worktrees, the
// refs in their common dir) and reports coalesced change
// batches. Callbacks are invoked from a watcher thread, so they must be
// thread-safe. Batches are debounced and classified into the repo/didChange
// protocol categories ('HEAD', 'refs', 'index', 'stash', 'worktrees',
// 'sequencer'), with a per-repo generation counter that starts at 1 and
// increases by one per batch.
//
// The kernel watcher is a single inotify instance shared by every repository,
// with one watch descriptor per watched directory: instances are capped per
// uid (fs.inotify.max_user_instances, typically 128, shared with the editor
// process) while descriptors are not (max_user_watches, ~1M). A repository
// falls back to its own periodic stat sweep thread when no inotify instance
// can be obtained, when the kernel refuses every descriptor for it, and on
// platforms without inotify (macOS, Windows).
//
// A sweep stats HEAD, the index, packed-refs and the sequencer markers, and
// the directories under refs/ rather than every loose ref: git writes a ref
// by renaming a lock file over it, which changes its directory's mtime, so
// only directories whose mtime moved are listed again. Its cost therefore
// follows the number of ref directories, not of refs. A directory listed
// moments after its last change is listed again until its mtime is older
// (PollTiming::racyWindow). A full re-stat of every loose ref runs on a
// slower cadence to catch tools that rewrite a ref in place. The sweep
// interval backs off while nothing changes.
class WatchManager {
 public:
  using Callback = std::function<void(const std::string& repoId, std::uint64_t generation,
                                      const std::vector<std::string>& changed)>;

  enum class Backend {
    kAuto,     // inotify when available, polling otherwise
    kPolling,  // periodic stat sweep of the gitdir
  };

  using PollTiming = watch::PollTiming;
  using SweepCost = watch::SweepCost;

  explicit WatchManager(Callback callback, Backend backend = Backend::kAuto,
                        PollTiming timing = PollTiming());
  ~WatchManager();  // stops and joins all watch threads

  WatchManager(const WatchManager&) = delete;
  WatchManager& operator=(const WatchManager&) = delete;

  // Starts watching the repo's gitdir. Idempotent for already-watched repos.
  //
  // A linked worktree's gitdir ($GIT_DIR/worktrees/<name>) holds only its
  // own HEAD, index and sequencer state; branches, tags, remote-tracking refs
  // and the stash live in the common dir it shares with the main checkout.
  // When `commondir` names a different directory, its refs/ tree and
  // packed-refs are watched too and reported as 'refs' and 'stash'. The
  // common dir's HEAD, index and worktrees/ belong to the main checkout and
  // are not reported for this repo.
  void watch(const std::string& repoId, const std::string& gitdir,
             const std::string& commondir = {});

  // Stops watching the repo and releases its watch descriptors or thread.
  // Idempotent for repos that are not watched.
  void unwatch(const std::string& repoId);

  bool isWatching(const std::string& repoId) const;

  // True when the shared kernel watcher exists. Repositories whose watches it
  // refused still poll, and a platform without a kernel watcher reports false.
  bool nativeBackendActive() const;

  // For a repository on the polling fallback: the cost of its latest sweep.
  // Empty before the first sweep, and for repositories that are not polled.
  std::optional<SweepCost> lastSweepCost(const std::string& repoId) const;

 private:
  Callback callback_;
  Backend backend_;
  PollTiming timing_;
  mutable std::mutex mutex_;
  // Present only while the kernel watcher is available; one instance total.
  std::unique_ptr<InotifyHub> hub_;
  // Per-repo polling threads, used only for repos the hub cannot take.
  std::map<std::string, std::unique_ptr<RepoWatch>> polls_;
};

}  // namespace gg::watch
