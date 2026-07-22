#include "watch/watch_manager.h"

#include <algorithm>
#include <chrono>
#include <condition_variable>
#include <filesystem>
#include <optional>
#include <set>
#include <thread>

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

constexpr auto kDebounce = std::chrono::milliseconds(50);
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
  if (rel == "MERGE_HEAD" || rel == "CHERRY_PICK_HEAD" || rel == "rebase-merge" ||
      rel == "rebase-apply" || startsWith(rel, "rebase-merge/") ||
      startsWith(rel, "rebase-apply/")) {
    return "sequencer";
  }
  return "";
}

// Directory trees inside the gitdir that are watched recursively; everything
// else is covered by the watch on the gitdir itself.
bool isRecursiveRoot(const std::string& rel) {
  return rel == "refs" || startsWith(rel, "refs/") || rel == "rebase-merge" ||
         startsWith(rel, "rebase-merge/") || rel == "rebase-apply" ||
         startsWith(rel, "rebase-apply/");
}

std::string joinRel(const std::string& dir, const std::string& name) {
  if (dir.empty()) return name;
  if (name.empty()) return dir;
  return dir + "/" + name;
}

}  // namespace

// A single repository watch: one thread running either the inotify loop or
// the polling sweep. All members are confined to that thread after
// construction, except the stop flag (mutex-guarded) and the wake pipe.
class RepoWatch {
 public:
  RepoWatch(std::string repoId, std::string gitdir, WatchManager::Callback callback,
            WatchManager::Backend backend)
      : repoId_(std::move(repoId)), gitdir_(std::move(gitdir)), callback_(std::move(callback)) {
#ifdef __linux__
    if (backend != WatchManager::Backend::kPolling) {
      inotifyFd_ = inotify_init1(IN_NONBLOCK | IN_CLOEXEC);
      if (inotifyFd_ >= 0 && pipe2(wakePipe_, O_CLOEXEC) != 0) {
        close(inotifyFd_);
        inotifyFd_ = -1;
        wakePipe_[0] = wakePipe_[1] = -1;
      }
    }
    if (inotifyFd_ >= 0) {
      thread_ = std::thread([this] { runInotify(); });
      return;
    }
#else
    (void)backend;
#endif
    thread_ = std::thread([this] { runPoll(); });
  }

  ~RepoWatch() {
    {
      std::lock_guard lock(stopMutex_);
      stop_ = true;
    }
    stopCv_.notify_all();
#ifdef __linux__
    if (wakePipe_[1] >= 0) {
      const char byte = 0;
      const ssize_t written = write(wakePipe_[1], &byte, 1);
      (void)written;
    }
#endif
    if (thread_.joinable()) thread_.join();
#ifdef __linux__
    if (inotifyFd_ >= 0) close(inotifyFd_);
    if (wakePipe_[0] >= 0) close(wakePipe_[0]);
    if (wakePipe_[1] >= 0) close(wakePipe_[1]);
#endif
  }

  RepoWatch(const RepoWatch&) = delete;
  RepoWatch& operator=(const RepoWatch&) = delete;

 private:
  void emit(const std::set<std::string>& pending) {
    if (pending.empty()) return;
    const std::vector<std::string> changed(pending.begin(), pending.end());
    callback_(repoId_, ++generation_, changed);
  }

#ifdef __linux__
  void addDirWatch(const std::string& rel) {
    const fs::path dir = rel.empty() ? fs::path(gitdir_) : fs::path(gitdir_) / rel;
    const int wd = inotify_add_watch(
        inotifyFd_, dir.c_str(),
        IN_CREATE | IN_DELETE | IN_MODIFY | IN_MOVED_FROM | IN_MOVED_TO | IN_CLOSE_WRITE |
            IN_ONLYDIR);
    if (wd >= 0) watchDirs_[wd] = rel;
  }

