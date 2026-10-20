#include "exec/askpass.h"

#include <spdlog/spdlog.h>

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <list>
#include <map>
#include <mutex>
#include <random>
#include <regex>
#include <thread>
#include <utility>

#ifdef _WIN32
#include "exec/win_unicode.h"

#include <sddl.h>
#include <shellapi.h>
#else
#include <fcntl.h>
#include <poll.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/un.h>
#include <unistd.h>

#include <cerrno>
#endif

#include "exec/sequence_editor.h"
#include "util/request_context.h"

namespace gg::exec {

// --- Prompts -----------------------------------------------------------------

const char* askpassKindName(AskpassKind kind) {
  switch (kind) {
    case AskpassKind::Username:
      return "username";
    case AskpassKind::Password:
      return "password";
    case AskpassKind::Passphrase:
      return "passphrase";
    case AskpassKind::HostKey:
      return "hostKey";
    case AskpassKind::Confirm:
      return "confirm";
    case AskpassKind::Other:
      break;
  }
  return "other";
}

namespace {

bool startsWith(const std::string& text, const char* prefix) { return text.rfind(prefix, 0) == 0; }

// Splits "scheme://[user@]host[:port]/..." into its parts.
void readUrl(const std::string& url, AskpassPrompt& out) {
  static const std::regex pattern(
      R"(^([a-zA-Z][a-zA-Z0-9+.-]*)://(?:([^@/]*)@)?(\[[^\]]*\]|[^/:]*))");
  std::smatch match;
  if (!std::regex_search(url, match, pattern)) return;
  out.protocol = match[1].str();
  out.username = match[2].str();
  out.host = match[3].str();
}

}  // namespace

AskpassPrompt classifyAskpassPrompt(const std::string& prompt, const std::string& hint) {
  AskpassPrompt out;
  out.prompt = prompt;
  std::smatch match;

  if (hint == "gpg") {
    out.kind = AskpassKind::Passphrase;
    return out;
  }
  if (hint == "confirm") {
    out.kind = AskpassKind::Confirm;
    out.secret = false;
    return out;
  }

  // git's credential prompts: "Username for 'https://host': ",
  // "Password for 'https://user@host': ".
  static const std::regex credential(R"(^(Username|Password) for '([^']*)')");
  if (std::regex_search(prompt, match, credential)) {
    const bool username = match[1].str() == "Username";
    out.kind = username ? AskpassKind::Username : AskpassKind::Password;
    out.secret = !username;
    readUrl(match[2].str(), out);
    return out;
  }

  // ssh's first-contact host-key question, and its re-ask after an answer it
  // did not understand.
  if (prompt.find("continue connecting") != std::string::npos ||
      prompt.find("Please type 'yes', 'no' or the fingerprint") != std::string::npos) {
    out.kind = AskpassKind::HostKey;
    out.secret = false;
    out.protocol = "ssh";
    static const std::regex host(R"(authenticity of host '([^' ]+))");
    if (std::regex_search(prompt, match, host)) out.host = match[1].str();
    static const std::regex fingerprint(R"(fingerprint is (SHA256:[A-Za-z0-9+/=]+))");
    if (std::regex_search(prompt, match, fingerprint)) out.fingerprint = match[1].str();
    return out;
  }

  // ssh password and keyboard-interactive prompts: "user@host's password: ",
  // "(user@host) Password: ".
  static const std::regex sshPassword(R"(^([^@\s']+)@([^\s']+)'s password)");
  static const std::regex sshKbdInteractive(R"(^\(([^@\s)]+)@([^)\s]+)\) Password)");
  if (std::regex_search(prompt, match, sshPassword) ||
      std::regex_search(prompt, match, sshKbdInteractive)) {
    out.kind = AskpassKind::Password;
    out.protocol = "ssh";
    out.username = match[1].str();
    out.host = match[2].str();
    return out;
  }

  // Key passphrases (ssh, ssh-keygen signing) and security-key PINs.
  if (startsWith(prompt, "Enter passphrase") || startsWith(prompt, "Enter PIN")) {
    out.kind = AskpassKind::Passphrase;
    return out;
  }

  if (startsWith(prompt, "Username")) {
    out.kind = AskpassKind::Username;
    out.secret = false;
    return out;
  }
  if (startsWith(prompt, "Password")) {
    out.kind = AskpassKind::Password;
    return out;
  }
  return out;
}

bool askpassInteractiveMethod(const std::string& method) {
  return startsWith(method, "mutate/") || startsWith(method, "rebase/") ||
         startsWith(method, "stash/") || startsWith(method, "worktree/") || method == "patch/apply";
}

// --- Wire format ----------------------------------------------------------------
//
// Shim to broker: "GGASKPASS1\n" <token> "\n" <hint> "\n" <length> "\n" <prompt>.
// Broker to shim: "OK\n" <length> "\n" <answer>, or "NO\n".

namespace {

constexpr const char* kMagic = "GGASKPASS1";
constexpr size_t kMaxHeaderLine = 256;
constexpr size_t kMaxPromptBytes = 64 * 1024;
constexpr size_t kMaxAnswerBytes = 64 * 1024;
// How long the broker waits for a connected shim to send its request.
constexpr std::chrono::seconds kRequestReadTimeout{10};

std::string randomToken() {
  std::random_device device;
  std::string token;
  char buffer[9];
  for (int i = 0; i < 4; ++i) {
    std::snprintf(buffer, sizeof(buffer), "%08x", static_cast<unsigned>(device()));
    token += buffer;
  }
  return token;
}

std::string encodeRequest(const std::string& token, const std::string& hint,
                          const std::string& prompt) {
  return std::string(kMagic) + "\n" + token + "\n" + hint + "\n" + std::to_string(prompt.size()) +
         "\n" + prompt;
}

std::optional<size_t> parseLength(const std::string& text, size_t limit) {
  if (text.empty() || text.size() > 9) return std::nullopt;
  size_t value = 0;
  for (const char c : text) {
    if (c < '0' || c > '9') return std::nullopt;
    value = value * 10 + static_cast<size_t>(c - '0');
  }
  if (value > limit) return std::nullopt;
  return value;
}

// Reads one "\n"-terminated header line through `readByte`.
template <typename ReadByte>
bool readHeaderLine(ReadByte&& readByte, std::string& line) {
  line.clear();
  for (;;) {
    char c = 0;
    if (!readByte(c)) return false;
    if (c == '\n') return true;
    if (line.size() >= kMaxHeaderLine) return false;
    line += c;
  }
}

}  // namespace

// --- Sessions --------------------------------------------------------------------

struct AskpassSessionState {
  std::string token;
  AskpassOrigin origin;
  std::atomic<bool> closed{false};
  std::shared_ptr<AskpassPromptStats> stats = std::make_shared<AskpassPromptStats>();
};

class AskpassSession {
 public:
  AskpassSession(std::shared_ptr<AskpassSessionState> state,
                 std::weak_ptr<AskpassBroker::Impl> broker, std::string endpoint)
      : state_(std::move(state)), broker_(std::move(broker)), endpoint_(std::move(endpoint)) {}
  ~AskpassSession();

