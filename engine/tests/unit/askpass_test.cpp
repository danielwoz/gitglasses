// Credential prompts: the prompt parser, the broker and its shim, and the
// whole path from a git invocation to the client and back. The test binary
// doubles as the shim (see test_main.cpp), so git and ssh run it exactly as
// they run the engine.

#include "exec/askpass.h"

#include <gtest/gtest.h>
#include <nlohmann/json.hpp>

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <filesystem>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#ifndef _WIN32
#include <sys/stat.h>
#endif

#include "exec/git_runner.h"
#include "test_fixtures.h"
#include "test_session.h"
#include "util/request_context.h"

namespace gg {
namespace {

using Json = nlohmann::json;
using exec::AskpassAnswer;
using exec::AskpassBroker;
using exec::AskpassKind;
using exec::AskpassOrigin;
using exec::AskpassPrompt;
using gg::testing::FixtureRepo;
using gg::testing::InteractiveSession;
using gg::testing::ScopedEnv;

Json req(std::int64_t id, const std::string& method, Json params) {
  return {{"jsonrpc", "2.0"}, {"id", id}, {"method", method}, {"params", std::move(params)}};
}

// --- Prompt parsing -------------------------------------------------------------------

TEST(AskpassPrompt, ReadsGitCredentialPrompts) {
  const AskpassPrompt user = exec::classifyAskpassPrompt("Username for 'https://github.com': ", "");
  EXPECT_EQ(user.kind, AskpassKind::Username);
  EXPECT_FALSE(user.secret);
  EXPECT_EQ(user.protocol, "https");
  EXPECT_EQ(user.host, "github.com");

  const AskpassPrompt password =
      exec::classifyAskpassPrompt("Password for 'https://alice@git.example.com:8443': ", "");
  EXPECT_EQ(password.kind, AskpassKind::Password);
  EXPECT_TRUE(password.secret);
  EXPECT_EQ(password.username, "alice");
  EXPECT_EQ(password.host, "git.example.com");
}

TEST(AskpassPrompt, ReadsSshPrompts) {
  const AskpassPrompt hostKey = exec::classifyAskpassPrompt(
      "The authenticity of host '[127.0.0.1]:2222 ([127.0.0.1]:2222)' can't be established.\n"
      "ED25519 key fingerprint is SHA256:owhjl/OQJmEPHrjACEHcYf4Tpr+4KimMQLLD6cDGDyM.\n"
      "This key is not known by any other names.\n"
      "Are you sure you want to continue connecting (yes/no/[fingerprint])? ",
      "");
  EXPECT_EQ(hostKey.kind, AskpassKind::HostKey);
  EXPECT_FALSE(hostKey.secret);
  EXPECT_EQ(hostKey.host, "[127.0.0.1]:2222");
  EXPECT_EQ(hostKey.fingerprint, "SHA256:owhjl/OQJmEPHrjACEHcYf4Tpr+4KimMQLLD6cDGDyM");

  const AskpassPrompt passphrase =
      exec::classifyAskpassPrompt("Enter passphrase for key '/home/a/.ssh/id_ed25519': ", "");
  EXPECT_EQ(passphrase.kind, AskpassKind::Passphrase);
  EXPECT_TRUE(passphrase.secret);
  EXPECT_EQ(exec::classifyAskpassPrompt("Enter passphrase: ", "").kind, AskpassKind::Passphrase);
  EXPECT_EQ(exec::classifyAskpassPrompt("Enter PIN for ECDSA-SK key: ", "").kind,
            AskpassKind::Passphrase);

  const AskpassPrompt sshPassword = exec::classifyAskpassPrompt("git@example.org's password: ", "");
  EXPECT_EQ(sshPassword.kind, AskpassKind::Password);
  EXPECT_EQ(sshPassword.username, "git");
  EXPECT_EQ(sshPassword.host, "example.org");
  const AskpassPrompt keyboard = exec::classifyAskpassPrompt("(bob@build.lan) Password: ", "");
  EXPECT_EQ(keyboard.kind, AskpassKind::Password);
  EXPECT_EQ(keyboard.host, "build.lan");
}

TEST(AskpassPrompt, HintsFromTheShimDecideTheKind) {
  EXPECT_EQ(exec::classifyAskpassPrompt("Allow use of key?", "confirm").kind, AskpassKind::Confirm);
  EXPECT_EQ(exec::classifyAskpassPrompt("Passphrase for the OpenPGP key ABC", "gpg").kind,
            AskpassKind::Passphrase);
  // An unknown prompt is masked: it may well be a secret.
  const AskpassPrompt unknown = exec::classifyAskpassPrompt("Token: ", "");
  EXPECT_EQ(unknown.kind, AskpassKind::Other);
  EXPECT_TRUE(unknown.secret);
}

TEST(AskpassEnvironment, OnlyOpenSshBefore84NeedsADisplay) {
  EXPECT_TRUE(exec::sshNeedsDisplayForAskpass(
      "OpenSSH_8.2p1 Ubuntu-4ubuntu0.5, OpenSSL 1.1.1f  31 Mar 2020"));
  EXPECT_TRUE(exec::sshNeedsDisplayForAskpass("OpenSSH_8.0p1, OpenSSL 1.1.1k  FIPS 25 Mar 2021"));
  EXPECT_TRUE(exec::sshNeedsDisplayForAskpass("OpenSSH_7.4p1, OpenSSL 1.0.2k-fips  26 Jan 2017"));
  EXPECT_TRUE(exec::sshNeedsDisplayForAskpass("OpenSSH_for_Windows_8.1p1, LibreSSL 3.0.2"));
  EXPECT_FALSE(exec::sshNeedsDisplayForAskpass(
      "OpenSSH_8.4p1 Debian-5+deb11u3, OpenSSL 1.1.1w  11 Sep 2023"));
  EXPECT_FALSE(exec::sshNeedsDisplayForAskpass(
      "OpenSSH_9.6p1 Ubuntu-3ubuntu13.5, OpenSSL 3.0.13 30 Jan 2024"));
  EXPECT_FALSE(exec::sshNeedsDisplayForAskpass("OpenSSH_10.0p2, OpenSSL 3.5.0 8 Apr 2025"));
  EXPECT_FALSE(exec::sshNeedsDisplayForAskpass(""));
  EXPECT_FALSE(exec::sshNeedsDisplayForAskpass("Dropbear v2022.83"));
  EXPECT_FALSE(exec::sshNeedsDisplayForAskpass("OpenSSH_x, OpenSSL 1.1.1"));
}

TEST(AskpassPrompt, OnlyUserActionsPromptInteractively) {
  EXPECT_TRUE(exec::askpassInteractiveMethod("mutate/push"));
  EXPECT_TRUE(exec::askpassInteractiveMethod("mutate/commit"));
  EXPECT_TRUE(exec::askpassInteractiveMethod("rebase/continue"));
  EXPECT_FALSE(exec::askpassInteractiveMethod("blame/file"));
  EXPECT_FALSE(exec::askpassInteractiveMethod("history/file"));
  EXPECT_FALSE(exec::askpassInteractiveMethod(""));
}

// --- Broker and shim ------------------------------------------------------------------

// Points the calling process's shim client at a session, as the git
// environment would.
struct ShimEnvironment {
  ShimEnvironment(const AskpassBroker& broker, const exec::AskpassSession& session)
      : endpoint(exec::kAskpassEndpointVar, broker.endpoint()),
        token(exec::kAskpassTokenVar, tokenOf(session)) {}

