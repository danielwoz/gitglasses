#pragma once

#include <atomic>
#include <chrono>
#include <cstdint>
#include <functional>
#include <memory>
#include <optional>
#include <string>
#include <vector>

#include "exec/git_process.h"

namespace gg::exec {

// Credential prompts for the git the engine runs.
//
// git runs with no terminal and GIT_TERMINAL_PROMPT=0, so anything it, ssh or
// gpg would ask the user for fails at once unless a program answers. The
// engine points GIT_ASKPASS and SSH_ASKPASS at its own binary, which then
// runs as a shim: it connects to the AskpassBroker over a private endpoint (a
// unix socket in a 0700 directory, or a named pipe only the current user may
// open), proves itself with a per-invocation token, and waits for the answer
// the broker obtains from the client. The answer goes to the shim's stdout,
// where git and ssh read it.

// What a prompt asks for; mirrors AskpassKind in the protocol.
enum class AskpassKind { Username, Password, Passphrase, HostKey, Confirm, Other };

// Protocol name of a kind ("username", "hostKey", ...).
const char* askpassKindName(AskpassKind kind);

// A prompt as git, ssh or gpg printed it, with what can be read out of it.
struct AskpassPrompt {
  std::string prompt;
  AskpassKind kind = AskpassKind::Other;
  // Scheme, host and user of the URL or ssh destination the prompt names.
  std::string protocol;
  std::string host;
  std::string username;
  // SHA256 fingerprint of an ssh host key being confirmed.
  std::string fingerprint;
  // The answer must be masked while typed and never kept.
  bool secret = true;
};

// Reads a prompt. `hint` is what the shim knew about its caller: "confirm"
// for an ssh confirmation (SSH_ASKPASS_PROMPT=confirm), "gpg" for the
// signing shim, empty otherwise.
AskpassPrompt classifyAskpassPrompt(const std::string& prompt, const std::string& hint);

// The request whose git invocation prompted.
struct AskpassOrigin {
  std::int64_t requestId = -1;
  std::string method;
  std::string repoId;
  // An action the user started (push, commit) rather than background work
  // (blame, history), which must never pop up a prompt on its own.
  bool interactive = false;
};

// True when prompts raised by `method` come from an action the user started.
bool askpassInteractiveMethod(const std::string& method);

struct AskpassAnswer {
  bool answered = false;
  std::string value;
  // No answer because the user dismissed the prompt, as opposed to there
  // being no one to ask.
  bool declined = false;
};

// Obtains an answer for one prompt, typically by asking the client. Runs on a
// broker thread and blocks until it has an answer or `abandoned()` turns true
// (git stopped waiting: it exited, timed out or was cancelled), in which case
// it returns promptly with no answer.
using AskpassHandler =
    std::function<AskpassAnswer(const AskpassPrompt& prompt, const AskpassOrigin& origin,
                                const std::function<bool()>& abandoned)>;

// Longest a single prompt may stay open before it is withdrawn.
inline constexpr std::chrono::minutes kAskpassPromptTimeout{10};

class AskpassSession;

class AskpassBroker {
 public:
  // Starts listening on a fresh private endpoint. Returns null when the
  // endpoint cannot be created; git then runs without prompts.
  static std::unique_ptr<AskpassBroker> start(AskpassHandler handler);

  ~AskpassBroker();
  AskpassBroker(const AskpassBroker&) = delete;
  AskpassBroker& operator=(const AskpassBroker&) = delete;

  // The socket path or pipe name the shim connects to.
  const std::string& endpoint() const;

  // Registers one git invocation; prompts carrying its token are answered
  // for `origin` until the session is destroyed.
  std::shared_ptr<AskpassSession> openSession(AskpassOrigin origin);

  // Withdraws every open prompt and refuses new ones. Used when the client
  // has gone away.
  void cancelAll();

  struct Impl;

 private:
  explicit AskpassBroker(std::shared_ptr<Impl> impl);
  std::shared_ptr<Impl> impl_;
};

namespace detail {
inline std::atomic<AskpassBroker*> installedAskpassBroker{nullptr};
}  // namespace detail

// The broker git invocations use, or null for none. Installed by the server
// once the client said it answers prompts; with none installed, git runs as
// before, failing whatever it would have asked.
inline void installAskpassBroker(AskpassBroker* broker) {
  detail::installedAskpassBroker.store(broker);
}
inline bool askpassEnabled() { return detail::installedAskpassBroker.load() != nullptr; }

namespace detail {
inline std::atomic<bool> clientAnswersPrompts{false};
}  // namespace detail

// Whether the client declared that it answers prompts (initialize's
// clientCapabilities.askpass). Without it every prompt is declined at once.
inline void setClientAnswersPrompts(bool answers) { detail::clientAnswersPrompts.store(answers); }
inline bool clientAnswersPrompts() { return detail::clientAnswersPrompts.load(); }

// A session for a git invocation the calling thread is about to start, on
// behalf of the request the thread is serving (see util/request_context.h).
// Null when no broker is installed.
std::shared_ptr<AskpassSession> openAskpassSession();

// "NAME=value" entries that point git, ssh and the signing shim at the
// broker for this session.
std::vector<std::string> askpassEnvironment(const AskpassSession& session);

// The session's prompt bookkeeping, which the git process it belongs to
// reads (see AskpassPromptStats in git_process.h).
std::shared_ptr<const AskpassPromptStats> askpassPromptStats(const AskpassSession& session);

// Environment variables the shims read.
inline constexpr const char* kAskpassEndpointVar = "GITGLASSES_ASKPASS";
inline constexpr const char* kAskpassTokenVar = "GITGLASSES_ASKPASS_TOKEN";
// The gpg program the signing shim stands in for.
inline constexpr const char* kGpgProgramVar = "GITGLASSES_GPG_PROGRAM";

// Asks the broker named by the environment. `hint` is passed through to
// classifyAskpassPrompt. Returns nullopt when there is no broker, the token
// is refused, or the user gave no answer.
std::optional<std::string> askThroughBroker(const std::string& hint, const std::string& prompt);

// Shim mode for GIT_ASKPASS / SSH_ASKPASS: git and ssh run the binary with
// the prompt as its only argument. Returns the exit code when argv and the
// environment select this mode, nullopt otherwise.
std::optional<int> maybeRunAskpassShim(int argc, char** argv);

// Shim mode for gpg.program (see gpg_shim.cpp). Returns the exit code when
// argv and the environment select it, nullopt otherwise.
std::optional<int> maybeRunGpgShim(int argc, char** argv);

// Clears the shims' variables from this process's environment, so a server
// never mistakes a stale value it inherited for its own.
void clearAskpassEnvironment();

}  // namespace gg::exec
