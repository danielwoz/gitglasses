#include "watch/watch_manager.h"

#include <gtest/gtest.h>

#include <algorithm>
#include <chrono>
#include <condition_variable>
#include <filesystem>
#include <fstream>
#include <mutex>
#include <optional>
#include <string>
#include <system_error>
#include <thread>
#include <vector>

#include "test_fixtures.h"

namespace gg::watch {
namespace {

using namespace std::chrono_literals;

constexpr auto kEventTimeout = 5s;

struct Event {
  std::string repoId;
  std::uint64_t generation;
  std::vector<std::string> changed;
};

// Thread-safe event sink: watcher callbacks land here; tests block until a
// matching event arrives.
class Collector {
 public:
  WatchManager::Callback callback() {
    return [this](const std::string& repoId, std::uint64_t generation,
                  const std::vector<std::string>& changed) {
      std::lock_guard lock(mutex_);
      events_.push_back({repoId, generation, changed});
      cv_.notify_all();
    };
  }

  // Waits for an event at index >= `from` containing any of `categories`,
  // for `repoId` when one is given.
  std::optional<Event> waitFor(const std::vector<std::string>& categories, size_t from,
                               const std::string& repoId = {}) {
    std::unique_lock lock(mutex_);
    std::optional<Event> found;
    cv_.wait_for(lock, kEventTimeout, [&] {
      for (size_t i = from; i < events_.size(); ++i) {
        if (!repoId.empty() && events_[i].repoId != repoId) continue;
        for (const auto& category : categories) {
          const auto& changed = events_[i].changed;
          if (std::find(changed.begin(), changed.end(), category) != changed.end()) {
            found = events_[i];
            return true;
          }
        }
      }
      return false;
    });
    return found;
  }

  std::vector<Event> snapshot() const {
    std::lock_guard lock(mutex_);
    return events_;
  }

 private:
  mutable std::mutex mutex_;
  std::condition_variable cv_;
  std::vector<Event> events_;
};

class WatchManagerTest : public ::testing::TestWithParam<WatchManager::Backend> {};

TEST_P(WatchManagerTest, ReportsIndexAndCommitChangesWithIncreasingGenerations) {
#ifdef GG_SINGLE_THREADED
  GTEST_SKIP() << "single-threaded build: the watcher is never started (capability watch:false)";
#else
  gg::testing::FixtureRepo fixture;
  Collector collector;
  WatchManager manager(collector.callback(), GetParam());

  const std::string gitdir = (fixture.root() / ".git").string();
  manager.watch("r1", gitdir);
  manager.watch("r1", gitdir);  // idempotent: must not spawn a second watch
  EXPECT_TRUE(manager.isWatching("r1"));
  EXPECT_FALSE(manager.isWatching("r2"));

  fixture.writeFile("watched.txt", "one\n");
  fixture.run("git add watched.txt");
  auto indexEvent = collector.waitFor({"index"}, 0);
  ASSERT_TRUE(indexEvent.has_value()) << "no index change reported after git add";
  EXPECT_EQ(indexEvent->repoId, "r1");

  const size_t afterAdd = collector.snapshot().size();
  fixture.commit("add watched file");
  auto commitEvent = collector.waitFor({"HEAD", "refs"}, afterAdd);
  ASSERT_TRUE(commitEvent.has_value()) << "no HEAD/refs change reported after commit";
  EXPECT_EQ(commitEvent->repoId, "r1");

  const auto events = collector.snapshot();
  ASSERT_FALSE(events.empty());
  EXPECT_EQ(events.front().generation, 1u);
  std::uint64_t previous = 0;
  for (const auto& event : events) {
    EXPECT_GT(event.generation, previous);
    previous = event.generation;
  }
#endif
}

// Linked worktrees live under $GIT_DIR/worktrees, so adding one is a change
// the protocol's 'worktrees' category names.
TEST_P(WatchManagerTest, ReportsWorktreeChanges) {
#ifdef GG_SINGLE_THREADED
  GTEST_SKIP() << "single-threaded build: the watcher is never started (capability watch:false)";
#else
  gg::testing::FixtureRepo fixture;
  Collector collector;
  WatchManager manager(collector.callback(), GetParam());
  manager.watch("r1", (fixture.root() / ".git").string());

  const std::filesystem::path linked =
      fixture.root().parent_path() / (fixture.root().filename().string() + "-wt");
  fixture.run("git worktree add -q -b wt \"" + linked.string() + "\"");
  auto event = collector.waitFor({"worktrees"}, 0);
  std::error_code ec;
  std::filesystem::remove_all(linked, ec);
  ASSERT_TRUE(event.has_value()) << "no worktrees change reported after git worktree add";
  EXPECT_EQ(event->repoId, "r1");
#endif
}

// A linked worktree of a fixture repository on its own new branch, removed
// with its checkout on destruction.
class LinkedWorktree {
 public:
  LinkedWorktree(gg::testing::FixtureRepo& fixture, const std::string& branch)
      : path_(fixture.root().parent_path() / (fixture.root().filename().string() + "-" + branch)),
        commondir_((fixture.root() / ".git").string()) {
    fixture.run("git worktree add -q -b " + branch + " \"" + path_.string() + "\"");
    gitdir_ = gg::testing::gitCapture(path_, "rev-parse --absolute-git-dir");
    while (!gitdir_.empty() && (gitdir_.back() == '\n' || gitdir_.back() == '\r')) {
      gitdir_.pop_back();
    }
  }