  // Watches `rel` and every directory below it. New nested directories that
  // appear later get their own watches from the IN_CREATE events.
  void addDirTree(const std::string& rel) {
    const fs::path root = fs::path(gitdir_) / rel;
    std::error_code ec;
    if (!fs::is_directory(root, ec)) return;
    addDirWatch(rel);
    fs::recursive_directory_iterator it(root, fs::directory_options::skip_permission_denied, ec);
    const fs::recursive_directory_iterator end;
    for (; !ec && it != end; it.increment(ec)) {
      if (it->is_directory(ec)) {
        addDirWatch(fs::relative(it->path(), gitdir_, ec).generic_string());
      }
    }
  }

  void drainInotify(std::set<std::string>& pending) {
    for (;;) {
      alignas(inotify_event) char buffer[4096];
      const ssize_t length = read(inotifyFd_, buffer, sizeof(buffer));
      if (length <= 0) return;  // EAGAIN: queue drained
      for (const char* cursor = buffer; cursor < buffer + length;) {
        const auto* event = reinterpret_cast<const inotify_event*>(cursor);
        cursor += sizeof(inotify_event) + event->len;
        if (event->mask & IN_IGNORED) {
          watchDirs_.erase(event->wd);
          continue;
        }
        const auto dirIt = watchDirs_.find(event->wd);
        if (dirIt == watchDirs_.end()) continue;
        const std::string name = event->len > 0 ? std::string(event->name) : std::string();
        const std::string rel = joinRel(dirIt->second, name);
        if ((event->mask & IN_ISDIR) && (event->mask & (IN_CREATE | IN_MOVED_TO)) &&
            isRecursiveRoot(rel)) {
          addDirTree(rel);
        }
        const std::string category = classify(rel);
        if (!category.empty()) pending.insert(category);
      }
    }
  }

  void runInotify() {
    addDirWatch("");
    addDirTree("refs");
    // A rebase or cherry-pick may already be in flight when the watch starts.
    addDirTree("rebase-merge");
    addDirTree("rebase-apply");

    std::set<std::string> pending;
    std::optional<Clock::time_point> deadline;
    for (;;) {
      int timeoutMs = -1;
      if (deadline) {
        const auto remaining =
            std::chrono::duration_cast<std::chrono::milliseconds>(*deadline - Clock::now());
        timeoutMs = std::max(0, static_cast<int>(remaining.count()));
      }
      pollfd fds[2] = {{inotifyFd_, POLLIN, 0}, {wakePipe_[0], POLLIN, 0}};
      const int ready = poll(fds, 2, timeoutMs);
      if (fds[1].revents & POLLIN) return;  // stop requested
      if (ready > 0 && (fds[0].revents & POLLIN)) {
        drainInotify(pending);
        if (!pending.empty() && !deadline) deadline = Clock::now() + kDebounce;
      }
      if (deadline && Clock::now() >= *deadline) {
        emit(pending);
        pending.clear();
        deadline.reset();
      }
    }
  }
#endif

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
    for (const char* root : {"refs", "rebase-merge", "rebase-apply"}) {
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

  // Touched only by the watch thread.
  std::uint64_t generation_ = 0;
  std::map<int, std::string> watchDirs_;  // inotify wd -> dir path relative to gitdir

  int inotifyFd_ = -1;
  int wakePipe_[2] = {-1, -1};
  std::mutex stopMutex_;
  std::condition_variable stopCv_;
  bool stop_ = false;
  std::thread thread_;
};

WatchManager::WatchManager(Callback callback, Backend backend)
    : callback_(std::move(callback)), backend_(backend) {}

WatchManager::~WatchManager() {
  std::lock_guard lock(mutex_);
  watches_.clear();
}

void WatchManager::watch(const std::string& repoId, const std::string& gitdir) {
  std::lock_guard lock(mutex_);
  if (watches_.find(repoId) != watches_.end()) return;
  watches_[repoId] = std::make_unique<RepoWatch>(repoId, gitdir, callback_, backend_);
}

bool WatchManager::isWatching(const std::string& repoId) const {
  std::lock_guard lock(mutex_);
  return watches_.find(repoId) != watches_.end();
}

}  // namespace gg::watch
