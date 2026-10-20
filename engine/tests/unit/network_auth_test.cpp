// Credential prompts against real servers: an HTTP remote behind Basic auth,
// an sshd with an unknown host key and a passphrase-protected key, and commit
// signing with passphrase-protected ssh and gpg keys. Each test drives the
// engine as the extension does and answers ui/askpass as a user would. The
// servers and tools are the system's own; a test whose tool is missing skips.

#include <gtest/gtest.h>
#include <nlohmann/json.hpp>

#include <atomic>
#include <chrono>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <memory>
#include <optional>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

#ifndef _WIN32
#include <netinet/in.h>
#include <signal.h>
#include <spawn.h>
#include <sys/socket.h>
#include <sys/wait.h>
#include <unistd.h>

extern char** environ;
#endif

#include "test_fixtures.h"
#include "test_session.h"

#ifndef GG_TEST_TOOLS_DIR
#error "GG_TEST_TOOLS_DIR must point at engine/tests/tools"
#endif

namespace gg {
namespace {

#ifndef _WIN32

using Json = nlohmann::json;
using gg::testing::FixtureRepo;
using gg::testing::InteractiveSession;
using gg::testing::ScopedEnv;

Json req(std::int64_t id, const std::string& method, Json params) {
  return {{"jsonrpc", "2.0"}, {"id", id}, {"method", method}, {"params", std::move(params)}};
}

bool onPath(const std::string& tool) {
  return std::system(("command -v " + tool + " > /dev/null 2>&1").c_str()) == 0;
}

std::string slurp(const std::filesystem::path& file) {
  std::ifstream in(file, std::ios::binary);
  std::ostringstream buffer;
  buffer << in.rdbuf();
  return buffer.str();
}

void writeText(const std::filesystem::path& file, const std::string& text) {
  std::ofstream(file, std::ios::binary) << text;
}

// Runs a shell command, asserting success.
void sh(const std::string& command) { ASSERT_EQ(std::system(command.c_str()), 0) << command; }

// Clears a variable for the scope (the agent socket, which would answer for
// the key the test wants a prompt for).
class ScopedUnset {
 public:
  explicit ScopedUnset(std::string name) : name_(std::move(name)) {
    if (const char* old = std::getenv(name_.c_str())) previous_ = old;
    ::unsetenv(name_.c_str());
  }
  ~ScopedUnset() {
    if (previous_) ::setenv(name_.c_str(), previous_->c_str(), 1);
  }

 private:
  std::string name_;
  std::optional<std::string> previous_;
};

// A server process for the length of a test.
class BackgroundProcess {
 public:
  explicit BackgroundProcess(const std::vector<std::string>& argv) {
    std::vector<std::string> args = argv;
    std::vector<char*> raw;
    for (auto& arg : args) raw.push_back(arg.data());
    raw.push_back(nullptr);
    if (posix_spawnp(&pid_, raw[0], nullptr, nullptr, raw.data(), environ) != 0) pid_ = -1;
  }
  ~BackgroundProcess() {
    if (pid_ <= 0) return;
    kill(pid_, SIGTERM);
    waitpid(pid_, nullptr, 0);
  }
  bool running() const { return pid_ > 0; }

 private:
  pid_t pid_ = -1;
};

// A TCP port nothing listens on right now.
int freePort() {
  const int fd = socket(AF_INET, SOCK_STREAM, 0);
  sockaddr_in address{};
  address.sin_family = AF_INET;
  address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  bind(fd, reinterpret_cast<sockaddr*>(&address), sizeof(address));
  socklen_t size = sizeof(address);
  getsockname(fd, reinterpret_cast<sockaddr*>(&address), &size);
  close(fd);
  return ntohs(address.sin_port);
}

bool waitForFile(const std::filesystem::path& file) {
  const auto giveUp = std::chrono::steady_clock::now() + std::chrono::seconds(15);
  while (std::chrono::steady_clock::now() < giveUp) {
    if (std::filesystem::exists(file)) return true;
    std::this_thread::sleep_for(std::chrono::milliseconds(20));
  }
  return false;
}

std::string discover(InteractiveSession& session, const std::filesystem::path& root) {
  session.request(gg::testing::initAskpassRequest(1));
  const Json found = session.request(req(2, "repo/discover", {{"path", root.string()}}));
  return found["result"].value("repoId", "");
}

std::vector<std::string> promptKinds(const InteractiveSession& session) {
  std::vector<std::string> kinds;
  for (const auto& request : session.engineRequests) kinds.push_back(request["params"]["kind"]);
  return kinds;
}

// --- HTTP Basic auth -------------------------------------------------------------------

class BasicAuthRemote : public ::testing::Test {
 protected:
  void SetUp() override {
    if (!onPath("python3")) GTEST_SKIP() << "python3 is not installed";
    root_ = gg::testing::makeTempDir("gg-basicauth-");
    gg::testing::runGit(root_, "git init -q --bare -b main proj.git");
    gg::testing::runGit(root_ / "proj.git", "git config http.receivepack true");
    gg::testing::runGit(fixture_.root(),
                        "git push -q \"" + (root_ / "proj.git").string() + "\" main");
    server_ = std::make_unique<BackgroundProcess>(
        std::vector<std::string>{"python3", std::string(GG_TEST_TOOLS_DIR) + "/basicauth_git.py",
                                 (root_ / "port").string(), root_.string(), "alice", "s3cret"});
    ASSERT_TRUE(server_->running());
    ASSERT_TRUE(waitForFile(root_ / "port")) << "the HTTP server did not start";
    url_ = "http://127.0.0.1:" + slurp(root_ / "port") + "/proj.git";
    fixture_.run("git remote add origin " + url_);
    fixture_.writeFile("work.txt", "work\n");
    fixture_.run("git add work.txt");
    fixture_.commit("local work");
  }