  ~LinkedWorktree() {
    std::error_code ec;
    std::filesystem::remove_all(path_, ec);
  }

  const std::filesystem::path& path() const { return path_; }
  // $GIT_DIR/worktrees/<name>: HEAD, index and sequencer state only.
  const std::string& gitdir() const { return gitdir_; }
  // The main checkout's .git, which holds the shared refs.
  const std::string& commondir() const { return commondir_; }

  void writeFile(const std::string& name, const std::string& contents) const {
    std::ofstream out(path_ / name, std::ios::binary);
    out << contents;
  }

 private:
  std::filesystem::path path_;
  std::string gitdir_;
  std::string commondir_;
};

bool mentions(const Event& event, const std::string& category) {
  return std::find(event.changed.begin(), event.changed.end(), category) != event.changed.end();
}

// Branches, tags and the stash of a linked worktree live in the common dir,
// not in its own gitdir, and still have to be reported for it.
TEST_P(WatchManagerTest, ReportsSharedRefChangesForALinkedWorktree) {
#ifdef GG_SINGLE_THREADED
  GTEST_SKIP() << "single-threaded build: the watcher is never started (capability watch:false)";
#else
  gg::testing::FixtureRepo fixture;
  LinkedWorktree linked(fixture, "wt-refs");
  ASSERT_NE(linked.gitdir().find("worktrees"), std::string::npos) << linked.gitdir();
  Collector collector;
  WatchManager manager(collector.callback(), GetParam());
  manager.watch("r2", linked.gitdir(), linked.commondir());

  fixture.run("git branch from-main");
  ASSERT_TRUE(collector.waitFor({"refs"}, 0, "r2").has_value())
      << "no refs change reported for a branch created from the main checkout";

  size_t from = collector.snapshot().size();
  fixture.run("git tag v1");
  ASSERT_TRUE(collector.waitFor({"refs"}, from, "r2").has_value())
      << "no refs change reported for a new tag";

  from = collector.snapshot().size();
  gg::testing::runGit(linked.path(), "git commit -q --allow-empty -m linked-commit");
  ASSERT_TRUE(collector.waitFor({"refs"}, from, "r2").has_value())
      << "no refs change reported for a commit made in the linked worktree";

  from = collector.snapshot().size();
  linked.writeFile("README.md", "stashed edit\n");
  gg::testing::runGit(linked.path(), "git stash -q");
  ASSERT_TRUE(collector.waitFor({"stash"}, from, "r2").has_value())
      << "no stash change reported for a stash made in the linked worktree";
#endif
}

// The common dir's HEAD and index belong to the main checkout.
TEST_P(WatchManagerTest, DoesNotReportTheMainCheckoutsIndexForALinkedWorktree) {
#ifdef GG_SINGLE_THREADED
  GTEST_SKIP() << "single-threaded build: the watcher is never started (capability watch:false)";
#else
  gg::testing::FixtureRepo fixture;
  LinkedWorktree linked(fixture, "wt-index");
  Collector collector;
  WatchManager manager(collector.callback(), GetParam());
  manager.watch("r2", linked.gitdir(), linked.commondir());

  fixture.writeFile("main-only.txt", "main\n");
  fixture.run("git add main-only.txt");
  // A shared ref change after the index write: once it is reported, any
  // report of the index write has been delivered too.
  fixture.run("git branch fence");
  ASSERT_TRUE(collector.waitFor({"refs"}, 0, "r2").has_value());
  for (const auto& event : collector.snapshot()) {
    if (event.repoId != "r2") continue;
    EXPECT_FALSE(mentions(event, "index")) << "main checkout's index reported for the worktree";
    EXPECT_FALSE(mentions(event, "HEAD")) << "main checkout's HEAD reported for the worktree";
  }
#endif
}

// A main checkout and its linked worktree watch the same directories; each
// keeps its notifications, and unwatching one leaves the other intact.
TEST_P(WatchManagerTest, KeepsSharedDirectoriesWatchedForEveryRepository) {
#ifdef GG_SINGLE_THREADED
  GTEST_SKIP() << "single-threaded build: the watcher is never started (capability watch:false)";
#else
  gg::testing::FixtureRepo fixture;
  LinkedWorktree linked(fixture, "wt-both");
  Collector collector;
  WatchManager manager(collector.callback(), GetParam());
  manager.watch("r1", linked.commondir());
  manager.watch("r2", linked.gitdir(), linked.commondir());

  fixture.run("git branch seen-by-both");
  ASSERT_TRUE(collector.waitFor({"refs"}, 0, "r1").has_value()) << "main checkout missed it";
  ASSERT_TRUE(collector.waitFor({"refs"}, 0, "r2").has_value()) << "linked worktree missed it";

  manager.unwatch("r2");
  EXPECT_FALSE(manager.isWatching("r2"));
  const size_t from = collector.snapshot().size();
  fixture.run("git branch after-unwatch");
  ASSERT_TRUE(collector.waitFor({"refs"}, from, "r1").has_value())
      << "unwatching the linked worktree stopped the main checkout's notifications";
#endif
}

// Waits until the repository's polling watch has run `count` more sweeps.
void awaitSweeps(const WatchManager& manager, const std::string& repoId, std::uint64_t count) {
  const auto start = manager.lastSweepCost(repoId);
  const std::uint64_t target = (start ? start->sweeps : 0) + count;
  for (int i = 0; i < 500; ++i) {
    const auto cost = manager.lastSweepCost(repoId);
    if (cost && cost->sweeps >= target) return;
    std::this_thread::sleep_for(10ms);
  }
  ADD_FAILURE() << "the polling watch stopped sweeping";
}

// A sweep stats the directories under refs/, not every loose ref, so its
// cost does not grow with the number of fetched branches.
TEST(PollingWatch, SweepCostFollowsRefDirectoriesNotRefs) {
#ifdef GG_SINGLE_THREADED
  GTEST_SKIP() << "single-threaded build: the watcher is never started (capability watch:false)";
#else
  gg::testing::FixtureRepo fixture;
  const std::string head = gg::testing::gitLines(fixture.root(), "rev-parse HEAD").at(0);
  const auto remote = fixture.root() / ".git" / "refs" / "remotes" / "origin";
  std::filesystem::create_directories(remote);
  for (int i = 0; i < 400; ++i) {
    std::ofstream(remote / ("branch-" + std::to_string(i)), std::ios::binary) << head << "\n";
  }
  // Fetched a while ago: a directory changed within the racy window is
  // listed on every sweep until it is older. Where a directory's mtime
  // cannot be set, the window is waited out instead.
  std::error_code ec;
  std::filesystem::last_write_time(
      remote, std::filesystem::file_time_type::clock::now() - std::chrono::minutes(1), ec);
  if (ec) std::this_thread::sleep_for(WatchManager::PollTiming().racyWindow + 200ms);
  Collector collector;
  WatchManager::PollTiming timing;
  timing.active = 20ms;
  timing.idle = 20ms;
  timing.fullSweep = std::chrono::hours(1);
  WatchManager manager(collector.callback(), WatchManager::Backend::kPolling, timing);
  manager.watch("r1", (fixture.root() / ".git").string());

  std::optional<SweepCost> cost;
  for (int i = 0; i < 250 && !(cost && cost->sweeps >= 3); ++i) {
    std::this_thread::sleep_for(20ms);
    cost = manager.lastSweepCost("r1");
  }
  ASSERT_TRUE(cost.has_value());
  EXPECT_FALSE(cost->full);
  EXPECT_LT(cost->entries, 40u) << "a quiet sweep examined every loose ref";

  // The sweep still notices a new ref among them.
  fixture.run("git update-ref refs/remotes/origin/branch-new HEAD");
  EXPECT_TRUE(collector.waitFor({"refs"}, 0).has_value());
#endif
}

TEST(PollingWatch, ReportsRefsInNewDirectoriesDeletionsAndPacking) {
#ifdef GG_SINGLE_THREADED
  GTEST_SKIP() << "single-threaded build: the watcher is never started (capability watch:false)";
#else
  gg::testing::FixtureRepo fixture;
  Collector collector;
  WatchManager::PollTiming timing;
  timing.active = 50ms;
  timing.idle = 50ms;
  timing.fullSweep = std::chrono::hours(1);
  WatchManager manager(collector.callback(), WatchManager::Backend::kPolling, timing);
  manager.watch("r1", (fixture.root() / ".git").string());

  fixture.run("git branch feature/deep/topic");
  ASSERT_TRUE(collector.waitFor({"refs"}, 0).has_value()) << "branch in a new directory";

  size_t from = collector.snapshot().size();
  fixture.run("git update-ref refs/heads/feature/deep/topic HEAD~0");
  fixture.run("git branch -D -q feature/deep/topic");
  ASSERT_TRUE(collector.waitFor({"refs"}, from).has_value()) << "deleted branch";

  from = collector.snapshot().size();
  fixture.run("git tag v1");
  fixture.run("git pack-refs --all");
  ASSERT_TRUE(collector.waitFor({"refs"}, from).has_value()) << "tag packed into packed-refs";

  from = collector.snapshot().size();
  fixture.writeFile("README.md", "stashed\n");
  fixture.run("git stash -q");
  const auto stash = collector.waitFor({"stash"}, from);
  ASSERT_TRUE(stash.has_value()) << "stash push";
#endif
}

// Tools other than git may rewrite a loose ref in place, which leaves its
// directory's mtime alone; the full sweep still finds it.
TEST(PollingWatch, FullSweepFindsARefRewrittenInPlace) {
#ifdef GG_SINGLE_THREADED
  GTEST_SKIP() << "single-threaded build: the watcher is never started (capability watch:false)";
#else
  gg::testing::FixtureRepo fixture;
  fixture.commit("second");
  const std::string previous = gg::testing::gitLines(fixture.root(), "rev-parse HEAD~1").at(0);
  fixture.run("git branch moved-in-place");
  const auto ref = fixture.root() / ".git" / "refs" / "heads" / "moved-in-place";
  std::filesystem::last_write_time(
      ref, std::filesystem::file_time_type::clock::now() - std::chrono::minutes(1));
  Collector collector;
  WatchManager::PollTiming timing;
  timing.active = 50ms;
  timing.idle = 50ms;
  timing.fullSweep = 300ms;
  // Only the full sweep may find it, not a listing of a recently changed
  // directory or a check of a recently written ref's content.
  timing.racyWindow = 0ms;
  WatchManager manager(collector.callback(), WatchManager::Backend::kPolling, timing);
  manager.watch("r1", (fixture.root() / ".git").string());
  awaitSweeps(manager, "r1", 1);

  {
    std::fstream file(ref, std::ios::in | std::ios::out | std::ios::binary);
    ASSERT_TRUE(file.is_open());
    file.seekp(0);
    file << previous << "\n";
  }
  EXPECT_TRUE(collector.waitFor({"refs"}, 0).has_value());
#endif
}

// On a filesystem with coarse timestamps (HFS+, FAT, NTFS's timer tick) git
// can create a ref's lock file, which a sweep then lists, and rename it over
// the ref within the same tick, leaving the directory's mtime where the
// listing saw it. The rename is still reported well before the full sweep.
TEST(PollingWatch, ReportsARefRenamedInTheSameTimestampTickAsItsLockFile) {
#ifdef GG_SINGLE_THREADED
  GTEST_SKIP() << "single-threaded build: the watcher is never started (capability watch:false)";
#else
  namespace fs = std::filesystem;
  gg::testing::FixtureRepo fixture;
  const std::string head = gg::testing::gitLines(fixture.root(), "rev-parse HEAD").at(0);
  const fs::path heads = fixture.root() / ".git" / "refs" / "heads";
  Collector collector;
  WatchManager::PollTiming timing;
  timing.active = 20ms;
  timing.idle = 20ms;
  timing.fullSweep = std::chrono::hours(1);
  WatchManager manager(collector.callback(), WatchManager::Backend::kPolling, timing);
  manager.watch("r1", (fixture.root() / ".git").string());
  awaitSweeps(manager, "r1", 2);

  // One tick of a coarse clock: every change below leaves this mtime.
  const fs::file_time_type tick = fs::file_time_type::clock::now();
  std::ofstream(heads / "topic.lock", std::ios::binary) << head << "\n";
  std::error_code ec;
  fs::last_write_time(heads, tick, ec);
  if (ec) GTEST_SKIP() << "cannot set a directory's mtime here: " << ec.message();
  awaitSweeps(manager, "r1", 2);
  const size_t from = collector.snapshot().size();

  fs::rename(heads / "topic.lock", heads / "topic");
  fs::last_write_time(heads, tick, ec);
  ASSERT_FALSE(ec) << ec.message();
  const auto event = collector.waitFor({"refs"}, from);
  EXPECT_TRUE(event.has_value()) << "the ref renamed into place went unreported";
#endif
}

// A ref written twice within one tick of a coarse clock keeps its mtime, and
// a loose ref's size never changes; its content still tells the second write
// from the first.
TEST(PollingWatch, ReportsARefWrittenTwiceInTheSameTimestampTick) {
#ifdef GG_SINGLE_THREADED
  GTEST_SKIP() << "single-threaded build: the watcher is never started (capability watch:false)";
#else
  namespace fs = std::filesystem;
  gg::testing::FixtureRepo fixture;
  fixture.commit("second");
  const std::string previous = gg::testing::gitLines(fixture.root(), "rev-parse HEAD~1").at(0);
  fixture.run("git branch rewritten");
  const fs::path ref = fixture.root() / ".git" / "refs" / "heads" / "rewritten";
  const fs::file_time_type tick = fs::file_time_type::clock::now();
  fs::last_write_time(ref, tick);
  Collector collector;
  WatchManager::PollTiming timing;
  timing.active = 20ms;
  timing.idle = 20ms;
  timing.fullSweep = 100ms;
  WatchManager manager(collector.callback(), WatchManager::Backend::kPolling, timing);
  manager.watch("r1", (fixture.root() / ".git").string());
  awaitSweeps(manager, "r1", 2);
  const size_t from = collector.snapshot().size();

  {
    std::fstream file(ref, std::ios::in | std::ios::out | std::ios::binary);
    ASSERT_TRUE(file.is_open());
    file.seekp(0);
    file << previous << "\n";
  }
  fs::last_write_time(ref, tick);
  EXPECT_TRUE(collector.waitFor({"refs"}, from).has_value())
      << "the second write in the same tick went unreported";
#endif
}

// std::filesystem reads narrow strings in the ANSI code page on Windows; the
// gitdir arrives as UTF-8.
TEST(PollingWatch, WatchesAGitdirWhosePathIsNotAscii) {
#ifdef GG_SINGLE_THREADED
  GTEST_SKIP() << "single-threaded build: the watcher is never started (capability watch:false)";
#else
  namespace fs = std::filesystem;
  gg::testing::FixtureRepo fixture;
  const std::string head = gg::testing::gitLines(fixture.root(), "rev-parse HEAD").at(0);
  const fs::path moved = fixture.root() / fs::path(u8"J\u00f6rg-\u6e29");
  fs::create_directories(moved);
  fs::rename(fixture.root() / ".git", moved / ".git");
  const std::u8string gitdir = (moved / ".git").u8string();
  Collector collector;
  WatchManager::PollTiming timing;
  timing.active = 20ms;
  timing.idle = 20ms;
  timing.fullSweep = std::chrono::hours(1);
  WatchManager manager(collector.callback(), WatchManager::Backend::kPolling, timing);
  manager.watch("r1", std::string(gitdir.begin(), gitdir.end()));
  awaitSweeps(manager, "r1", 2);

  std::ofstream(moved / ".git" / "refs" / "heads" / "topic", std::ios::binary) << head << "\n";
  EXPECT_TRUE(collector.waitFor({"refs"}, 0).has_value()) << "no refs change reported";
#endif
}

TEST(PollingWatch, BacksOffWhileNothingChanges) {
#ifdef GG_SINGLE_THREADED
  GTEST_SKIP() << "single-threaded build: the watcher is never started (capability watch:false)";
#else
  gg::testing::FixtureRepo fixture;
  Collector collector;
  WatchManager::PollTiming timing;
  timing.active = 25ms;
  timing.idle = 400ms;
  timing.idleAfter = 150ms;
  timing.fullSweep = std::chrono::hours(1);
  WatchManager manager(collector.callback(), WatchManager::Backend::kPolling, timing);
  manager.watch("r1", (fixture.root() / ".git").string());

  std::this_thread::sleep_for(1500ms);
  const auto quiet = manager.lastSweepCost("r1");
  ASSERT_TRUE(quiet.has_value());
  // About 6 sweeps at the active pace, then one per 400 ms; without the
  // back-off it would be about 60.
  EXPECT_LE(quiet->sweeps, 20u);

  // A change is still reported, and the pace picks up again.
  fixture.run("git branch wake-up");
  ASSERT_TRUE(collector.waitFor({"refs"}, 0).has_value());
  const auto woken = manager.lastSweepCost("r1");
  std::this_thread::sleep_for(100ms);
  const auto after = manager.lastSweepCost("r1");
  ASSERT_TRUE(woken.has_value() && after.has_value());
  EXPECT_GE(after->sweeps, woken->sweeps + 2) << "no faster sweeps after a change";
#endif
}

INSTANTIATE_TEST_SUITE_P(
    Backends, WatchManagerTest,
    ::testing::Values(WatchManager::Backend::kAuto, WatchManager::Backend::kPolling),
    [](const ::testing::TestParamInfo<WatchManager::Backend>& info) {
      return info.param == WatchManager::Backend::kPolling ? "Polling" : "Auto";
    });

}  // namespace
}  // namespace gg::watch