  static std::string tokenOf(const exec::AskpassSession& session) {
    for (const std::string& entry : exec::askpassEnvironment(session)) {
      const std::string prefix = std::string(exec::kAskpassTokenVar) + "=";
      if (entry.rfind(prefix, 0) == 0) return entry.substr(prefix.size());
    }
    return {};
  }

  ScopedEnv endpoint;
  ScopedEnv token;
};

TEST(AskpassBroker, AnswersAShimThroughTheHandler) {
  std::mutex mutex;
  std::vector<std::pair<AskpassPrompt, AskpassOrigin>> seen;
  auto broker = AskpassBroker::start(
      [&](const AskpassPrompt& prompt, const AskpassOrigin& origin, const auto&) {
        std::lock_guard lock(mutex);
        seen.emplace_back(prompt, origin);
        return AskpassAnswer{true, "s3cret", false};
      });
  ASSERT_NE(broker, nullptr);
  AskpassOrigin origin;
  origin.requestId = 7;
  origin.method = "mutate/push";
  origin.repoId = "r1";
  origin.interactive = true;
  const auto session = broker->openSession(origin);
  const ShimEnvironment env(*broker, *session);

  const auto answer = exec::askThroughBroker("", "Password for 'https://alice@example.com': ");
  ASSERT_TRUE(answer.has_value());
  EXPECT_EQ(*answer, "s3cret");
  std::lock_guard lock(mutex);
  ASSERT_EQ(seen.size(), 1u);
  EXPECT_EQ(seen[0].first.kind, AskpassKind::Password);
  EXPECT_EQ(seen[0].first.host, "example.com");
  EXPECT_EQ(seen[0].second.requestId, 7);
  EXPECT_EQ(seen[0].second.method, "mutate/push");
  EXPECT_TRUE(seen[0].second.interactive);
}

TEST(AskpassBroker, RefusesAnUnknownToken) {
  std::atomic<int> calls{0};
  auto broker = AskpassBroker::start([&](const auto&, const auto&, const auto&) {
    ++calls;
    return AskpassAnswer{true, "leaked", false};
  });
  ASSERT_NE(broker, nullptr);
  const auto session = broker->openSession({});
  const ScopedEnv endpoint(exec::kAskpassEndpointVar, broker->endpoint());
  const ScopedEnv token(exec::kAskpassTokenVar, "0123456789abcdef0123456789abcdef");
  EXPECT_FALSE(exec::askThroughBroker("", "Password: ").has_value());
  EXPECT_EQ(calls.load(), 0);
}

TEST(AskpassBroker, StopsAnsweringOnceTheSessionEnds) {
  std::atomic<int> calls{0};
  auto broker = AskpassBroker::start([&](const auto&, const auto&, const auto&) {
    ++calls;
    return AskpassAnswer{true, "late", false};
  });
  ASSERT_NE(broker, nullptr);
  auto session = broker->openSession({});
  const ShimEnvironment env(*broker, *session);
  session.reset();
  EXPECT_FALSE(exec::askThroughBroker("", "Password: ").has_value());
  EXPECT_EQ(calls.load(), 0);
}

// A prompt git stopped waiting for is withdrawn: the handler sees it
// abandoned and the shim gets no answer.
TEST(AskpassBroker, WithdrawsAPromptWhenTheInvocationEnds) {
  std::mutex mutex;
  std::condition_variable cv;
  bool asked = false;
  std::atomic<bool> sawAbandoned{false};
  auto broker =
      AskpassBroker::start([&](const auto&, const auto&, const std::function<bool()>& abandoned) {
        {
          std::lock_guard lock(mutex);
          asked = true;
        }
        cv.notify_all();
        const auto giveUp = std::chrono::steady_clock::now() + std::chrono::seconds(10);
        while (!abandoned() && std::chrono::steady_clock::now() < giveUp) {
          std::this_thread::sleep_for(std::chrono::milliseconds(10));
        }
        sawAbandoned = abandoned();
        return AskpassAnswer{true, "too late", false};
      });
  ASSERT_NE(broker, nullptr);
  auto session = broker->openSession({});
  const ShimEnvironment env(*broker, *session);

  std::optional<std::string> answer = std::string("unset");
  std::thread shim([&] { answer = exec::askThroughBroker("", "Password: "); });
  {
    std::unique_lock lock(mutex);
    ASSERT_TRUE(cv.wait_for(lock, std::chrono::seconds(10), [&] { return asked; }));
  }
  session.reset();
  shim.join();
  EXPECT_TRUE(sawAbandoned.load());
  EXPECT_FALSE(answer.has_value());
}

#ifndef _WIN32
TEST(AskpassBroker, ListensInADirectoryOnlyTheUserCanEnter) {
  auto broker =
      AskpassBroker::start([](const auto&, const auto&, const auto&) { return AskpassAnswer{}; });
  ASSERT_NE(broker, nullptr);
  const std::filesystem::path socket(broker->endpoint());
  struct stat info{};
  ASSERT_EQ(stat(socket.parent_path().c_str(), &info), 0);
  EXPECT_EQ(info.st_mode & 0777, 0700u);
  EXPECT_LT(broker->endpoint().size(), 104u);
  const std::filesystem::path directory = socket.parent_path();
  broker.reset();
  EXPECT_FALSE(std::filesystem::exists(directory)) << "the endpoint outlived the broker";
}
#endif

#if !defined(_WIN32) && !defined(__APPLE__)
TEST(AskpassEnvironment, ReadsTheVersionOfTheSshOnPath) {
  FixtureRepo fixture;
  fixture.writeFile("bin/ssh",
                    "#!/bin/sh\necho 'OpenSSH_8.2p1 Ubuntu-4ubuntu0.5, OpenSSL 1.1.1f' >&2\n");
  std::filesystem::permissions(fixture.root() / "bin" / "ssh", std::filesystem::perms::owner_all);
  const ScopedEnv path("PATH", (fixture.root() / "bin").string() + ":/usr/bin:/bin");
  EXPECT_EQ(exec::sshVersionOnPath(), "OpenSSH_8.2p1 Ubuntu-4ubuntu0.5, OpenSSL 1.1.1f");
  const ScopedEnv nothing("PATH", (fixture.root() / "nowhere").string());
  EXPECT_EQ(exec::sshVersionOnPath(), "");
}

// Without a display, git gets the placeholder DISPLAY only when the ssh it
// runs needs one: anything else git starts (a pinentry, a credential
// manager) must not be pointed at a display that is not the user's.
TEST(AskpassEnvironment, SetsADisplayOnlyForAnSshThatNeedsOne) {
  auto broker =
      AskpassBroker::start([](const auto&, const auto&, const auto&) { return AskpassAnswer{}; });
  ASSERT_NE(broker, nullptr);
  const ScopedEnv display("DISPLAY", "");
  const auto session = broker->openSession({});
  bool hasDisplay = false;
  for (const std::string& entry : exec::askpassEnvironment(*session)) {
    hasDisplay = hasDisplay || entry.rfind("DISPLAY=", 0) == 0;
  }
  EXPECT_EQ(hasDisplay, exec::localSshNeedsDisplay()) << exec::sshVersionOnPath();
}
#endif

// --- Through git ----------------------------------------------------------------------

#ifndef _WIN32

// A stand-in for ssh: asks for a key passphrase through SSH_ASKPASS the way
// ssh does, then serves the repository locally. Wrong or missing answers fail
// like a refused key.
void writeFakeSsh(FixtureRepo& fixture, const std::string& passphrase, int delayMs = 0) {
  std::string script =
      "#!/bin/sh\n"
      "answer=$(\"$SSH_ASKPASS\" \"Enter passphrase for key '/fake/id_ed25519': \")\n"
      "[ \"$answer\" = \"" +
      passphrase +
      "\" ] || { echo 'git@fakehost: Permission denied (publickey).' >&2; exit 255; }\n";
  if (delayMs > 0) script += "sleep " + std::to_string(delayMs / 1000.0) + "\n";
  script += "shift\nexec sh -c \"$1\"\n";
  fixture.writeFile("fake-ssh", script);
  std::filesystem::permissions(fixture.root() / "fake-ssh", std::filesystem::perms::owner_all);
}

// A repository whose origin is reached over the fake ssh.
struct SshRemoteRepo {
  FixtureRepo fixture;
  ScopedEnv sshCommand;
  ScopedEnv variant{"GIT_SSH_VARIANT", "simple"};

