#include "watch/watch_manager.h"

#include <spdlog/spdlog.h>

#include <algorithm>
#include <chrono>
#include <condition_variable>
#include <filesystem>
#include <optional>
#include <set>
#include <thread>
#include <utility>

#ifdef __linux__
#include <fcntl.h>
#include <poll.h>
#include <sys/inotify.h>
#include <unistd.h>
#endif

namespace gg::watch {

namespace {

namespace fs = std::filesystem;
using Clock = std::chrono::steady_clock;

#ifdef __linux__
constexpr auto kDebounce = std::chrono::milliseconds(50);
#endif
constexpr auto kPollInterval = std::chrono::milliseconds(500);

bool startsWith(const std::string& value, const std::string& prefix) {
  return value.rfind(prefix, 0) == 0;
}

bool endsWith(const std::string& value, const std::string& suffix) {
  return value.size() >= suffix.size() &&
         value.compare(value.size() - suffix.size(), suffix.size(), suffix) == 0;
}

// Maps a path relative to the gitdir onto a repo/didChange category. Empty
// for paths the protocol does not report (objects, logs, lockfiles, ...).
std::string classify(const std::string& rel) {
  if (endsWith(rel, ".lock")) return "";
  if (rel == "HEAD") return "HEAD";
  if (rel == "index") return "index";
  if (rel == "packed-refs") return "refs";
  if (rel == "refs/stash") return "stash";
  if (rel == "refs" || startsWith(rel, "refs/")) return "refs";
  // Linked worktrees keep their admin state (HEAD, index, locks) under
  // $GIT_DIR/worktrees/<name>; from this repository's side any of it is a
  // worktree change.
  if (rel == "worktrees" || startsWith(rel, "worktrees/")) return "worktrees";
  if (rel == "MERGE_HEAD" || rel == "CHERRY_PICK_HEAD" || rel == "rebase-merge" ||
      rel == "rebase-apply" || startsWith(rel, "rebase-merge/") ||
      startsWith(rel, "rebase-apply/")) {
    return "sequencer";
  }
  return "";
}

#ifdef __linux__
// Directory trees inside the gitdir that are watched recursively; everything
// else is covered by the watch on the gitdir itself.
bool isRecursiveRoot(const std::string& rel) {
  return rel == "refs" || startsWith(rel, "refs/") || rel == "rebase-merge" ||
         startsWith(rel, "rebase-merge/") || rel == "rebase-apply" ||
         startsWith(rel, "rebase-apply/") || rel == "worktrees" ||
         startsWith(rel, "worktrees/");
}

std::string joinRel(const std::string& dir, const std::string& name) {
  if (dir.empty()) return name;
  if (name.empty()) return dir;
  return dir + "/" + name;
}
#endif

}  // namespace

#ifdef __linux__

// The process's single inotify instance and the thread draining it. Every
// watched repository contributes watch descriptors to this one instance;
// events are routed back to a repository through the descriptor map.
class InotifyHub {
 public:
  // Returns nullptr when no inotify instance is available (the per-uid
  // instance cap is shared with the rest of the session).
  static std::unique_ptr<InotifyHub> create(WatchManager::Callback callback) {
    const int fd = inotify_init1(IN_NONBLOCK | IN_CLOEXEC);
    if (fd < 0) return nullptr;
    int wake[2] = {-1, -1};
    if (pipe2(wake, O_CLOEXEC) != 0) {
      close(fd);
      return nullptr;
    }
    return std::unique_ptr<InotifyHub>(new InotifyHub(fd, wake, std::move(callback)));
  }

  ~InotifyHub() {
    {
      std::lock_guard lock(mutex_);
      stop_ = true;
    }
    const char byte = 0;
    const ssize_t written = write(wakeWrite_, &byte, 1);
    (void)written;
    if (thread_.joinable()) thread_.join();
    close(inotifyFd_);
    close(wakeRead_);
    close(wakeWrite_);
  }

  InotifyHub(const InotifyHub&) = delete;
  InotifyHub& operator=(const InotifyHub&) = delete;

