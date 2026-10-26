#include "rpc/dispatcher.h"

#include <spdlog/spdlog.h>

#include <string_view>

#include "util/request_context.h"

namespace gg::rpc {

std::string dumpForWire(const Json& message) {
  return message.dump(/*indent=*/-1, /*indent_char=*/' ', /*ensure_ascii=*/false,
                      Json::error_handler_t::replace);
}

namespace {

// The notification that cancels a request. Like an Inline notification it
// runs on the read loop, so it is never held up behind the request it
// cancels. The dispatcher handles it itself rather than registering it,
// because a cancel for an id not in flight means something else when the
// cancel was itself parsed off the read loop.
constexpr std::string_view kCancelRequest = "$/cancelRequest";

// True when the payload nests deeper than kMaxParseDepth. Counts brackets
// outside strings, which is enough to answer before the parser (one recursion
// per level) sees the text.
bool exceedsDepthLimit(const std::string& payload) {
  int depth = 0;
  bool inString = false;
  bool escaped = false;
  for (const char c : payload) {
    if (inString) {
      if (escaped)
        escaped = false;
      else if (c == '\\')
        escaped = true;
      else if (c == '"')
        inString = false;
      continue;
    }
    if (c == '"')
      inString = true;
    else if (c == '[' || c == '{') {
      if (++depth > kMaxParseDepth) return true;
    } else if (c == ']' || c == '}') {
      --depth;
    }
  }
  return false;
}

// Explanation out of an nlohmann exception message. The library prefixes its
// text with "[json.exception...] ", which is noise to a client.
std::string jsonExceptionDetail(const std::exception& e) {
  std::string detail = e.what();
  if (const auto close = detail.find("] "); close != std::string::npos) {
    detail = detail.substr(close + 2);
  }
  return detail;
}

// Runs `onExit` when the scope ends, however it is left.
template <typename F>
class ScopeExit {
 public:
  explicit ScopeExit(F onExit) : onExit_(std::move(onExit)) {}
  ~ScopeExit() { onExit_(); }
  ScopeExit(const ScopeExit&) = delete;
  ScopeExit& operator=(const ScopeExit&) = delete;

