#pragma once

#include <nlohmann/json.hpp>

#include <atomic>
#include <functional>
#include <map>
#include <memory>
#include <mutex>
#include <set>
#include <string>

#include "rpc/framing.h"
#include "util/cancel.h"
#include "util/result.h"
#include "util/strand.h"
#include "util/task_pool.h"

namespace gg::rpc {

using Json = nlohmann::json;

// Serializes a message for the wire, replacing invalid UTF-8 with U+FFFD.
// Values reaching us from git carry bytes that are not valid UTF-8 (hook
// output, remote URLs, refnames written by other tools), and nlohmann's
// default dump() throws type_error.316 on those.
std::string dumpForWire(const Json& message);

// Maximum nesting depth accepted from the client. Deeply nested JSON blows the
// stack in nlohmann's recursive parser long before any handler sees it.
inline constexpr int kMaxParseDepth = 256;

// Payloads up to this size are parsed inline on the read loop; larger ones are
// parsed on a worker, so the read loop keeps taking messages while a
// multi-megabyte frame (an editor buffer pushed through doc/didChange) parses.
// The limit sits well above any control or interactive message, so those keep
// their inline latency.
inline constexpr size_t kInlineParseLimit = 256u * 1024u;

// Ceiling on the payload bytes waiting to be parsed off the read loop. Past
// it, deferral stops and payloads are parsed inline again, which holds the
// read loop to the speed of parsing and bounds the backlog. Matches the
// largest accepted frame, so any single legal frame can be deferred however
// big it is.
inline constexpr size_t kMaxDeferredParseBytes = kMaxFrameBytes;

// Sends a server->client notification (used by streaming handlers).
using NotifyFn = std::function<void(const std::string& method, const Json& params)>;

// A request handler. Runs on the task pool. Returns the JSON-RPC result, or
// throws gg::Error (as HandlerError) / gg::CancelledError.
using Handler = std::function<Json(const Json& params, const CancelToken&, const NotifyFn&)>;

// A notification handler. Takes params by value so a queued handler can move
// large payloads instead of copying them.
using NotificationHandler = std::function<void(Json params)>;

struct HandlerError {
  Error error;
};

// Where a handler runs.
//
// Concurrent is the default: handlers run on the task pool with no ordering
// guarantee, so ordering is opted into. Serial handlers share one FIFO strand
// per (lane, repository) pair — the repository comes from params["repoId"] —
// and run in request-submission order, so two Serial requests for the same
// repository never overlap while a slow mutation on one repository never
// delays another. SerialNetwork is a second per-repository lane for
// remote-facing methods (fetch/pull/push), which run for minutes and need no
// ordering against index mutations. Requests carrying no repoId share their
// lane's unkeyed strand.
enum class Mode { Concurrent, Serial, SerialNetwork };

// Where a notification handler runs.
//
// Inline handlers run on the read loop and must be cheap ($/cancelRequest
// must beat the request it cancels). Queued handlers run on a shared FIFO
// strand: still ordered against each other, but off the read loop, so a large
// payload does not delay the next request.
enum class NotificationMode { Inline, Queued };

// JSON-RPC 2.0 method dispatch with per-request cancellation.
//
// Requests run on the task pool; `$/cancelRequest` is handled inline on the
// read loop and flips the matching request's CancelToken. Responses and
// notifications are emitted through a caller-supplied send callback, which
// must be thread-safe (FrameWriter is).
//
// Lifetime contract: call TaskPool::shutdown() (draining all handler tasks)
// before destroying the Dispatcher or anything the send callback captures.
class Dispatcher {
 public:
  using SendFn = std::function<void(const Json& message)>;

  Dispatcher(TaskPool& pool, SendFn send);

  void method(const std::string& name, Handler handler, Mode mode = Mode::Concurrent,
              Priority priority = Priority::Interactive);
  void notification(const std::string& name, NotificationHandler handler,
                    NotificationMode mode = NotificationMode::Inline);

  // Entry point for every inbound payload. Never throws; protocol-level
  // failures produce JSON-RPC error responses. Payloads over
  // kInlineParseLimit are parsed and routed on a worker, keeping arrival
  // order among themselves; smaller payloads behind them are routed inline
  // and so can overtake them.
  void dispatch(std::string payload);

  // Number of requests currently registered as in flight (for tests).
  size_t inflight() const;

 private:
  void route(const std::string& payload);
  // Claims `size` bytes of the deferred-parse budget, or fails when the
  // budget is exhausted and the caller must parse inline instead.
  bool reserveDeferred(size_t size);
  void runRequest(const Json& id, const std::string& methodName, Json params);
  void cancelRequest(const Json& params);
  void sendResult(const Json& id, const Json& result);
  void sendError(const Json& id, const Error& error);

  // The strand for one (lane, repository) pair, created on first use.
  Strand& strandFor(Mode mode, const Json& params);

  struct MethodEntry {
    Handler handler;
    Mode mode;
    Priority priority;
  };

  struct NotificationEntry {
    NotificationHandler handler;
    NotificationMode mode;
  };

  TaskPool& pool_;
  SendFn send_;
  std::map<std::string, MethodEntry> methods_;
  std::map<std::string, NotificationEntry> notifications_;

  std::mutex strandsMutex_;
  std::map<std::string, std::unique_ptr<Strand>> strands_;
  // Carries both queued notification handlers and deferred parses, so both
  // keep arrival order relative to each other.
  Strand notificationStrand_;
  std::atomic<size_t> deferredBytes_{0};

  mutable std::mutex inflightMutex_;
  std::map<std::int64_t, CancelSource> inflight_;
  // Ids cancelled before their request reached the inflight map, which a
  // deferred parse makes possible. Bounded so a client cannot grow it by
  // cancelling ids it never sends.
  std::set<std::int64_t> earlyCancelled_;
};

}  // namespace gg::rpc