  const AskpassSessionState& state() const { return *state_; }
  const std::string& endpoint() const { return endpoint_; }

 private:
  std::shared_ptr<AskpassSessionState> state_;
  std::weak_ptr<AskpassBroker::Impl> broker_;
  std::string endpoint_;
};

struct AskpassBroker::Impl {
  AskpassHandler handler;
  std::string endpoint;
  std::atomic<bool> stopping{false};

  std::mutex mutex;
  std::map<std::string, std::shared_ptr<AskpassSessionState>> sessions;

  struct Worker {
    std::thread thread;
    std::shared_ptr<std::atomic<bool>> done;
  };
  std::list<Worker> workers;
  std::thread acceptThread;

#ifdef _WIN32
  std::wstring pipeName;
  PSECURITY_DESCRIPTOR security = nullptr;
  HANDLE stopEvent = nullptr;
#else
  std::string directory;
  int listenFd = -1;
  int wakePipe[2] = {-1, -1};
#endif

  std::shared_ptr<AskpassSessionState> find(const std::string& token) {
    std::lock_guard lock(mutex);
    const auto it = sessions.find(token);
    return it == sessions.end() ? nullptr : it->second;
  }

  void forget(const std::string& token) {
    std::lock_guard lock(mutex);
    sessions.erase(token);
  }