  // Registers the repo's gitdir tree. Returns false when the kernel refuses
  // every descriptor, leaving the repo unwatched for the caller to fall back.
  bool add(const std::string& repoId, const std::string& gitdir) {
    std::lock_guard lock(mutex_);
    if (repos_.find(repoId) != repos_.end()) return true;
    RepoState& state = repos_[repoId];
    state.gitdir = gitdir;
    addDirWatchLocked(repoId, state, "");
    addDirTreeLocked(repoId, state, "refs");
    // A rebase or cherry-pick may already be in flight when the watch starts.
    addDirTreeLocked(repoId, state, "rebase-merge");
    addDirTreeLocked(repoId, state, "rebase-apply");
    addDirTreeLocked(repoId, state, "worktrees");
    if (state.wds.empty()) {
      repos_.erase(repoId);
      return false;
    }
    return true;
  }

  void remove(const std::string& repoId) {
    std::lock_guard lock(mutex_);
    const auto it = repos_.find(repoId);
    if (it == repos_.end()) return;
    for (const int wd : it->second.wds) {
      inotify_rm_watch(inotifyFd_, wd);
      watchDirs_.erase(wd);
    }
    repos_.erase(it);
  }

  bool has(const std::string& repoId) const {
    std::lock_guard lock(mutex_);
    return repos_.find(repoId) != repos_.end();
  }

 private:
  struct WatchDir {
    std::string repoId;
    std::string rel;  // directory path relative to the gitdir
  };

  struct RepoState {
    std::string gitdir;
    std::set<int> wds;
    std::uint64_t generation = 0;
    std::set<std::string> pending;
    std::optional<Clock::time_point> deadline;
  };

  InotifyHub(int inotifyFd, const int wake[2], WatchManager::Callback callback)
      : inotifyFd_(inotifyFd),
        wakeRead_(wake[0]),
        wakeWrite_(wake[1]),
        callback_(std::move(callback)) {
    thread_ = std::thread([this] { run(); });
  }

  void addDirWatchLocked(const std::string& repoId, RepoState& state, const std::string& rel) {
    const fs::path dir = rel.empty() ? fs::path(state.gitdir) : fs::path(state.gitdir) / rel;
    const int wd = inotify_add_watch(
        inotifyFd_, dir.c_str(),
        IN_CREATE | IN_DELETE | IN_MODIFY | IN_MOVED_FROM | IN_MOVED_TO | IN_CLOSE_WRITE |
            IN_ONLYDIR);
    if (wd < 0) return;
    watchDirs_[wd] = {repoId, rel};
    state.wds.insert(wd);
  }

  // Watches `rel` and every directory below it. New nested directories that
  // appear later get their own watches from the IN_CREATE events.
  void addDirTreeLocked(const std::string& repoId, RepoState& state, const std::string& rel) {
    const fs::path root = fs::path(state.gitdir) / rel;
    std::error_code ec;
    if (!fs::is_directory(root, ec)) return;
    addDirWatchLocked(repoId, state, rel);
    fs::recursive_directory_iterator it(root, fs::directory_options::skip_permission_denied, ec);
    const fs::recursive_directory_iterator end;
    for (; !ec && it != end; it.increment(ec)) {
      if (it->is_directory(ec)) {
        addDirWatchLocked(repoId, state,
                          fs::relative(it->path(), state.gitdir, ec).generic_string());
      }
    }
  }

  // Applies every queued event to the per-repo pending sets. Runs under the
  // mutex so descriptors cannot be removed mid-drain.
  void drainLocked() {
    for (;;) {
      alignas(inotify_event) char buffer[8192];
      const ssize_t length = read(inotifyFd_, buffer, sizeof(buffer));
      if (length <= 0) return;  // EAGAIN: queue drained
      for (const char* cursor = buffer; cursor < buffer + length;) {
        const auto* event = reinterpret_cast<const inotify_event*>(cursor);
        cursor += sizeof(inotify_event) + event->len;
        if (event->mask & IN_IGNORED) {
          if (const auto it = watchDirs_.find(event->wd); it != watchDirs_.end()) {
            if (const auto repo = repos_.find(it->second.repoId); repo != repos_.end()) {
              repo->second.wds.erase(event->wd);
            }
            watchDirs_.erase(it);
          }
          continue;
        }
        const auto dirIt = watchDirs_.find(event->wd);
        if (dirIt == watchDirs_.end()) continue;
        const std::string repoId = dirIt->second.repoId;
        const auto repoIt = repos_.find(repoId);
        if (repoIt == repos_.end()) continue;
        const std::string name = event->len > 0 ? std::string(event->name) : std::string();
        const std::string rel = joinRel(dirIt->second.rel, name);
        if ((event->mask & IN_ISDIR) && (event->mask & (IN_CREATE | IN_MOVED_TO)) &&
            isRecursiveRoot(rel)) {
          addDirTreeLocked(repoId, repoIt->second, rel);
        }
        const std::string category = classify(rel);
        if (category.empty()) continue;
        repoIt->second.pending.insert(category);
        if (!repoIt->second.deadline) repoIt->second.deadline = Clock::now() + kDebounce;
      }
    }
  }

