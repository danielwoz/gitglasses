#include "watch/watch_manager.h"

#include <spdlog/spdlog.h>

#include <algorithm>
#include <chrono>
#include <condition_variable>
#include <filesystem>
#include <fstream>
#include <optional>
#include <set>
#include <string>
#include <thread>
#include <utility>

#include "exec/win_unicode.h"

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

bool startsWith(const std::string& value, const std::string& prefix) {
  return value.rfind(prefix, 0) == 0;
}

// Paths arrive as UTF-8, libgit2's encoding. std::filesystem reads and
// writes a narrow string in the ANSI code page on Windows, so conversions go
// through char8_t.
fs::path fromUtf8(const std::string& text) {
  return fs::path(std::u8string(text.begin(), text.end()));
}

std::string toUtf8(const fs::path& path) {
  const std::u8string text = path.generic_u8string();
  return std::string(text.begin(), text.end());
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

// The same mapping for a path relative to a linked worktree's common dir,
// where only the shared refs concern the worktree.
std::string classifyShared(const std::string& rel) {
  if (endsWith(rel, ".lock")) return "";
  if (rel == "packed-refs") return "refs";
  if (rel == "refs/stash") return "stash";
  if (rel == "refs" || startsWith(rel, "refs/")) return "refs";
  return "";
}

#ifdef __linux__
// Directory trees inside the gitdir that are watched recursively; everything
// else is covered by the watch on the gitdir itself.
bool isRecursiveRoot(const std::string& rel) {
  return rel == "refs" || startsWith(rel, "refs/") || rel == "rebase-merge" ||
         startsWith(rel, "rebase-merge/") || rel == "rebase-apply" ||
         startsWith(rel, "rebase-apply/") || rel == "worktrees" || startsWith(rel, "worktrees/");
}

// The common dir's only recursive tree is refs/.
bool isSharedRecursiveRoot(const std::string& rel) {
  return rel == "refs" || startsWith(rel, "refs/");
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

  // Registers the repo's gitdir tree, plus the shared refs in `commondir`
  // when it is not empty. Returns false when the kernel refuses every
  // descriptor, leaving the repo unwatched for the caller to fall back.
  bool add(const std::string& repoId, const std::string& gitdir, const std::string& commondir) {
    std::lock_guard lock(mutex_);
    if (repos_.find(repoId) != repos_.end()) return true;
    RepoState& state = repos_[repoId];
    state.gitdir = gitdir;
    state.commondir = commondir;
    addDirWatchLocked(repoId, state, "", false);
    addDirTreeLocked(repoId, state, "refs", false);
    // A rebase or cherry-pick may already be in flight when the watch starts.
    addDirTreeLocked(repoId, state, "rebase-merge", false);
    addDirTreeLocked(repoId, state, "rebase-apply", false);
    addDirTreeLocked(repoId, state, "worktrees", false);
    if (!commondir.empty()) {
      // The common dir itself for packed-refs, rewritten by rename.
      addDirWatchLocked(repoId, state, "", true);
      addDirTreeLocked(repoId, state, "refs", true);
    }
    if (state.wds.empty()) {
      repos_.erase(repoId);
      return false;
    }
    return true;
  }

  // Drops the repo's watchers; a descriptor is released only once no other
  // repository watches the same directory.
  void remove(const std::string& repoId) {
    std::lock_guard lock(mutex_);
    const auto it = repos_.find(repoId);
    if (it == repos_.end()) return;
    for (const int wd : it->second.wds) {
      const auto dirIt = watchDirs_.find(wd);
      if (dirIt == watchDirs_.end()) continue;
      auto& watchers = dirIt->second;
      watchers.erase(std::remove_if(watchers.begin(), watchers.end(),
                                    [&](const WatchDir& dir) { return dir.repoId == repoId; }),
                     watchers.end());
      if (watchers.empty()) {
        inotify_rm_watch(inotifyFd_, wd);
        watchDirs_.erase(dirIt);
      }
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
    std::string rel;      // directory path relative to the gitdir or common dir
    bool shared = false;  // under the linked worktree's common dir

    bool operator==(const WatchDir&) const = default;
  };

  struct RepoState {
    std::string gitdir;
    std::string commondir;  // empty unless the repo is a linked worktree
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

  static const std::string& baseOf(const RepoState& state, bool shared) {
    return shared ? state.commondir : state.gitdir;
  }

  // inotify hands out one descriptor per directory, so a directory several
  // repositories watch (a main checkout and its linked worktrees share the
  // common dir) carries one entry per watcher.
  void addDirWatchLocked(const std::string& repoId, RepoState& state, const std::string& rel,
                         bool shared) {
    const fs::path base(baseOf(state, shared));
    const fs::path dir = rel.empty() ? base : base / rel;
    const int wd = inotify_add_watch(
        inotifyFd_, dir.c_str(),
        IN_CREATE | IN_DELETE | IN_MODIFY | IN_MOVED_FROM | IN_MOVED_TO | IN_CLOSE_WRITE |
            IN_ONLYDIR);
    if (wd < 0) return;
    auto& watchers = watchDirs_[wd];
    const WatchDir entry{repoId, rel, shared};
    if (std::find(watchers.begin(), watchers.end(), entry) == watchers.end()) {
      watchers.push_back(entry);
    }
    state.wds.insert(wd);
  }

  // Watches `rel` and every directory below it. New nested directories that
  // appear later get their own watches from the IN_CREATE events.
  void addDirTreeLocked(const std::string& repoId, RepoState& state, const std::string& rel,
                        bool shared) {
    const fs::path base(baseOf(state, shared));
    const fs::path root = base / rel;
    std::error_code ec;
    if (!fs::is_directory(root, ec)) return;
    addDirWatchLocked(repoId, state, rel, shared);
    fs::recursive_directory_iterator it(root, fs::directory_options::skip_permission_denied, ec);
    const fs::recursive_directory_iterator end;
    for (; !ec && it != end; it.increment(ec)) {
      if (it->is_directory(ec)) {
        addDirWatchLocked(repoId, state, fs::relative(it->path(), base, ec).generic_string(),
                          shared);
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
            for (const auto& watcher : it->second) {
              if (const auto repo = repos_.find(watcher.repoId); repo != repos_.end()) {
                repo->second.wds.erase(event->wd);
              }
            }
            watchDirs_.erase(it);
          }
          continue;
        }
        const auto dirIt = watchDirs_.find(event->wd);
        if (dirIt == watchDirs_.end()) continue;
        const std::string name = event->len > 0 ? std::string(event->name) : std::string();
        // Copied: registering a new subtree below may add entries to the map.
        const std::vector<WatchDir> watchers = dirIt->second;
        for (const auto& watcher : watchers) {
          const auto repoIt = repos_.find(watcher.repoId);
          if (repoIt == repos_.end()) continue;
          const std::string rel = joinRel(watcher.rel, name);
          const bool recursive = watcher.shared ? isSharedRecursiveRoot(rel) : isRecursiveRoot(rel);
          if ((event->mask & IN_ISDIR) && (event->mask & (IN_CREATE | IN_MOVED_TO)) && recursive) {
            addDirTreeLocked(watcher.repoId, repoIt->second, rel, watcher.shared);
          }
          const std::string category = watcher.shared ? classifyShared(rel) : classify(rel);
          if (category.empty()) continue;
          repoIt->second.pending.insert(category);
          if (!repoIt->second.deadline) repoIt->second.deadline = Clock::now() + kDebounce;
        }
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
            due.emplace_back(repoId, std::make_pair(++state.generation,
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
  std::map<int, std::vector<WatchDir>> watchDirs_;  // inotify wd -> watching repos + dirs
  std::map<std::string, RepoState> repos_;
  bool stop_ = false;
  std::thread thread_;
};

#else

// Platforms without inotify have no hub; every repo polls.
class InotifyHub {
 public:
  static std::unique_ptr<InotifyHub> create(WatchManager::Callback) { return nullptr; }
  bool add(const std::string&, const std::string&, const std::string&) { return false; }
  void remove(const std::string&) {}
  bool has(const std::string&) const { return false; }
};

#endif

// A single repository's polling fallback: one thread running a periodic stat
// sweep of the gitdir (and of a linked worktree's shared refs). Members are
// confined to that thread after construction, except the stop flag and the
// latest sweep cost.
class RepoWatch {
 public:
  RepoWatch(std::string repoId, std::string gitdir, std::string commondir,
            WatchManager::Callback callback, WatchManager::PollTiming timing)
      : repoId_(std::move(repoId)), callback_(std::move(callback)), timing_(timing) {
    roots_[0].base = std::move(gitdir);
    roots_[0].categorize = &classify;
    roots_[1].base = std::move(commondir);
    roots_[1].categorize = &classifyShared;
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

  std::optional<WatchManager::SweepCost> lastSweepCost() const {
    std::lock_guard lock(costMutex_);
    return cost_;
  }

 private:
  // What a sweep saw of one entry: its mtime and size (0 for a directory),
  // and, for a small file stamped within the racy window of its mtime, a hash
  // of its content. A second change in the same timestamp tick can keep both
  // mtime and size (a loose ref is always 41 bytes); the hash still tells.
  struct Stamp {
    std::int64_t mtime = 0;
    std::uint64_t size = 0;
    std::optional<std::size_t> content;
  };
  using Stamps = std::map<std::string, Stamp>;

  // Files up to this size have their content hashed while racy: loose refs,
  // HEAD and the sequencer's files. The index and packed-refs are left to
  // their mtime and size; they can be large and git rewrites them often.
  static constexpr std::uint64_t kMaxHashedSize = 4096;

  static bool hashable(const fs::path& path, std::uint64_t size) {
    if (size > kMaxHashedSize) return false;
    const fs::path name = path.filename();
    return name != "index" && name != "packed-refs";
  }

  // One directory under refs/ and what its last listing held.
  struct RefDir {
    std::int64_t mtime = 0;
    bool racy = false;           // listed within the racy window of `mtime`
    Stamps files;                // name -> stamp
    std::set<std::string> dirs;  // names of subdirectories
  };

  // The gitdir ([0]) or a linked worktree's common dir ([1], `base` empty
  // otherwise), with the state its last sweep saw.
  struct Root {
    std::string base;
    std::string (*categorize)(const std::string&) = nullptr;
    Stamps files;                        // single files and small trees
    std::map<std::string, RefDir> refs;  // directory path relative to `base`
  };

  // Counts the filesystem entries one sweep examines.
  struct Sweep {
    bool full = false;
    // Entries whose mtime is this recent or later (filesystem clock, in mtime
    // units) are racy: a directory is listed again next time, a small file's
    // content is hashed.
    std::int64_t racySince = 0;
    std::size_t entries = 0;
    std::set<std::string> pending;
  };

  static fs::path under(const std::string& base, const std::string& rel) {
    return rel.empty() ? fromUtf8(base) : fromUtf8(base) / fromUtf8(rel);
  }

  // A hash of a small file's content; empty when it cannot be read. On
  // Windows the file is opened sharing delete access, so git can still
  // rename a lock file over it meanwhile.
  static std::optional<std::size_t> contentHash(const fs::path& path) {
    std::string content(kMaxHashedSize + 1, '\0');
#ifdef _WIN32
    const HANDLE file = CreateFileW(path.c_str(), GENERIC_READ,
                                    FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr,
                                    OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (file == INVALID_HANDLE_VALUE) return std::nullopt;
    DWORD read = 0;
    const BOOL ok =
        ReadFile(file, content.data(), static_cast<DWORD>(content.size()), &read, nullptr);
    CloseHandle(file);
    if (!ok) return std::nullopt;
    content.resize(read);
#else
    std::ifstream in(path, std::ios::binary);
    if (!in) return std::nullopt;
    in.read(content.data(), static_cast<std::streamsize>(content.size()));
    content.resize(static_cast<std::size_t>(in.gcount()));
#endif
    return std::hash<std::string>{}(content);
  }

  // Finishes a stamp: hashes the content of a small file that is racy.
  static Stamp stamp(const fs::path& path, std::int64_t mtime, std::uint64_t size, bool file,
                     const Sweep& sweep) {
    Stamp stamp{mtime, size, std::nullopt};
    if (file && mtime >= sweep.racySince && hashable(path, size)) {
      stamp.content = contentHash(path);
    }
    return stamp;
  }

  static std::optional<Stamp> stampOf(const fs::path& path, Sweep& sweep) {
    ++sweep.entries;
    std::error_code ec;
    const auto mtime = fs::last_write_time(path, ec);
    if (ec) return std::nullopt;
    std::uint64_t size = 0;
    const bool file = fs::is_regular_file(path, ec);
    if (file) size = fs::file_size(path, ec);
    if (ec) size = 0;
    return stamp(path, mtime.time_since_epoch().count(), size, file, sweep);
  }

  // The same for an entry a directory listing produced, reusing what the
  // listing already knows (its type everywhere, its times and size on
  // Windows).
  static std::optional<Stamp> stampOf(const fs::directory_entry& entry, Sweep& sweep) {
    ++sweep.entries;
    std::error_code ec;
    const auto mtime = entry.last_write_time(ec);
    if (ec) return std::nullopt;
    std::uint64_t size = 0;
    const bool file = entry.is_regular_file(ec);
    if (file) size = entry.file_size(ec);
    if (ec) size = 0;
    return stamp(entry.path(), mtime.time_since_epoch().count(), size, file, sweep);
  }

  // Whether the entry at `path`, stamped `now`, changed since it was stamped
  // `before`. Equal mtimes and sizes are checked against the content hash
  // `before` took while racy; `now` keeps a hash only while it is racy
  // itself.
  static bool changed(const Stamp& before, Stamp& now, const fs::path& path, const Sweep& sweep) {
    if (before.mtime != now.mtime || before.size != now.size) return true;
    if (!before.content) return false;
    if (!now.content) now.content = contentHash(path);
    const bool differs = now.content != before.content;
    if (now.mtime < sweep.racySince) now.content.reset();
    return differs;
  }

  static void report(const Root& root, const std::string& rel, Sweep& sweep) {
    const std::string category = root.categorize(rel);
    if (!category.empty()) sweep.pending.insert(category);
  }

  static std::string join(const std::string& dir, const std::string& name) {
    return dir.empty() ? name : dir + "/" + name;
  }

  // Compares one single file or small tree with what the last sweep saw.
  static void sweepFile(Root& root, const std::string& rel, Stamps& seen, Sweep& sweep) {
    if (const auto stamp = stampOf(under(root.base, rel), sweep)) {
      seen[rel] = *stamp;
    }
  }

  // Every entry of a small tree (rebase-merge/, worktrees/): the sequencer
  // writes its files in place, so each one is stamped.
  static void sweepTree(Root& root, const std::string& rel, Stamps& seen, Sweep& sweep) {
    const fs::path top = under(root.base, rel);
    sweepFile(root, rel, seen, sweep);
    if (seen.find(rel) == seen.end()) return;
    std::error_code ec;
    fs::recursive_directory_iterator it(top, fs::directory_options::skip_permission_denied, ec);
    const fs::recursive_directory_iterator end;
    const std::string prefix = toUtf8(top) + "/";
    for (; !ec && it != end; it.increment(ec)) {
      const std::string path = toUtf8(it->path());
      if (path.compare(0, prefix.size(), prefix) != 0) continue;
      sweepFile(root, rel + "/" + path.substr(prefix.size()), seen, sweep);
    }
  }

  // Lists one refs directory: its files with their stamps and its
  // subdirectories. Empty when the directory is gone.
  static std::optional<RefDir> listRefDir(const Root& root, const std::string& rel,
                                          std::int64_t mtime, Sweep& sweep) {
    RefDir dir;
    dir.mtime = mtime;
    dir.racy = mtime >= sweep.racySince;
    std::error_code ec;
    fs::directory_iterator it(under(root.base, rel), fs::directory_options::skip_permission_denied,
                              ec);
    if (ec) return std::nullopt;
    for (const fs::directory_iterator end; it != end; it.increment(ec)) {
      if (ec) break;
      const std::string name = toUtf8(it->path().filename());
      std::error_code typeEc;
      if (it->is_directory(typeEc)) {
        dir.dirs.insert(name);
      } else if (const auto stamp = stampOf(*it, sweep)) {
        dir.files[name] = *stamp;
      }
    }
    return dir;
  }

  // Adds `rel` and every directory below it to the refs state, reporting
  // their files when `reportNew` (a directory that appeared since the last
  // sweep).
  static void addRefTree(Root& root, const std::string& rel, bool reportNew, Sweep& sweep) {
    const auto stamp = stampOf(under(root.base, rel), sweep);
    if (!stamp) return;
    auto listed = listRefDir(root, rel, stamp->mtime, sweep);
    if (!listed) return;
    if (reportNew) {
      report(root, rel, sweep);
      for (const auto& [name, fileStamp] : listed->files) report(root, join(rel, name), sweep);
    }
    const std::set<std::string> subdirs = listed->dirs;
    root.refs[rel] = std::move(*listed);
    for (const auto& name : subdirs) addRefTree(root, join(rel, name), reportNew, sweep);
  }

  // Forgets `rel` and everything below it, reporting their files.
  static void dropRefTree(Root& root, const std::string& rel, Sweep& sweep) {
    const auto it = root.refs.find(rel);
    if (it == root.refs.end()) return;
    report(root, rel, sweep);
    for (const auto& [name, stamp] : it->second.files) report(root, join(rel, name), sweep);
    const std::set<std::string> subdirs = it->second.dirs;
    root.refs.erase(it);
    for (const auto& name : subdirs) dropRefTree(root, join(rel, name), sweep);
  }

  // Re-checks the refs directories: one stat per directory, and a new
  // listing only for directories whose mtime moved or that were listed too
  // soon after their last change (or all of them in a full sweep, which
  // catches files rewritten in place).
  static void sweepRefs(Root& root, Sweep& sweep) {
    if (root.refs.empty()) {
      addRefTree(root, "refs", true, sweep);
      return;
    }
    std::vector<std::string> dirs;
    dirs.reserve(root.refs.size());
    for (const auto& [rel, state] : root.refs) dirs.push_back(rel);
    for (const auto& rel : dirs) {
      const auto it = root.refs.find(rel);
      if (it == root.refs.end()) continue;  // dropped with a parent
      const auto stamp = stampOf(under(root.base, rel), sweep);
      if (!stamp) {
        dropRefTree(root, rel, sweep);
        continue;
      }
      if (stamp->mtime == it->second.mtime && !it->second.racy && !sweep.full) continue;
      auto listed = listRefDir(root, rel, stamp->mtime, sweep);
      if (!listed) {
        dropRefTree(root, rel, sweep);
        continue;
      }
      RefDir& previous = it->second;
      for (auto& [name, fileStamp] : listed->files) {
        const auto old = previous.files.find(name);
        if (old == previous.files.end() ||
            changed(old->second, fileStamp, under(root.base, join(rel, name)), sweep)) {
          report(root, join(rel, name), sweep);
        }
      }
      for (const auto& [name, fileStamp] : previous.files) {
        if (listed->files.find(name) == listed->files.end()) report(root, join(rel, name), sweep);
      }
      const std::set<std::string> before = previous.dirs;
      const std::set<std::string> after = listed->dirs;
      previous = std::move(*listed);
      for (const auto& name : before) {
        if (after.find(name) == after.end()) dropRefTree(root, join(rel, name), sweep);
      }
      for (const auto& name : after) {
        if (before.find(name) == before.end()) addRefTree(root, join(rel, name), true, sweep);
      }
    }
  }

  // Adds the category of every path that appeared, changed or vanished
  // among the single files and small trees.
  static void diffFiles(const Root& root, const Stamps& previous, Stamps& current, Sweep& sweep) {
    for (auto& [rel, stamp] : current) {
      const auto it = previous.find(rel);
      if (it == previous.end() || changed(it->second, stamp, under(root.base, rel), sweep)) {
        report(root, rel, sweep);
      }
    }
    for (const auto& [rel, stamp] : previous) {
      if (current.find(rel) == current.end()) report(root, rel, sweep);
    }
  }

  void sweep(Sweep& sweep) {
    const auto racySince =
        fs::file_time_type::clock::now() -
        std::chrono::duration_cast<fs::file_time_type::duration>(timing_.racyWindow);
    sweep.racySince = racySince.time_since_epoch().count();
    Root& own = roots_[0];
    Stamps files;
    for (const char* rel : {"HEAD", "index", "packed-refs", "MERGE_HEAD", "CHERRY_PICK_HEAD"}) {
      sweepFile(own, rel, files, sweep);
    }
    for (const char* rel : {"rebase-merge", "rebase-apply", "worktrees"}) {
      sweepTree(own, rel, files, sweep);
    }
    diffFiles(own, own.files, files, sweep);
    own.files = std::move(files);
    sweepRefs(own, sweep);

    Root& shared = roots_[1];
    if (!shared.base.empty()) {
      Stamps sharedFiles;
      sweepFile(shared, "packed-refs", sharedFiles, sweep);
      diffFiles(shared, shared.files, sharedFiles, sweep);
      shared.files = std::move(sharedFiles);
      sweepRefs(shared, sweep);
    }
  }

  void emit(const std::set<std::string>& pending) {
    if (pending.empty()) return;
    const std::vector<std::string> changed(pending.begin(), pending.end());
    callback_(repoId_, ++generation_, changed);
  }

  void runPoll() {
    // The first sweep only records the starting state.
    Sweep first;
    first.full = true;
    sweep(first);
    auto now = Clock::now();
    Clock::time_point lastChange = now;
    Clock::time_point nextFull = now + timing_.fullSweep;
    auto interval = timing_.active;
    std::unique_lock lock(stopMutex_);
    while (!stopCv_.wait_for(lock, interval, [this] { return stop_; })) {
      lock.unlock();
      now = Clock::now();
      Sweep current;
      current.full = now >= nextFull;
      if (current.full) nextFull = now + timing_.fullSweep;
      sweep(current);
      {
        std::lock_guard costLock(costMutex_);
        const std::uint64_t sweeps = cost_ ? cost_->sweeps + 1 : 1;
        cost_ = WatchManager::SweepCost{current.entries, current.full, sweeps};
      }
      if (!current.pending.empty()) lastChange = now;
      emit(current.pending);
      interval = now - lastChange >= timing_.idleAfter ? timing_.idle : timing_.active;
      lock.lock();
    }
  }

  const std::string repoId_;
  const WatchManager::Callback callback_;
  const WatchManager::PollTiming timing_;
  Root roots_[2];

  std::uint64_t generation_ = 0;  // touched only by the watch thread
  mutable std::mutex costMutex_;
  std::optional<WatchManager::SweepCost> cost_;
  std::mutex stopMutex_;
  std::condition_variable stopCv_;
  bool stop_ = false;
  std::thread thread_;
};

WatchManager::WatchManager(Callback callback, Backend backend, PollTiming timing)
    : callback_(std::move(callback)), backend_(backend), timing_(timing) {
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

void WatchManager::watch(const std::string& repoId, const std::string& gitdir,
                         const std::string& commondir) {
  // A common dir equal to the gitdir (any repository but a linked worktree)
  // adds nothing to watch.
  std::string shared = commondir;
  if (!shared.empty()) {
    std::error_code ec;
    const fs::path own = fromUtf8(gitdir);
    const fs::path common = fromUtf8(shared);
    if (fs::equivalent(own, common, ec) || own.lexically_normal() == common.lexically_normal()) {
      shared.clear();
    }
  }
  std::lock_guard lock(mutex_);
  if (polls_.find(repoId) != polls_.end()) return;
  if (hub_ && hub_->add(repoId, gitdir, shared)) return;
  if (hub_) {
    spdlog::warn("inotify refused every watch for '{}'; falling back to a stat sweep", gitdir);
  }
  polls_[repoId] = std::make_unique<RepoWatch>(repoId, gitdir, shared, callback_, timing_);
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

std::optional<WatchManager::SweepCost> WatchManager::lastSweepCost(
    const std::string& repoId) const {
  std::lock_guard lock(mutex_);
  const auto it = polls_.find(repoId);
  if (it == polls_.end()) return std::nullopt;
  return it->second->lastSweepCost();
}

}  // namespace gg::watch
