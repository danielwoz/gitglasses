#pragma once

#include <nlohmann/json.hpp>

#include <functional>
#include <map>
#include <mutex>
#include <string>

#include "util/cancel.h"
#include "util/result.h"
#include "util/strand.h"
#include "util/task_pool.h"

namespace gg::rpc {

using Json = nlohmann::json;

// Sends a server->client notification (used by streaming handlers).
using NotifyFn = std::function<void(const std::string& method, const Json& params)>;

// A request handler. Runs on the task pool. Returns the JSON-RPC result, or
// throws gg::Error (as HandlerError) / gg::CancelledError.
using Handler = std::function<Json(const Json& params, const CancelToken&, const NotifyFn&)>;

// A notification handler. Runs inline on the read loop, so it must be cheap.
using NotificationHandler = std::function<void(const Json& params)>;

struct HandlerError {
  Error error;
};

// Serial handlers run in request-submission order on a shared FIFO strand —
// the default, because clients depend on ordering for state-changing methods.
// Concurrent handlers may overlap each other and serial work; long-running
// cancellable reads (blame, search) opt in.
enum class Mode { Serial, Concurrent };

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

  void method(const std::string& name, Handler handler, Mode mode = Mode::Serial,
              Priority priority = Priority::Interactive);
  void notification(const std::string& name, NotificationHandler handler);

  // Entry point for every inbound payload. Never throws; protocol-level
  // failures produce JSON-RPC error responses.
  void dispatch(const std::string& payload);

  // Number of requests currently registered as in flight (for tests).
  size_t inflight() const;

 private:
  void runRequest(const Json& id, const std::string& methodName, Json params);
  void cancelRequest(const Json& params);
  void sendResult(const Json& id, const Json& result);
  void sendError(const Json& id, const Error& error);

  struct MethodEntry {
    Handler handler;
    Mode mode;
    Priority priority;
  };

  TaskPool& pool_;
  SendFn send_;
  Strand serialStrand_;
  std::map<std::string, MethodEntry> methods_;
  std::map<std::string, NotificationHandler> notifications_;

  mutable std::mutex inflightMutex_;
  std::map<std::int64_t, CancelSource> inflight_;
};

}  // namespace gg::rpc