  void TearDown() override {
    server_.reset();
    std::error_code ec;
    if (!root_.empty()) std::filesystem::remove_all(root_, ec);
  }

  FixtureRepo fixture_;
  std::filesystem::path root_;
  std::unique_ptr<BackgroundProcess> server_;
  std::string url_;
  // Credentials must come from the prompt, never from a helper the
  // developer's environment configures.
  ScopedEnv noHelper_{"GIT_CONFIG_COUNT", "1"};
  ScopedEnv noHelperKey_{"GIT_CONFIG_KEY_0", "credential.helper"};
  ScopedEnv noHelperValue_{"GIT_CONFIG_VALUE_0", ""};
};

TEST_F(BasicAuthRemote, PushAndFetchAskForTheCredentialAndSucceed) {
  InteractiveSession session;
  session.onEngineRequest = [](const Json& request) -> Json {
    const std::string kind = request["params"]["kind"];
    if (kind == "username") return {{"value", "alice"}};
    if (kind == "password") return {{"value", "s3cret"}};
    return {{"cancelled", true}};
  };
  const std::string repoId = discover(session, fixture_.root());

  const Json push =
      session.request(req(3, "mutate/push", {{"repoId", repoId}, {"setUpstream", true}}));
  ASSERT_TRUE(push.contains("result")) << push.dump();
  EXPECT_EQ(promptKinds(session), (std::vector<std::string>{"username", "password"}));
  const Json& password = session.engineRequests[1]["params"];
  EXPECT_EQ(password["protocol"], "http");
  EXPECT_EQ(password["host"], "127.0.0.1");
  EXPECT_EQ(password["username"], "alice");
  EXPECT_TRUE(password["secret"].get<bool>());
  EXPECT_EQ(gg::testing::gitCapture(root_ / "proj.git", "rev-parse main"),
            gg::testing::gitCapture(fixture_.root(), "rev-parse HEAD"));

  const Json fetch = session.request(req(4, "mutate/fetch", {{"repoId", repoId}}));
  ASSERT_TRUE(fetch.contains("result")) << fetch.dump();
}

TEST_F(BasicAuthRemote, ARefusedCredentialFailsAsAuth) {
  InteractiveSession session;
  session.onEngineRequest = [](const Json& request) -> Json {
    return {{"value", request["params"]["kind"] == "username" ? "alice" : "wrong"}};
  };
  const std::string repoId = discover(session, fixture_.root());
  const Json fetch = session.request(req(3, "mutate/fetch", {{"repoId", repoId}}));
  ASSERT_TRUE(fetch.contains("error")) << fetch.dump();
  EXPECT_EQ(fetch["error"]["data"]["kind"], "auth") << fetch.dump();
  EXPECT_EQ(fetch["error"]["data"]["host"], "127.0.0.1") << fetch.dump();
}

// --- sshd ---------------------------------------------------------------------------------

TEST(SshServer, AsksToTrustTheHostThenForTheKeyPassphrase) {
  const std::filesystem::path sshd = "/usr/sbin/sshd";
  if (!std::filesystem::exists(sshd) || !onPath("ssh") || !onPath("ssh-keygen")) {
    GTEST_SKIP() << "OpenSSH server or client is not installed";
  }
  const std::filesystem::path dir = gg::testing::makeTempDir("gg-sshd-");
  const std::string d = dir.string();
  sh("ssh-keygen -q -t ed25519 -N '' -f '" + d + "/host_key'");
  sh("ssh-keygen -q -t ed25519 -N keypass -f '" + d + "/id_key'");
  std::filesystem::copy_file(dir / "id_key.pub", dir / "authorized_keys");
  const int port = freePort();
  writeText(dir / "sshd_config",
            "Port " + std::to_string(port) + "\nListenAddress 127.0.0.1\nHostKey " + d +
                "/host_key\nAuthorizedKeysFile " + d +
                "/authorized_keys\nPasswordAuthentication no\nKbdInteractiveAuthentication no\n"
                "PubkeyAuthentication yes\nUsePAM no\nStrictModes no\nPidFile " +
                d + "/sshd.pid\n");
  writeText(dir / "ssh_config", "Host gg-test-sshd\n  HostName 127.0.0.1\n  Port " +
                                    std::to_string(port) + "\n  IdentityFile " + d +
                                    "/id_key\n  IdentitiesOnly yes\n  UserKnownHostsFile " + d +
                                    "/known_hosts\n  GlobalKnownHostsFile /dev/null\n");
  BackgroundProcess server({sshd.string(), "-D", "-f", d + "/sshd_config", "-E", d + "/sshd.log"});
  ASSERT_TRUE(server.running());
  ASSERT_TRUE(waitForFile(dir / "sshd.pid")) << slurp(dir / "sshd.log");

  FixtureRepo fixture;
  fixture.run("git init -q --bare -b main remote.git");
  fixture.run("git remote add origin \"gg-test-sshd:" + (fixture.root() / "remote.git").string() +
              "\"");
  const ScopedEnv sshCommand("GIT_SSH_COMMAND", "ssh -F " + d + "/ssh_config");
  const ScopedUnset agent("SSH_AUTH_SOCK");

  InteractiveSession session;
  session.onEngineRequest = [](const Json& request) -> Json {
    const std::string kind = request["params"]["kind"];
    if (kind == "hostKey") return {{"value", "yes"}};
    if (kind == "passphrase") return {{"value", "keypass"}};
    return {{"cancelled", true}};
  };
  const std::string repoId = discover(session, fixture.root());
  const Json push =
      session.request(req(3, "mutate/push", {{"repoId", repoId}, {"setUpstream", true}}));
  ASSERT_TRUE(push.contains("result")) << push.dump() << slurp(dir / "sshd.log");
  EXPECT_EQ(promptKinds(session), (std::vector<std::string>{"hostKey", "passphrase"}));
  EXPECT_EQ(
      session.engineRequests[0]["params"]["fingerprint"].get<std::string>().rfind("SHA256:", 0),
      0u);

  // The host is known from now on; only the key still asks.
  session.engineRequests.clear();
  const Json fetch = session.request(req(4, "mutate/fetch", {{"repoId", repoId}}));
  ASSERT_TRUE(fetch.contains("result")) << fetch.dump();
  EXPECT_EQ(promptKinds(session), (std::vector<std::string>{"passphrase"}));

  std::error_code ec;
  std::filesystem::remove_all(dir, ec);
}

// --- Signing ----------------------------------------------------------------------------------

TEST(Signing, SshKeyPassphraseIsAskedForAndTheCommitIsSigned) {
  if (!onPath("ssh-keygen")) GTEST_SKIP() << "ssh-keygen is not installed";
  FixtureRepo fixture;
  const std::string key = (fixture.root() / ".git" / "signing_key").string();
  sh("ssh-keygen -q -t ed25519 -N signpass -f '" + key + "'");
  fixture.run("git config gpg.format ssh");
  fixture.run("git config user.signingkey \"" + key + ".pub\"");
  fixture.run("git config commit.gpgsign true");
  fixture.writeFile("signed.txt", "signed\n");
  fixture.run("git add signed.txt");
  const ScopedUnset agent("SSH_AUTH_SOCK");

  InteractiveSession session;
  session.onEngineRequest = [](const Json&) -> Json { return {{"value", "signpass"}}; };
  const std::string repoId = discover(session, fixture.root());
  const Json commit =
      session.request(req(3, "mutate/commit", {{"repoId", repoId}, {"message", "signed"}}));
  ASSERT_TRUE(commit.contains("result")) << commit.dump();
  EXPECT_EQ(promptKinds(session), (std::vector<std::string>{"passphrase"}));
  EXPECT_NE(gg::testing::gitCapture(fixture.root(), "cat-file -p HEAD").find("BEGIN SSH SIGNATURE"),
            std::string::npos);
}

// Dismissing the passphrase prompt stops a merge before its commit; the
// error names the merge left in progress, and continuing it asks again.
TEST(Signing, ADismissedPassphraseLeavesTheMergeToContinue) {
  if (!onPath("ssh-keygen")) GTEST_SKIP() << "ssh-keygen is not installed";
  FixtureRepo fixture;
  fixture.run("git switch -q -c side");
  fixture.writeFile("side.txt", "side\n");
  fixture.run("git add side.txt");
  fixture.commit("side work");
  fixture.run("git switch -q main");
  const std::string key = (fixture.root() / ".git" / "signing_key").string();
  sh("ssh-keygen -q -t ed25519 -N signpass -f '" + key + "'");
  fixture.run("git config gpg.format ssh");
  fixture.run("git config user.signingkey \"" + key + ".pub\"");
  fixture.run("git config commit.gpgsign true");
  const ScopedUnset agent("SSH_AUTH_SOCK");

  InteractiveSession session;
  std::atomic<bool> answer{false};
  session.onEngineRequest = [&answer](const Json&) -> Json {
    if (!answer) return {{"cancelled", true}};
    return {{"value", "signpass"}};
  };
  const std::string repoId = discover(session, fixture.root());
  const Json merge = session.request(
      req(3, "mutate/merge", {{"repoId", repoId}, {"ref", "side"}, {"noFf", true}}));
  ASSERT_TRUE(merge.contains("error")) << merge.dump();
  EXPECT_EQ(merge["error"]["data"]["kind"], "cancelled") << merge.dump();
  EXPECT_EQ(merge["error"]["data"]["operation"], "merge") << merge.dump();
  EXPECT_TRUE(std::filesystem::exists(fixture.root() / ".git" / "MERGE_HEAD"));

  answer = true;
  const Json resumed =
      session.request(req(4, "mutate/sequencer", {{"repoId", repoId}, {"action", "continue"}}));
  ASSERT_TRUE(resumed.contains("result")) << resumed.dump();
  EXPECT_TRUE(resumed["result"]["completed"].get<bool>()) << resumed.dump();
  EXPECT_NE(gg::testing::gitCapture(fixture.root(), "cat-file -p HEAD").find("BEGIN SSH SIGNATURE"),
            std::string::npos);
}

// gpg whose pinentry cannot ask (none usable here, as with a terminal-only
// pinentry and no terminal): the passphrase is asked for through the client
// and handed to gpg's loopback pinentry.
TEST(Signing, GpgPassphraseIsAskedForWhenPinentryCannotAsk) {
  if (!onPath("gpg") || !onPath("gpgconf")) GTEST_SKIP() << "gpg is not installed";
  FixtureRepo fixture;
  const std::filesystem::path home = gg::testing::makeTempDir("gg-gnupg-");
  std::filesystem::permissions(home, std::filesystem::perms::owner_all,
                               std::filesystem::perm_options::replace);
  const ScopedEnv gnupgHome("GNUPGHOME", home.string());
  const ScopedUnset gpgTty("GPG_TTY");
  sh("gpg --batch -q --pinentry-mode loopback --passphrase gpgpass --quick-gen-key "
     "'Signer <signer@example.invalid>' ed25519 sign never > /dev/null 2>&1");
  writeText(home / "gpg-agent.conf", "pinentry-program /bin/false\n");
  // Restarting the agent forgets the passphrase the key was made with.
  sh("gpgconf --kill gpg-agent");
  fixture.run("git config user.signingkey signer@example.invalid");
  fixture.run("git config commit.gpgsign true");
  fixture.writeFile("signed.txt", "signed\n");
  fixture.run("git add signed.txt");

  InteractiveSession session;
  session.onEngineRequest = [](const Json& request) -> Json {
    // The first answer is wrong, as a mistyped passphrase would be.
    static int attempts = 0;
    if (request["params"]["kind"] != "passphrase") return {{"cancelled", true}};
    return {{"value", ++attempts == 1 ? "typo" : "gpgpass"}};
  };
  const std::string repoId = discover(session, fixture.root());
  const Json commit =
      session.request(req(3, "mutate/commit", {{"repoId", repoId}, {"message", "signed"}}));
  sh("gpgconf --kill gpg-agent");
  ASSERT_TRUE(commit.contains("result")) << commit.dump();
  EXPECT_EQ(promptKinds(session), (std::vector<std::string>{"passphrase", "passphrase"}));
  EXPECT_NE(gg::testing::gitCapture(fixture.root(), "cat-file -p HEAD").find("BEGIN PGP SIGNATURE"),
            std::string::npos);
  std::error_code ec;
  std::filesystem::remove_all(home, ec);
}

#endif  // !_WIN32

}  // namespace
}  // namespace gg
