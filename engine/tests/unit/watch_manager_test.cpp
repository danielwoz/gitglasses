#include "watch/watch_manager.h"

#include <gtest/gtest.h>

#include <algorithm>
#include <chrono>
#include <condition_variable>
#include <mutex>
#include <optional>
#include <string>
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

  // Waits for an event at index >= `from` containing any of `categories`.
  std::optional<Event> waitFor(const std::vector<std::string>& categories, size_t from) {
    std::unique_lock lock(mutex_);
    std::optional<Event> found;
    cv_.wait_for(lock, kEventTimeout, [&] {
      for (size_t i = from; i < events_.size(); ++i) {
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

INSTANTIATE_TEST_SUITE_P(
    Backends, WatchManagerTest,
    ::testing::Values(WatchManager::Backend::kAuto, WatchManager::Backend::kPolling),
    [](const ::testing::TestParamInfo<WatchManager::Backend>& info) {
      return info.param == WatchManager::Backend::kPolling ? "Polling" : "Auto";
    });

}  // namespace
}  // namespace gg::watch