  // Joins workers that have finished; called from the accept thread.
  void reapWorkers() {
    std::lock_guard lock(mutex);
    for (auto it = workers.begin(); it != workers.end();) {
      if (it->done->load()) {
        it->thread.join();
        it = workers.erase(it);
      } else {
        ++it;
      }
    }
  }

  // Serves one shim connection: reads its request, asks the handler, writes
  // the answer. `Connection` provides readByte/readExact/write/peerGone.
  template <typename Connection>
  void serve(Connection& connection) {
    const auto readDeadline = std::chrono::steady_clock::now() + kRequestReadTimeout;
    const auto readByte = [&](char& c) { return connection.readExact(&c, 1, readDeadline); };
    std::string magic, token, hint, lengthText;
    if (!readHeaderLine(readByte, magic) || magic != kMagic) return;
    if (!readHeaderLine(readByte, token) || !readHeaderLine(readByte, hint) ||
        !readHeaderLine(readByte, lengthText)) {
      return;
    }
    const auto length = parseLength(lengthText, kMaxPromptBytes);
    if (!length) return;
    std::string prompt(*length, '\0');
    if (*length > 0 && !connection.readExact(prompt.data(), *length, readDeadline)) return;

    const auto session = find(token);
    if (!session || session->closed.load() || stopping.load()) {
      connection.write("NO\n");
      return;
    }

    const AskpassPrompt parsed = classifyAskpassPrompt(prompt, hint);
    const auto started = std::chrono::steady_clock::now();
    const std::function<bool()> abandoned = [&] {
      return stopping.load() || session->closed.load() || connection.peerGone() ||
             std::chrono::steady_clock::now() - started > kAskpassPromptTimeout;
    };
    AskpassPromptStats& stats = *session->stats;
    stats.open.fetch_add(1);
    AskpassAnswer answer;
    try {
      answer = handler(parsed, session->origin, abandoned);
    } catch (const std::exception& e) {
      spdlog::warn("askpass handler failed: {}", e.what());
    }
    const auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::steady_clock::now() - started);
    stats.millis.fetch_add(elapsed.count());
    stats.open.fetch_sub(1);

    // An answer to a prompt git stopped waiting for is not delivered.
    const bool withdrawn = abandoned();
    if (!answer.answered || withdrawn || answer.value.size() > kMaxAnswerBytes) {
      if (answer.declined && !withdrawn) stats.declined.store(true);
      connection.write("NO\n");
      return;
    }
    connection.write("OK\n" + std::to_string(answer.value.size()) + "\n" + answer.value);
  }

  void spawnWorker(std::function<void()> body) {
    auto done = std::make_shared<std::atomic<bool>>(false);
    std::lock_guard lock(mutex);
    workers.push_back({std::thread([body = std::move(body), done] {
                         body();
                         done->store(true);
                       }),
                       done});
  }

  void acceptLoop();
  void shutdown();
};

AskpassSession::~AskpassSession() {
  state_->closed.store(true);
  if (const auto broker = broker_.lock()) broker->forget(state_->token);
}

// --- POSIX endpoint ------------------------------------------------------------------

#ifndef _WIN32

namespace {

// Sends without raising SIGPIPE when the peer has gone.
bool sendAll(int fd, const std::string& data) {
  size_t sent = 0;
  while (sent < data.size()) {
#ifdef MSG_NOSIGNAL
    const ssize_t n = ::send(fd, data.data() + sent, data.size() - sent, MSG_NOSIGNAL);
#else
    const ssize_t n = ::send(fd, data.data() + sent, data.size() - sent, 0);
#endif
    if (n < 0 && errno == EINTR) continue;
    if (n <= 0) return false;
    sent += static_cast<size_t>(n);
  }
  return true;
}

void disableSigpipe(int fd) {
#ifdef SO_NOSIGPIPE
  int one = 1;
  setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &one, sizeof(one));
#else
  (void)fd;
#endif
}

// True when the connecting process runs as this process's user. The socket
// already lives in a directory only this user can enter; this holds even if
// that directory's permissions were loosened.
bool peerIsSameUser(int fd) {
#if defined(SO_PEERCRED)
  struct ucred credentials{};
  socklen_t size = sizeof(credentials);
  if (getsockopt(fd, SOL_SOCKET, SO_PEERCRED, &credentials, &size) != 0) return false;
  return credentials.uid == geteuid();
#else
  uid_t uid = 0;
  gid_t gid = 0;
  if (getpeereid(fd, &uid, &gid) != 0) return false;
  return uid == geteuid();
#endif
}

