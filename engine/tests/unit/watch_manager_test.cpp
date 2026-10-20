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

  const std::filesystem::path linked = fixture.root().parent_path() /
                                       (fixture.root().filename().string() + "-wt");
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
      : path_(fixture.root().parent_path() /
              (fixture.root().filename().string() + "-" + branch)),
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

INSTANTIATE_TEST_SUITE_P(
    Backends, WatchManagerTest,
    ::testing::Values(WatchManager::Backend::kAuto, WatchManager::Backend::kPolling),
    [](const ::testing::TestParamInfo<WatchManager::Backend>& info) {
      return info.param == WatchManager::Backend::kPolling ? "Polling" : "Auto";
    });

}  // namespace
}  // namespace gg::watch