 private:
  F onExit_;
};

}  // namespace

Dispatcher::Dispatcher(TaskPool& pool, SendFn send)
    : pool_(pool), send_(std::move(send)), notificationStrand_(pool, Priority::Interactive) {}

void Dispatcher::method(const std::string& name, Handler handler, Mode mode, Priority priority) {
  methods_[name] = {std::move(handler), mode, priority};
}

void Dispatcher::notification(const std::string& name, NotificationHandler handler,
                              NotificationMode mode) {
  notifications_[name] = {std::move(handler), mode};
}

void Dispatcher::setErrorData(ErrorDataFn errorData) { errorData_ = std::move(errorData); }

void Dispatcher::onResponse(ResponseHandler handler) { responseHandler_ = std::move(handler); }

void Dispatcher::cancelAll() {
  std::lock_guard lock(inflightMutex_);
  for (auto& [id, source] : inflight_) source.cancel();
}

bool Dispatcher::waitIdle(std::chrono::milliseconds timeout) {
  std::unique_lock lock(inflightMutex_);
  // A queued payload registers its request only once routed, so the queue
  // counts as work outstanding too.
  return idle_.wait_for(lock, timeout, [this] { return inflight_.empty() && queuedRoutes_ == 0; });
}

std::vector<std::string> Dispatcher::methodNames() const {
  std::vector<std::string> names;
  names.reserve(methods_.size());
  for (const auto& entry : methods_) names.push_back(entry.first);
  return names;
}

Strand& Dispatcher::strandFor(Mode mode, const Json& params) {
  std::string key = mode == Mode::SerialNetwork ? "net:" : "idx:";
  if (const auto it = params.find("repoId"); it != params.end() && it->is_string()) {
    key += it->get<std::string>();
  }
  std::lock_guard lock(strandsMutex_);
  auto& strand = strands_[key];
  if (!strand) strand = std::make_unique<Strand>(pool_, Priority::Interactive);
  return *strand;
}

bool Dispatcher::reserveDeferred(size_t size) {
  size_t outstanding = deferredBytes_.load(std::memory_order_relaxed);
  for (;;) {
    if (outstanding + size > kMaxDeferredParseBytes) return false;
    if (deferredBytes_.compare_exchange_weak(outstanding, outstanding + size,
                                             std::memory_order_relaxed)) {
      return true;
    }
  }
}

Dispatcher::Arrival Dispatcher::queueRoute() {
  std::lock_guard lock(inflightMutex_);
  ++queuedRoutes_;
  return ++lastQueued_;
}

void Dispatcher::finishQueuedRoute() {
  std::lock_guard lock(inflightMutex_);
  if (--queuedRoutes_ > 0) return;
  // Every request a remembered cancel could still be for has been routed.
  earlyCancelled_.clear();
  idle_.notify_all();
}

bool Dispatcher::routesQueued() const {
  std::lock_guard lock(inflightMutex_);
  return queuedRoutes_ > 0;
}

void Dispatcher::dispatch(std::string payload) {
  const size_t size = payload.size();
  if (size > kInlineParseLimit && reserveDeferred(size)) {
    const Arrival arrival = queueRoute();
    notificationStrand_.post([this, size, arrival, payload = std::move(payload)] {
      // Releases the budget and the queue slot however route() leaves, so a
      // burst cannot wedge deferral off or keep the dispatcher from idling.
      const ScopeExit done([this, size] {
        deferredBytes_.fetch_sub(size, std::memory_order_relaxed);
        finishQueuedRoute();
      });
      route(payload, arrival);
    });
    return;
  }
  if (routesQueued()) {
    // A payload ahead of this one has not been routed yet, and routing this
    // one now would let it overtake: a blame request would read the editor
    // buffer the doc/didChange ahead of it replaces. The payload is parsed
    // here and routed behind the queue. Inline notifications still run at
    // once, so a $/cancelRequest is never held up; one for a request still
    // queued is remembered for it.
    auto message = parse(payload);
    if (!message) return;
    if (isInlineNotification(*message)) {
      routeMessage(std::move(*message), kRoutedOnArrival);
      return;
    }
    const Arrival arrival = queueRoute();
    notificationStrand_.post([this, arrival, message = std::move(*message)]() mutable {
      const ScopeExit done([this] { finishQueuedRoute(); });
      routeMessage(std::move(message), arrival);
    });
    return;
  }
  route(payload, kRoutedOnArrival);
}

void Dispatcher::route(const std::string& payload, Arrival arrival) {
  if (auto message = parse(payload)) routeMessage(std::move(*message), arrival);
}

std::optional<Json> Dispatcher::parse(const std::string& payload) {
  if (exceedsDepthLimit(payload)) {
    sendError(nullptr, {ErrorCode::InvalidRequest, "message nesting too deep"});
    return std::nullopt;
  }
  Json message = Json::parse(payload, nullptr, /*allow_exceptions=*/false);
  if (message.is_discarded() || !message.is_object()) {
    sendError(nullptr, {ErrorCode::InvalidRequest, "malformed JSON"});
    return std::nullopt;
  }
  return message;
}

bool Dispatcher::isInlineNotification(const Json& message) const {
  const auto idIt = message.find("id");
  if (idIt != message.end() && !idIt->is_null()) return false;
  const auto methodIt = message.find("method");
  if (methodIt == message.end() || !methodIt->is_string()) return false;
  const auto& methodName = methodIt->get_ref<const std::string&>();
  if (methodName == kCancelRequest) return true;
  const auto it = notifications_.find(methodName);
  return it != notifications_.end() && it->second.mode == NotificationMode::Inline;
}

void Dispatcher::routeMessage(Json message, Arrival arrival) {
  const auto methodIt = message.find("method");
  if (methodIt == message.end() || !methodIt->is_string()) {
    // An answer to a request this process sent: it has an id and a result or
    // an error, and no method.
    if (methodIt == message.end() && message.contains("id") &&
        (message.contains("result") || message.contains("error"))) {
      if (responseHandler_) {
        responseHandler_(message);
      } else {
        spdlog::debug("ignoring a response to no outstanding request");
      }
      return;
    }
    sendError(message.value("id", Json()), {ErrorCode::InvalidRequest, "missing method"});
    return;
  }
  const std::string methodName = methodIt->get<std::string>();
  // A doc/didChange payload runs to tens of megabytes, so params is moved out
  // of the message instead of copied.
  const auto paramsIt = message.find("params");
  Json params = paramsIt != message.end() ? std::move(*paramsIt) : Json::object();

  const auto idIt = message.find("id");
  if (idIt == message.end() || idIt->is_null()) {
    if (methodName == kCancelRequest) {
      cancelRequest(params, arrival);
      return;
    }
    const auto it = notifications_.find(methodName);
    if (it == notifications_.end()) {
      spdlog::debug("ignoring unknown notification: {}", methodName);
      return;
    }
    if (it->second.mode == NotificationMode::Inline) {
      it->second.handler(std::move(params));
    } else {
      notificationStrand_.post(
          [handler = it->second.handler, params = std::move(params)]() mutable {
            handler(std::move(params));
          });
    }
    return;
  }

  runRequest(*idIt, methodName, std::move(params), arrival);
}

void Dispatcher::runRequest(const Json& id, const std::string& methodName, Json params,
                            Arrival arrival) {
  const auto it = methods_.find(methodName);
  if (it == methods_.end()) {
    sendError(id, {ErrorCode::MethodNotFound, "unknown method: " + methodName});
    return;
  }

  if (!id.is_number_integer()) {
    sendError(id, {ErrorCode::InvalidRequest, "request id must be an integer"});
    return;
  }
  const std::int64_t numericId = id.get<std::int64_t>();

  bool inUse = false;
  {
    std::lock_guard lock(inflightMutex_);
    const auto [slot, inserted] = inflight_.try_emplace(numericId);
    if (!inserted) {
      inUse = true;
    } else if (const auto early = earlyCancelled_.find(numericId); early != earlyCancelled_.end()) {
      // A cancel that arrived while this payload was waiting to be routed
      // applies to it. One that arrived before this payload did was for an
      // earlier request with the same id, already answered.
      if (arrival <= early->second) slot->second.cancel();
      earlyCancelled_.erase(early);
    }
  }
  if (inUse) {
    // Joining the entry of the request that holds the id would leave one of
    // the two without an answer, so this one is refused and the other keeps
    // running untouched.
    spdlog::warn("refusing request {} ('{}'): its id is already in flight", numericId, methodName);
    sendError(id, {ErrorCode::InvalidRequest,
                   "request id " + std::to_string(numericId) + " is already in use"});
    return;
  }

  const MethodEntry& entry = it->second;
  const bool serial = entry.mode == Mode::Serial || entry.mode == Mode::SerialNetwork;
  Strand* strand = serial ? &strandFor(entry.mode, params) : nullptr;
  RequestContext context{numericId, methodName, ""};
  if (const auto repoIt = params.find("repoId"); repoIt != params.end() && repoIt->is_string()) {
    context.repoId = repoIt->get<std::string>();
  }
  auto task = [this, id, numericId, handler = entry.handler, params = std::move(params),
               context = std::move(context)] {
    CancelToken token;
    bool registered = false;
    {
      std::lock_guard lock(inflightMutex_);
      // The entry is registered before this task is posted and only this
      // task erases it, since a request reusing the id meanwhile is refused
      // without touching it. Should it be missing all the same, the request
      // is answered with an error rather than left without a response.
      if (const auto entry = inflight_.find(numericId); entry != inflight_.end()) {
        token = entry->second.token();
        registered = true;
      }
    }
    if (!registered) {
      spdlog::warn("request {} ('{}') lost its in-flight entry before it started", numericId,
                   context.method);
      sendError(id, {ErrorCode::Internal, "request is no longer in flight"});
      return;
    }

    NotifyFn notify = [this](const std::string& method, const Json& notifyParams) {
      send_({{"jsonrpc", "2.0"}, {"method", method}, {"params", notifyParams}});
    };

    Json response;
    try {
      const ScopedRequestContext scope(context);
      Json result = handler(params, token, notify);
      token.throwIfCancelled();
      response = resultMessage(id, result);
    } catch (const CancelledError&) {
      response = errorMessage(id, {ErrorCode::Cancelled, "request cancelled"});
    } catch (const HandlerError& e) {
      Json data = e.data;
      if (data.is_null() && errorData_) data = errorData_(e.error);
      response = errorMessage(id, e.error, data);
    } catch (const Json::type_error& e) {
      // nlohmann's value()/get<>() throw this on a param of the wrong JSON
      // type, which is the caller's mistake, so it maps to InvalidParams.
      response =
          errorMessage(id, {ErrorCode::InvalidParams, "invalid params: " + jsonExceptionDetail(e)});
    } catch (const Json::out_of_range& e) {
      response =
          errorMessage(id, {ErrorCode::InvalidParams, "invalid params: " + jsonExceptionDetail(e)});
    } catch (const std::exception& e) {
      spdlog::error("handler '{}' failed: {}", dumpForWire(id), e.what());
      response = errorMessage(id, {ErrorCode::Internal, e.what()});
    }

    // The entry goes before the client can see the answer: a client that
    // reuses the id once it has its response starts a request of its own
    // instead of joining this one's entry and losing it to this erase.
    {
      std::lock_guard lock(inflightMutex_);
      inflight_.erase(numericId);
    }
    send_(response);
    {
      std::lock_guard lock(inflightMutex_);
      if (inflight_.empty()) idle_.notify_all();
    }
  };

  if (strand) {
    strand->post(std::move(task));
  } else if (entry.mode == Mode::AfterNotifications) {
    // Starts once the Queued notifications routed ahead of it have run. The
    // handler itself runs on the pool, so a slow one never holds up the
    // notification strand.
    notificationStrand_.post([this, priority = entry.priority, task = std::move(task)]() mutable {
      pool_.post(priority, std::move(task));
    });
  } else {
    pool_.post(entry.priority, std::move(task));
  }
}

void Dispatcher::cancelRequest(const Json& params, Arrival arrival) {
  const auto idIt = params.find("id");
  if (idIt == params.end() || !idIt->is_number_integer()) return;
  const std::int64_t id = idIt->get<std::int64_t>();
  std::lock_guard lock(inflightMutex_);
  if (auto it = inflight_.find(id); it != inflight_.end()) {
    it->second.cancel();
    return;
  }
  // Unknown id: already answered, or a request still waiting to be routed.
  // Only the second needs remembering. Nothing is waiting when no payload is
  // queued, nor ahead of a cancel that was itself queued: every request sent
  // before it has been routed by the time it runs.
  if (arrival != kRoutedOnArrival || queuedRoutes_ == 0) return;
  constexpr size_t kMaxEarlyCancelled = 1024;
  if (earlyCancelled_.size() < kMaxEarlyCancelled || earlyCancelled_.contains(id)) {
    earlyCancelled_[id] = lastQueued_;
  }
}

Json Dispatcher::resultMessage(const Json& id, const Json& result) {
  return {{"jsonrpc", "2.0"}, {"id", id}, {"result", result}};
}

Json Dispatcher::errorMessage(const Json& id, const Error& error, const Json& data) {
  Json body = {{"code", static_cast<int>(error.code)}, {"message", error.message}};
  if (!data.is_null()) body["data"] = data;
  return {{"jsonrpc", "2.0"}, {"id", id}, {"error", std::move(body)}};
}

void Dispatcher::sendError(const Json& id, const Error& error, const Json& data) {
  send_(errorMessage(id, error, data));
}

size_t Dispatcher::inflight() const {
  std::lock_guard lock(inflightMutex_);
  return inflight_.size();
}

}  // namespace gg::rpc