class SocketConnection {
 public:
  explicit SocketConnection(int fd) : fd_(fd) {}

  bool readExact(char* out, size_t size, std::chrono::steady_clock::time_point deadline) {
    size_t got = 0;
    while (got < size) {
      const auto remaining = std::chrono::duration_cast<std::chrono::milliseconds>(
          deadline - std::chrono::steady_clock::now());
      if (remaining.count() <= 0) return false;
      pollfd pfd{fd_, POLLIN, 0};
      const int ready = poll(&pfd, 1, static_cast<int>(remaining.count()));
      if (ready < 0 && errno == EINTR) continue;
      if (ready <= 0) return false;
      const ssize_t n = ::recv(fd_, out + got, size - got, 0);
      if (n < 0 && (errno == EINTR || errno == EAGAIN)) continue;
      if (n <= 0) return false;
      got += static_cast<size_t>(n);
    }
    return true;
  }

  bool write(const std::string& data) { return sendAll(fd_, data); }

  // The shim sends nothing after its request, so anything readable now is
  // its end of the connection closing.
  bool peerGone() {
    pollfd pfd{fd_, POLLIN, 0};
    return poll(&pfd, 1, 0) > 0;
  }

 private:
  int fd_;
};

}  // namespace

std::unique_ptr<AskpassBroker> AskpassBroker::start(AskpassHandler handler) {
  auto impl = std::make_shared<Impl>();
  impl->handler = std::move(handler);

  // A fresh 0700 directory (mkdtemp's mode) holds the socket; its path must
  // fit sockaddr_un, so long bases are skipped.
  sockaddr_un address{};
  std::vector<std::string> bases;
  for (const char* var : {"XDG_RUNTIME_DIR", "TMPDIR"}) {
    if (const char* value = std::getenv(var); value && value[0] == '/') bases.emplace_back(value);
  }
  bases.emplace_back("/tmp");
  for (std::string base : bases) {
    while (base.size() > 1 && base.back() == '/') base.pop_back();
    std::string pattern = base + "/gg-askpass-XXXXXX";
    if (pattern.size() + 3 >= sizeof(address.sun_path)) continue;
    if (mkdtemp(pattern.data())) {
      impl->directory = pattern;
      break;
    }
  }
  if (impl->directory.empty()) {
    spdlog::warn("askpass: cannot create a private directory for the prompt socket");
    return nullptr;
  }
  impl->endpoint = impl->directory + "/s";
  std::memcpy(address.sun_path, impl->endpoint.c_str(), impl->endpoint.size() + 1);
  address.sun_family = AF_UNIX;

  const auto fail = [&impl](const char* what) -> std::unique_ptr<AskpassBroker> {
    spdlog::warn("askpass: {} failed: {}", what, std::strerror(errno));
    impl->shutdown();
    return nullptr;
  };
  impl->listenFd = ::socket(AF_UNIX, SOCK_STREAM, 0);
  if (impl->listenFd < 0) return fail("socket");
  fcntl(impl->listenFd, F_SETFD, FD_CLOEXEC);
  if (::bind(impl->listenFd, reinterpret_cast<sockaddr*>(&address), sizeof(address)) != 0) {
    return fail("bind");
  }
  chmod(impl->endpoint.c_str(), 0600);
  if (::listen(impl->listenFd, 16) != 0) return fail("listen");
  if (pipe(impl->wakePipe) != 0) return fail("pipe");
  fcntl(impl->wakePipe[0], F_SETFD, FD_CLOEXEC);
  fcntl(impl->wakePipe[1], F_SETFD, FD_CLOEXEC);

  Impl* raw = impl.get();
  impl->acceptThread = std::thread([raw] { raw->acceptLoop(); });
  return std::unique_ptr<AskpassBroker>(new AskpassBroker(std::move(impl)));
}