  void run() {
    for (;;) {
      std::vector<std::pair<std::string, std::pair<std::uint64_t, std::vector<std::string>>>> due;
      int timeoutMs = -1;
      {
        std::lock_guard lock(mutex_);
        if (stop_) return;
        const auto now = Clock::now();
        for (auto& [repoId, state] : repos_) {
          if (!state.deadline) continue;
          if (now >= *state.deadline) {
            due.emplace_back(repoId,
                             std::make_pair(++state.generation,
                                            std::vector<std::string>(state.pending.begin(),
                                                                     state.pending.end())));
            state.pending.clear();
            state.deadline.reset();
            continue;
          }
          const auto remaining =
              std::chrono::duration_cast<std::chrono::milliseconds>(*state.deadline - now);
          const int ms = std::max(0, static_cast<int>(remaining.count()));
          timeoutMs = timeoutMs < 0 ? ms : std::min(timeoutMs, ms);
        }
      }
      // Callbacks reach the frame writer and must not run under the mutex.
      for (const auto& [repoId, batch] : due) callback_(repoId, batch.first, batch.second);
      if (!due.empty()) continue;

      pollfd fds[2] = {{inotifyFd_, POLLIN, 0}, {wakeRead_, POLLIN, 0}};
      const int ready = poll(fds, 2, timeoutMs);
      if (fds[1].revents & POLLIN) return;  // stop requested
      if (ready > 0 && (fds[0].revents & POLLIN)) {
        std::lock_guard lock(mutex_);
        drainLocked();
      }
    }
  }

  mutable std::mutex mutex_;
  const int inotifyFd_;
  const int wakeRead_;
  const int wakeWrite_;
  const WatchManager::Callback callback_;
  std::map<int, WatchDir> watchDirs_;   // inotify wd -> owning repo + dir
  std::map<std::string, RepoState> repos_;
  bool stop_ = false;
  std::thread thread_;
};

#else

// Platforms without inotify have no hub; every repo polls.
class InotifyHub {
 public:
  static std::unique_ptr<InotifyHub> create(WatchManager::Callback) { return nullptr; }
  bool add(const std::string&, const std::string&) { return false; }
  void remove(const std::string&) {}
  bool has(const std::string&) const { return false; }
};

#endif

// A single repository's polling fallback: one thread running a periodic stat
// sweep of the gitdir. Members are confined to that thread after
// construction, except the stop flag.
class RepoWatch {
 public:
  RepoWatch(std::string repoId, std::string gitdir, WatchManager::Callback callback)
      : repoId_(std::move(repoId)), gitdir_(std::move(gitdir)), callback_(std::move(callback)) {
    thread_ = std::thread([this] { runPoll(); });
  }

  ~RepoWatch() {
    {
      std::lock_guard lock(stopMutex_);
      stop_ = true;
    }
    stopCv_.notify_all();
    if (thread_.joinable()) thread_.join();
  }

  RepoWatch(const RepoWatch&) = delete;
  RepoWatch& operator=(const RepoWatch&) = delete;

 private:
  void emit(const std::set<std::string>& pending) {
    if (pending.empty()) return;
    const std::vector<std::string> changed(pending.begin(), pending.end());
    callback_(repoId_, ++generation_, changed);
  }

  // Snapshot of everything under the gitdir the protocol reports on:
  // path -> (mtime, size). Directories record size 0 so their appearance
  // and disappearance (rebase-merge/ etc.) still diff.
  using Snapshot = std::map<std::string, std::pair<std::int64_t, std::uint64_t>>;

