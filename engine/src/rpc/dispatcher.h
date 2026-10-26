#pragma once

#include <nlohmann/json.hpp>

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <functional>
#include <limits>
#include <map>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <vector>

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
  // Sent as the error's `data` member when not null.
  Json data = nullptr;
};

// Supplies `data` for an error a handler threw without any, or null for
// none. Lets a layer that understands an error (git's output, say) describe
// it once for every method.
using ErrorDataFn = std::function<Json(const Error& error)>;

// Receives a response to a request this process sent to the client.
using ResponseHandler = std::function<void(const Json& message)>;

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
// lane's unkeyed strand. AfterNotifications runs on the task pool like
// Concurrent, but only once every Queued notification received before the
// request has been handled, so a read of state that notifications write (an
// editor buffer pushed through doc/didChange) sees all of them.
enum class Mode { Concurrent, Serial, SerialNetwork, AfterNotifications };

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
// read loop and flips the matching request's CancelToken. Every request gets
// exactly one response: one whose id is still in flight is refused at once
// with InvalidRequest, and the request holding the id answers as usual.
// Responses and notifications are emitted through a caller-supplied send
// callback, which must be thread-safe (FrameWriter is).
//
// Lifetime contract: call TaskPool::shutdown() (draining all handler tasks)
// before destroying the Dispatcher or anything the send callback captures.
class Dispatcher {
 public:
  using SendFn = std::function<void(const Json& message)>;

  Dispatcher(TaskPool& pool, SendFn send);

  void method(const std::string& name, Handler handler, Mode mode = Mode::Concurrent,
              Priority priority = Priority::Interactive);
  // `$/cancelRequest` is handled by the dispatcher itself, so a handler
  // registered under that name never runs.
  void notification(const std::string& name, NotificationHandler handler,
                    NotificationMode mode = NotificationMode::Inline);

  // Names of every registered request method, in sorted order.
  std::vector<std::string> methodNames() const;

  // Installs the hook that describes errors thrown without data.
  void setErrorData(ErrorDataFn errorData);

  // Routes messages that carry an id and a result or error but no method,
  // which answer requests this process sent to the client.
  void onResponse(ResponseHandler handler);

  // Cancels every request in flight, as if the client had cancelled each
  // one. Used when the client is gone, so nothing keeps git running for an
  // answer no one will read.
  void cancelAll();

  // Waits until no request is in flight or waiting to be routed, or until
  // `timeout` passes. Returns true when idle.
  bool waitIdle(std::chrono::milliseconds timeout);

  // Entry point for every inbound payload. Never throws; protocol-level
  // failures produce JSON-RPC error responses. Payloads over
  // kInlineParseLimit are parsed and routed on a worker. While such a parse,
  // or a payload queued behind one, waits to be routed, later payloads are
  // routed behind it, so every message is routed in arrival order; only
  // Inline notifications ($/cancelRequest) still run at once.
  void dispatch(std::string payload);

  // Number of requests currently registered as in flight (for tests).
  size_t inflight() const;

 private:
  // Arrival number of a payload queued on notificationStrand_ to be routed
  // later. Payloads routed as they arrive carry kRoutedOnArrival, which
  // orders them after every cancel already received.
  using Arrival = std::uint64_t;
  static constexpr Arrival kRoutedOnArrival = std::numeric_limits<Arrival>::max();

  void route(const std::string& payload, Arrival arrival);
  // Parses a payload, answering malformed ones with an error; nullopt when
  // there is nothing left to route.
  std::optional<Json> parse(const std::string& payload);
  void routeMessage(Json message, Arrival arrival);
  // A notification whose handler runs on the read loop.
  bool isInlineNotification(const Json& message) const;
  // Claims `size` bytes of the deferred-parse budget, or fails when the
  // budget is exhausted and the caller must parse inline instead.
  bool reserveDeferred(size_t size);
  // Counts a payload into the queue waiting to be routed and returns its
  // arrival number; finishQueuedRoute() counts it out once routed.
  Arrival queueRoute();
  void finishQueuedRoute();
  bool routesQueued() const;
  void runRequest(const Json& id, const std::string& methodName, Json params, Arrival arrival);
  void cancelRequest(const Json& params, Arrival arrival);
  static Json resultMessage(const Json& id, const Json& result);
  static Json errorMessage(const Json& id, const Error& error, const Json& data = nullptr);
  void sendError(const Json& id, const Error& error, const Json& data = nullptr);

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
  ErrorDataFn errorData_;
  ResponseHandler responseHandler_;

  std::mutex strandsMutex_;
  std::map<std::string, std::unique_ptr<Strand>> strands_;
  // Carries queued notification handlers, deferred parses, the payloads
  // routed behind them and the starts of AfterNotifications
  // requests, so all of them keep arrival order relative to each other.
  Strand notificationStrand_;
  std::atomic<size_t> deferredBytes_{0};

  mutable std::mutex inflightMutex_;
  std::condition_variable idle_;
  std::map<std::int64_t, CancelSource> inflight_;
  // Payloads on notificationStrand_ not yet routed (deferred parses and the
  // payloads routed behind one), and the arrival number given to the latest.
  size_t queuedRoutes_ = 0;
  Arrival lastQueued_ = 0;
  // Ids cancelled while their request may still be waiting to be routed,
  // each with the arrival number of the latest payload queued when the
  // cancel came: it applies to a request with that id queued up to then.
  // Kept only while payloads are queued and cleared once none are, so a
  // cancel that crosses the answer to its request never reaches a later
  // request reusing the id. Bounded so a client cannot grow it by
  // cancelling ids it never sends.
  std::map<std::int64_t, Arrival> earlyCancelled_;
};

}  // namespace gg::rpc