void AskpassBroker::Impl::acceptLoop() {
  for (;;) {
    pollfd fds[2] = {{listenFd, POLLIN, 0}, {wakePipe[0], POLLIN, 0}};
    const int ready = poll(fds, 2, 1000);
    if (stopping.load()) return;
    reapWorkers();
    if (ready <= 0 || !(fds[0].revents & POLLIN)) continue;
    const int fd = ::accept(listenFd, nullptr, nullptr);
    if (fd < 0) continue;
    fcntl(fd, F_SETFD, FD_CLOEXEC);
    disableSigpipe(fd);
    if (!peerIsSameUser(fd)) {
      spdlog::warn("askpass: refused a connection from another user");
      ::close(fd);
      continue;
    }
    spawnWorker([this, fd] {
      SocketConnection connection(fd);
      serve(connection);
      ::close(fd);
    });
  }
}

void AskpassBroker::Impl::shutdown() {
  stopping.store(true);
  if (wakePipe[1] >= 0) {
    const char byte = 1;
    [[maybe_unused]] const ssize_t n = ::write(wakePipe[1], &byte, 1);
  }
  if (acceptThread.joinable()) acceptThread.join();
  std::list<Worker> remaining;
  {
    std::lock_guard lock(mutex);
    remaining.swap(workers);
  }
  for (auto& worker : remaining) worker.thread.join();
  if (listenFd >= 0) ::close(listenFd);
  for (int& fd : wakePipe) {
    if (fd >= 0) ::close(fd);
    fd = -1;
  }
  listenFd = -1;
  if (!endpoint.empty()) ::unlink(endpoint.c_str());
  if (!directory.empty()) ::rmdir(directory.c_str());
}

namespace {

std::optional<std::string> exchangeWithBroker(const std::string& endpoint,
                                              const std::string& request) {
  sockaddr_un address{};
  if (endpoint.size() + 1 > sizeof(address.sun_path)) return std::nullopt;
  address.sun_family = AF_UNIX;
  std::memcpy(address.sun_path, endpoint.c_str(), endpoint.size() + 1);
  const int fd = ::socket(AF_UNIX, SOCK_STREAM, 0);
  if (fd < 0) return std::nullopt;
  disableSigpipe(fd);
  if (::connect(fd, reinterpret_cast<sockaddr*>(&address), sizeof(address)) != 0 ||
      !sendAll(fd, request)) {
    ::close(fd);
    return std::nullopt;
  }
  std::string reply;
  char buffer[4096];
  for (;;) {
    const ssize_t n = ::recv(fd, buffer, sizeof(buffer), 0);
    if (n < 0 && errno == EINTR) continue;
    if (n <= 0) break;
    reply.append(buffer, static_cast<size_t>(n));
    if (reply.size() > kMaxAnswerBytes + kMaxHeaderLine) break;
  }
  ::close(fd);
  return reply;
}

}  // namespace

#else  // _WIN32

// --- Windows endpoint ------------------------------------------------------------------

namespace {

// A security descriptor whose DACL admits only the current user.
PSECURITY_DESCRIPTOR currentUserOnly() {
  HANDLE token = nullptr;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) return nullptr;
  DWORD size = 0;
  GetTokenInformation(token, TokenUser, nullptr, 0, &size);
  std::vector<BYTE> buffer(size);
  const BOOL ok = GetTokenInformation(token, TokenUser, buffer.data(), size, &size);
  CloseHandle(token);
  if (!ok) return nullptr;
  LPWSTR sid = nullptr;
  if (!ConvertSidToStringSidW(reinterpret_cast<TOKEN_USER*>(buffer.data())->User.Sid, &sid)) {
    return nullptr;
  }
  const std::wstring sddl = L"D:P(A;;GA;;;" + std::wstring(sid) + L")";
  LocalFree(sid);
  PSECURITY_DESCRIPTOR descriptor = nullptr;
  if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.c_str(), SDDL_REVISION_1,
                                                            &descriptor, nullptr)) {
    return nullptr;
  }
  return descriptor;
}

HANDLE createPipeInstance(const std::wstring& name, PSECURITY_DESCRIPTOR security, bool first) {
  SECURITY_ATTRIBUTES attributes{};
  attributes.nLength = sizeof(attributes);
  attributes.lpSecurityDescriptor = security;
  attributes.bInheritHandle = FALSE;
  return CreateNamedPipeW(
      name.c_str(),
      PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED | (first ? FILE_FLAG_FIRST_PIPE_INSTANCE : 0),
      PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
      PIPE_UNLIMITED_INSTANCES, 4096, 4096, 0, &attributes);
}