  explicit SshRemoteRepo(const std::string& passphrase)
      : sshCommand("GIT_SSH_COMMAND", (fixture.root() / "fake-ssh").string()) {
    writeFakeSsh(fixture, passphrase);
    fixture.run("git clone --bare -q . upstream.git");
    fixture.run("git remote add origin \"fakehost:" + (fixture.root() / "upstream.git").string() +
                "\"");
    fixture.writeFile("work.txt", "work\n");
    fixture.run("git add work.txt");
    fixture.commit("local work");
  }
};

TEST(AskpassThroughGit, PushPromptsTheClientAndSucceeds) {
  SshRemoteRepo repo("letmein");
  InteractiveSession session;
  session.onEngineRequest = [](const Json& request) -> Json {
    if (request["params"].value("kind", "") == "passphrase") return {{"value", "letmein"}};
    return {{"cancelled", true}};
  };
  session.request(gg::testing::initAskpassRequest(1));
  const Json discover =
      session.request(req(2, "repo/discover", {{"path", repo.fixture.root().string()}}));
  const std::string repoId = discover["result"]["repoId"];

  const Json push =
      session.request(req(3, "mutate/push", {{"repoId", repoId}, {"setUpstream", true}}));
  ASSERT_TRUE(push.contains("result")) << push.dump();
  EXPECT_EQ(push["result"]["remote"], "origin");
  ASSERT_EQ(session.engineRequests.size(), 1u);
  const Json& prompt = session.engineRequests[0];
  EXPECT_EQ(prompt["method"], "ui/askpass");
  EXPECT_TRUE(prompt["id"].is_string());
  EXPECT_EQ(prompt["params"]["kind"], "passphrase");
  EXPECT_EQ(prompt["params"]["requestId"], 3);
  EXPECT_EQ(prompt["params"]["method"], "mutate/push");
  EXPECT_EQ(prompt["params"]["repoId"], repoId);
  EXPECT_TRUE(prompt["params"]["secret"].get<bool>());
  EXPECT_TRUE(prompt["params"]["interactive"].get<bool>());
  EXPECT_EQ(gg::testing::gitCapture(repo.fixture.root() / "upstream.git", "rev-parse main"),
            gg::testing::gitCapture(repo.fixture.root(), "rev-parse HEAD"));
}

TEST(AskpassThroughGit, ADismissedPromptFailsAsCancelled) {
  SshRemoteRepo repo("letmein");
  InteractiveSession session;
  session.onEngineRequest = [](const Json&) -> Json { return {{"cancelled", true}}; };
  session.request(gg::testing::initAskpassRequest(1));
  const Json discover =
      session.request(req(2, "repo/discover", {{"path", repo.fixture.root().string()}}));
  const Json fetch =
      session.request(req(3, "mutate/fetch", {{"repoId", discover["result"]["repoId"]}}));
  ASSERT_TRUE(fetch.contains("error")) << fetch.dump();
  EXPECT_EQ(fetch["error"]["code"], static_cast<int>(ErrorCode::GitError));
  EXPECT_EQ(fetch["error"]["data"]["kind"], "cancelled") << fetch.dump();
}

// A client that never said it answers prompts gets none; git fails the way
// it always has without a terminal.
TEST(AskpassThroughGit, AClientWithoutTheCapabilityIsNeverAsked) {
  SshRemoteRepo repo("letmein");
  InteractiveSession session;
  session.request(gg::testing::initRequest(1));
  const Json discover =
      session.request(req(2, "repo/discover", {{"path", repo.fixture.root().string()}}));
  const Json fetch =
      session.request(req(3, "mutate/fetch", {{"repoId", discover["result"]["repoId"]}}));
  ASSERT_TRUE(fetch.contains("error")) << fetch.dump();
  EXPECT_TRUE(session.engineRequests.empty());
  EXPECT_EQ(fetch["error"]["data"]["kind"], "publickey") << fetch.dump();
}

// Reads (blame, history) may need a credential too, when a partial clone
// fetches a missing object; their prompts are marked as background work.
TEST(AskpassThroughGit, PromptsFromReadsAreNotInteractive) {
  SshRemoteRepo repo("letmein");
  InteractiveSession session;
  session.onEngineRequest = [](const Json&) -> Json { return {{"cancelled", true}}; };
  session.request(gg::testing::initAskpassRequest(1));
  session.request(req(2, "repo/discover", {{"path", repo.fixture.root().string()}}));
  // Drives a prompt from a read path directly, as a lazy fetch would.
  std::atomic<bool> done{false};
  int exitCode = 0;
  std::thread reader([&] {
    const ScopedRequestContext context({42, "blame/file", "r1"});
    exec::RunOpts opts;
    CancelToken token;
    auto status = exec::runGit(repo.fixture.root().string(), {"ls-remote", "origin"}, opts, token,
                               [](std::string) {});
    exitCode = status.ok() ? status.value().exitCode : -1;
    done = true;
  });
  // The session answers prompts only while it reads frames, so it keeps
  // sending requests until git is done.
  std::int64_t id = 3;
  const auto giveUp = std::chrono::steady_clock::now() + std::chrono::seconds(20);
  while (!done && std::chrono::steady_clock::now() < giveUp) {
    session.request(req(id++, "repo/list", Json::object()));
    std::this_thread::sleep_for(std::chrono::milliseconds(20));
  }
  reader.join();
  EXPECT_NE(exitCode, 0);
  ASSERT_EQ(session.engineRequests.size(), 1u);
  EXPECT_FALSE(session.engineRequests[0]["params"]["interactive"].get<bool>());
  EXPECT_EQ(session.engineRequests[0]["params"]["method"], "blame/file");
}

// Time the user spends on a prompt does not count against git's timeout.
TEST(AskpassThroughGit, APromptPausesTheGitTimeout) {
  SshRemoteRepo repo("letmein");
  auto broker = AskpassBroker::start([](const auto&, const auto&, const auto&) {
    std::this_thread::sleep_for(std::chrono::milliseconds(1500));
    return AskpassAnswer{true, "letmein", false};
  });
  ASSERT_NE(broker, nullptr);
  exec::installAskpassBroker(broker.get());
  exec::RunOpts opts;
  opts.timeout = std::chrono::milliseconds(800);
  CancelToken token;
  auto status = exec::runGit(repo.fixture.root().string(), {"fetch", "origin"}, opts, token,
                             [](std::string) {});
  exec::installAskpassBroker(nullptr);
  ASSERT_TRUE(status.ok()) << status.error().message;
  EXPECT_EQ(status.value().exitCode, 0) << status.value().stderrText;
}

#endif  // !_WIN32

}  // namespace
}  // namespace gg