  void scanEntry(Snapshot& snapshot, const std::string& rel) const {
    const fs::path path = fs::path(gitdir_) / rel;
    std::error_code ec;
    const auto mtime = fs::last_write_time(path, ec);
    if (ec) return;
    std::uint64_t size = 0;
    if (fs::is_regular_file(path, ec)) size = fs::file_size(path, ec);
    snapshot[rel] = {mtime.time_since_epoch().count(), size};
  }

  Snapshot scan() const {
    Snapshot snapshot;
    for (const char* rel : {"HEAD", "index", "packed-refs", "MERGE_HEAD", "CHERRY_PICK_HEAD"}) {
      scanEntry(snapshot, rel);
    }
    for (const char* root : {"refs", "rebase-merge", "rebase-apply", "worktrees"}) {
      scanEntry(snapshot, root);
      std::error_code ec;
      fs::recursive_directory_iterator it(fs::path(gitdir_) / root,
                                          fs::directory_options::skip_permission_denied, ec);
      const fs::recursive_directory_iterator end;
      for (; !ec && it != end; it.increment(ec)) {
        std::error_code relEc;
        scanEntry(snapshot, fs::relative(it->path(), gitdir_, relEc).generic_string());
      }
    }
    return snapshot;
  }

  void runPoll() {
    Snapshot previous = scan();
    std::unique_lock lock(stopMutex_);
    while (!stopCv_.wait_for(lock, kPollInterval, [this] { return stop_; })) {
      lock.unlock();
      Snapshot current = scan();
      std::set<std::string> pending;
      for (const auto& [rel, stamp] : current) {
        const auto it = previous.find(rel);
        if (it == previous.end() || it->second != stamp) {
          const std::string category = classify(rel);
          if (!category.empty()) pending.insert(category);
        }
      }
      for (const auto& [rel, stamp] : previous) {
        if (current.find(rel) == current.end()) {
          const std::string category = classify(rel);
          if (!category.empty()) pending.insert(category);
        }
      }
      previous = std::move(current);
      emit(pending);
      lock.lock();
    }
  }

  const std::string repoId_;
  const std::string gitdir_;
  const WatchManager::Callback callback_;

  std::uint64_t generation_ = 0;  // touched only by the watch thread
  std::mutex stopMutex_;
  std::condition_variable stopCv_;
  bool stop_ = false;
  std::thread thread_;
};

WatchManager::WatchManager(Callback callback, Backend backend)
    : callback_(std::move(callback)), backend_(backend) {
  if (backend_ == Backend::kPolling) return;
  hub_ = InotifyHub::create(callback_);
  if (!hub_) {
    spdlog::warn(
        "no inotify instance available (fs.inotify.max_user_instances reached); watching "
        "falls back to a periodic stat sweep, which costs CPU and reports changes late");
  }
}

WatchManager::~WatchManager() {
  std::lock_guard lock(mutex_);
  polls_.clear();
  hub_.reset();
}

void WatchManager::watch(const std::string& repoId, const std::string& gitdir) {
  std::lock_guard lock(mutex_);
  if (polls_.find(repoId) != polls_.end()) return;
  if (hub_ && hub_->add(repoId, gitdir)) return;
  if (hub_) {
    spdlog::warn("inotify refused every watch for '{}'; falling back to a stat sweep", gitdir);
  }
  polls_[repoId] = std::make_unique<RepoWatch>(repoId, gitdir, callback_);
}

void WatchManager::unwatch(const std::string& repoId) {
  std::unique_ptr<RepoWatch> stopping;  // joined outside the lock
  {
    std::lock_guard lock(mutex_);
    if (hub_) hub_->remove(repoId);
    if (const auto it = polls_.find(repoId); it != polls_.end()) {
      stopping = std::move(it->second);
      polls_.erase(it);
    }
  }
}

bool WatchManager::isWatching(const std::string& repoId) const {
  std::lock_guard lock(mutex_);
  if (polls_.find(repoId) != polls_.end()) return true;
  return hub_ && hub_->has(repoId);
}

bool WatchManager::nativeBackendActive() const {
  std::lock_guard lock(mutex_);
  return hub_ != nullptr;
}

}  // namespace gg::watch