class PipeConnection {
 public:
  explicit PipeConnection(HANDLE pipe)
      : pipe_(pipe), event_(CreateEventW(nullptr, TRUE, FALSE, nullptr)) {}
  ~PipeConnection() {
    if (event_) CloseHandle(event_);
  }
  PipeConnection(const PipeConnection&) = delete;
  PipeConnection& operator=(const PipeConnection&) = delete;

  bool readExact(char* out, size_t size, std::chrono::steady_clock::time_point deadline) {
    size_t got = 0;
    while (got < size) {
      const auto remaining = std::chrono::duration_cast<std::chrono::milliseconds>(
          deadline - std::chrono::steady_clock::now());
      if (remaining.count() <= 0) return false;
      OVERLAPPED overlapped{};
      overlapped.hEvent = event_;
      ResetEvent(event_);
      DWORD n = 0;
      if (!ReadFile(pipe_, out + got, static_cast<DWORD>(size - got), &n, &overlapped)) {
        if (GetLastError() != ERROR_IO_PENDING) return false;
        if (WaitForSingleObject(event_, static_cast<DWORD>(remaining.count())) != WAIT_OBJECT_0) {
          CancelIoEx(pipe_, &overlapped);
          GetOverlappedResult(pipe_, &overlapped, &n, TRUE);
          return false;
        }
        if (!GetOverlappedResult(pipe_, &overlapped, &n, FALSE)) return false;
      }
      if (n == 0) return false;
      got += n;
    }
    return true;
  }

  bool write(const std::string& data) {
    size_t sent = 0;
    while (sent < data.size()) {
      OVERLAPPED overlapped{};
      overlapped.hEvent = event_;
      ResetEvent(event_);
      DWORD n = 0;
      if (!WriteFile(pipe_, data.data() + sent, static_cast<DWORD>(data.size() - sent), &n,
                     &overlapped)) {
        if (GetLastError() != ERROR_IO_PENDING) return false;
        if (!GetOverlappedResult(pipe_, &overlapped, &n, TRUE)) return false;
      }
      if (n == 0) return false;
      sent += n;
    }
    FlushFileBuffers(pipe_);
    return true;
  }

  // A broken pipe means the shim went away; it sends nothing after its
  // request, so pending bytes mean the same.
  bool peerGone() {
    DWORD available = 0;
    if (!PeekNamedPipe(pipe_, nullptr, 0, nullptr, &available, nullptr)) return true;
    return available > 0;
  }

 private:
  HANDLE pipe_;
  HANDLE event_;
};

}  // namespace

std::unique_ptr<AskpassBroker> AskpassBroker::start(AskpassHandler handler) {
  auto impl = std::make_shared<Impl>();
  impl->handler = std::move(handler);
  impl->endpoint = "\\\\.\\pipe\\gitglasses-askpass-" + std::to_string(GetCurrentProcessId()) +
                   "-" + randomToken();
  impl->pipeName = utf8ToWide(impl->endpoint);
  impl->security = currentUserOnly();
  if (!impl->security) {
    spdlog::warn("askpass: cannot build the prompt pipe's access list");
    return nullptr;
  }
  impl->stopEvent = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  HANDLE first = createPipeInstance(impl->pipeName, impl->security, /*first=*/true);
  if (first == INVALID_HANDLE_VALUE || !impl->stopEvent) {
    spdlog::warn("askpass: cannot create the prompt pipe: error {}", GetLastError());
    if (first != INVALID_HANDLE_VALUE) CloseHandle(first);
    impl->shutdown();
    return nullptr;
  }
  Impl* raw = impl.get();
  impl->acceptThread = std::thread([raw, first] {
    HANDLE instance = first;
    HANDLE connected = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    while (!raw->stopping.load() && instance != INVALID_HANDLE_VALUE) {
      raw->reapWorkers();
      OVERLAPPED overlapped{};
      overlapped.hEvent = connected;
      ResetEvent(connected);
      DWORD error = ConnectNamedPipe(instance, &overlapped) ? ERROR_PIPE_CONNECTED : GetLastError();
      if (error == ERROR_IO_PENDING) {
        HANDLE waits[2] = {connected, raw->stopEvent};
        if (WaitForMultipleObjects(2, waits, FALSE, INFINITE) != WAIT_OBJECT_0) {
          CancelIoEx(instance, &overlapped);
          DWORD ignored = 0;
          GetOverlappedResult(instance, &overlapped, &ignored, TRUE);
          break;
        }
        DWORD ignored = 0;
        error = GetOverlappedResult(instance, &overlapped, &ignored, FALSE) ? ERROR_PIPE_CONNECTED
                                                                            : GetLastError();
      }
      HANDLE next = createPipeInstance(raw->pipeName, raw->security, /*first=*/false);
      if (error == ERROR_PIPE_CONNECTED) {
        raw->spawnWorker([raw, instance] {
          {
            PipeConnection connection(instance);
            raw->serve(connection);
          }
          DisconnectNamedPipe(instance);
          CloseHandle(instance);
        });
      } else {
        CloseHandle(instance);
      }
      instance = next;
    }
    if (instance != INVALID_HANDLE_VALUE) CloseHandle(instance);
    CloseHandle(connected);
  });
  return std::unique_ptr<AskpassBroker>(new AskpassBroker(std::move(impl)));
}

void AskpassBroker::Impl::acceptLoop() {}

void AskpassBroker::Impl::shutdown() {
  stopping.store(true);
  if (stopEvent) SetEvent(stopEvent);
  if (acceptThread.joinable()) acceptThread.join();
  std::list<Worker> remaining;
  {
    std::lock_guard lock(mutex);
    remaining.swap(workers);
  }
  for (auto& worker : remaining) worker.thread.join();
  if (stopEvent) CloseHandle(stopEvent);
  stopEvent = nullptr;
  if (security) LocalFree(security);
  security = nullptr;
}

namespace {

std::optional<std::string> exchangeWithBroker(const std::string& endpoint,
                                              const std::string& request) {
  const std::wstring name = utf8ToWide(endpoint);
  HANDLE pipe = INVALID_HANDLE_VALUE;
  for (int attempt = 0; attempt < 10; ++attempt) {
    // Identification only: the broker may learn who connects but cannot act
    // as this process.
    pipe = CreateFileW(name.c_str(), GENERIC_READ | GENERIC_WRITE, 0, nullptr, OPEN_EXISTING,
                       SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION, nullptr);
    if (pipe != INVALID_HANDLE_VALUE) break;
    if (GetLastError() != ERROR_PIPE_BUSY) return std::nullopt;
    WaitNamedPipeW(name.c_str(), 2000);
  }
  if (pipe == INVALID_HANDLE_VALUE) return std::nullopt;
  DWORD written = 0;
  if (!WriteFile(pipe, request.data(), static_cast<DWORD>(request.size()), &written, nullptr) ||
      written != request.size()) {
    CloseHandle(pipe);
    return std::nullopt;
  }
  std::string reply;
  char buffer[4096];
  for (;;) {
    DWORD n = 0;
    if (!ReadFile(pipe, buffer, sizeof(buffer), &n, nullptr) || n == 0) break;
    reply.append(buffer, n);
    if (reply.size() > kMaxAnswerBytes + kMaxHeaderLine) break;
  }
  CloseHandle(pipe);
  return reply;
}

}  // namespace

#endif  // _WIN32

// --- Broker ---------------------------------------------------------------------------

AskpassBroker::AskpassBroker(std::shared_ptr<Impl> impl) : impl_(std::move(impl)) {}

AskpassBroker::~AskpassBroker() {
  if (detail::installedAskpassBroker.load() == this) installAskpassBroker(nullptr);
  impl_->shutdown();
}

const std::string& AskpassBroker::endpoint() const { return impl_->endpoint; }

std::shared_ptr<AskpassSession> AskpassBroker::openSession(AskpassOrigin origin) {
  auto state = std::make_shared<AskpassSessionState>();
  state->token = randomToken();
  state->origin = std::move(origin);
  {
    std::lock_guard lock(impl_->mutex);
    impl_->sessions[state->token] = state;
  }
  return std::make_shared<AskpassSession>(state, impl_, impl_->endpoint);
}

void AskpassBroker::cancelAll() { impl_->stopping.store(true); }

std::shared_ptr<AskpassSession> openAskpassSession() {
  AskpassBroker* broker = detail::installedAskpassBroker.load();
  if (!broker) return nullptr;
  const RequestContext& request = currentRequest();
  AskpassOrigin origin;
  origin.requestId = request.id;
  origin.method = request.method;
  origin.repoId = request.repoId;
  origin.interactive = askpassInteractiveMethod(request.method);
  return broker->openSession(std::move(origin));
}

std::vector<std::string> askpassEnvironment(const AskpassSession& session) {
  const std::string self = selfExePath();
  std::vector<std::string> env = {
      "GIT_ASKPASS=" + self,
      "SSH_ASKPASS=" + self,
      // OpenSSH 8.4 and later use SSH_ASKPASS whenever this says so, with or
      // without a terminal or a display.
      "SSH_ASKPASS_REQUIRE=force",
      std::string(kAskpassEndpointVar) + "=" + session.endpoint(),
      std::string(kAskpassTokenVar) + "=" + session.state().token,
  };
#if !defined(_WIN32) && !defined(__APPLE__)
  // Older OpenSSH reads SSH_ASKPASS only with DISPLAY set, which a headless
  // host (a remote or container session) lacks.
  const char* display = std::getenv("DISPLAY");
  if (!display || !*display) env.emplace_back("DISPLAY=:0");
#endif
  return env;
}

std::shared_ptr<const AskpassPromptStats> askpassPromptStats(const AskpassSession& session) {
  return session.state().stats;
}

// --- Shim -----------------------------------------------------------------------------

std::optional<std::string> askThroughBroker(const std::string& hint, const std::string& prompt) {
  const char* endpoint = std::getenv(kAskpassEndpointVar);
  const char* token = std::getenv(kAskpassTokenVar);
  if (!endpoint || !*endpoint || !token || !*token) return std::nullopt;
  if (prompt.size() > kMaxPromptBytes) return std::nullopt;
  const auto reply = exchangeWithBroker(endpoint, encodeRequest(token, hint, prompt));
  if (!reply || !startsWith(*reply, "OK\n")) return std::nullopt;
  const size_t lengthEnd = reply->find('\n', 3);
  if (lengthEnd == std::string::npos) return std::nullopt;
  const auto length = parseLength(reply->substr(3, lengthEnd - 3), kMaxAnswerBytes);
  if (!length || reply->size() - lengthEnd - 1 != *length) return std::nullopt;
  return reply->substr(lengthEnd + 1);
}

namespace {

// The prompt git or ssh passed as the shim's only argument, as UTF-8.
std::optional<std::string> shimPromptArgument(int argc, char** argv) {
#ifdef _WIN32
  (void)argv;
  int count = 0;
  LPWSTR* wide = CommandLineToArgvW(GetCommandLineW(), &count);
  if (!wide) return std::nullopt;
  std::optional<std::string> prompt;
  if (count == 2 && argc == 2) prompt = wideToUtf8(wide[1]);
  LocalFree(wide);
  return prompt;
#else
  if (argc != 2) return std::nullopt;
  return std::string(argv[1]);
#endif
}

}  // namespace

std::optional<int> maybeRunAskpassShim(int argc, char** argv) {
  const char* endpoint = std::getenv(kAskpassEndpointVar);
  if (!endpoint || !*endpoint || argc != 2) return std::nullopt;
  // Prompts never start with "--"; the engine's own flags all do.
  if (startsWith(argv[1], "--")) return std::nullopt;
  const auto prompt = shimPromptArgument(argc, argv);
  if (!prompt) return std::nullopt;

  std::string hint;
  if (const char* mode = std::getenv("SSH_ASKPASS_PROMPT")) {
    // "none" only shows information (touch your security key) while ssh
    // waits on something else; there is nothing to answer.
    if (std::strcmp(mode, "none") == 0) return 0;
    if (std::strcmp(mode, "confirm") == 0) hint = "confirm";
  }
  const auto answer = askThroughBroker(hint, *prompt);
  if (!answer) return 1;
  std::fwrite(answer->data(), 1, answer->size(), stdout);
  std::fputc('\n', stdout);
  std::fflush(stdout);
  return 0;
}

void clearAskpassEnvironment() {
  for (const char* name : {kAskpassEndpointVar, kAskpassTokenVar, kGpgProgramVar}) {
#ifdef _WIN32
    _putenv_s(name, "");
#else
    ::unsetenv(name);
#endif
  }
}

}  // namespace gg::exec
