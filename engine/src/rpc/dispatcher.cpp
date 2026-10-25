#include "rpc/dispatcher.h"

#include <spdlog/spdlog.h>

#include "util/request_context.h"

namespace gg::rpc {

std::string dumpForWire(const Json& message) {
  return message.dump(/*indent=*/-1, /*indent_char=*/' ', /*ensure_ascii=*/false,
                      Json::error_handler_t::replace);
}

namespace {

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

}  // namespace

Dispatcher::Dispatcher(TaskPool& pool, SendFn send)
    : pool_(pool), send_(std::move(send)), notificationStrand_(pool, Priority::Interactive) {
  notification("$/cancelRequest", [this](Json params) { cancelRequest(params); });
}

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
  const auto deadline = std::chrono::steady_clock::now() + timeout;
  std::unique_lock lock(inflightMutex_);
  // Deferred parses register their request only once parsed, so the parse
  // budget in use counts as work outstanding too. Its counter is not guarded
  // by this mutex, hence the bounded waits.
  for (;;) {
    if (inflight_.empty() && deferredBytes_.load(std::memory_order_relaxed) == 0) return true;
    if (std::chrono::steady_clock::now() >= deadline) return false;
    idle_.wait_for(lock, std::chrono::milliseconds(20));
  }
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

void Dispatcher::dispatch(std::string payload) {
  const size_t size = payload.size();
  if (size > kInlineParseLimit && reserveDeferred(size)) {
    notificationStrand_.post([this, size, payload = std::move(payload)] {
      // Releases the budget however route() leaves, so a burst cannot wedge
      // deferral off permanently. The release pairs with the acquire below:
      // a payload that sees the budget drained also sees everything this
      // parse routed.
      struct Release {
        std::atomic<size_t>& counter;
        size_t size;
        ~Release() { counter.fetch_sub(size, std::memory_order_release); }
      } release{deferredBytes_, size};
      route(payload);
    });
    return;
  }
  if (deferredBytes_.load(std::memory_order_acquire) > 0) {
    // A deferred parse ahead of this payload has not routed its message yet,
    // and routing this one now would let it overtake: a blame request would
    // read the editor buffer the doc/didChange ahead of it replaces. The
    // payload is parsed here and routed behind the parse. Inline
    // notifications still run at once, so a $/cancelRequest is never held up;
    // one for a request still queued behind the parse is remembered for it.
    auto message = parse(payload);
    if (!message) return;
    if (isInlineNotification(*message)) {
      routeMessage(std::move(*message));
      return;
    }
    notificationStrand_.post(
        [this, message = std::move(*message)]() mutable { routeMessage(std::move(message)); });
    return;
  }
  route(payload);
}

void Dispatcher::route(const std::string& payload) {
  if (auto message = parse(payload)) routeMessage(std::move(*message));
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
  const auto it = notifications_.find(methodIt->get<std::string>());
  return it != notifications_.end() && it->second.mode == NotificationMode::Inline;
}

void Dispatcher::routeMessage(Json message) {
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

  runRequest(*idIt, methodName, std::move(params));
}

void Dispatcher::runRequest(const Json& id, const std::string& methodName, Json params) {
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

  {
    std::lock_guard lock(inflightMutex_);
    CancelSource& source = inflight_[numericId];
    // A cancel that arrived while this payload was waiting to be parsed
    // applies to it.
    if (const auto early = earlyCancelled_.find(numericId); early != earlyCancelled_.end()) {
      source.cancel();
      earlyCancelled_.erase(early);
    }
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
    {
      std::lock_guard lock(inflightMutex_);
      auto entry = inflight_.find(numericId);
      // The entry is registered before this task is posted, so a missing one
      // means a second request reused an id whose first request already
      // finished and erased it.
      if (entry == inflight_.end()) return;
      token = entry->second.token();
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

void Dispatcher::cancelRequest(const Json& params) {
  const auto idIt = params.find("id");
  if (idIt == params.end() || !idIt->is_number_integer()) return;
  const std::int64_t id = idIt->get<std::int64_t>();
  std::lock_guard lock(inflightMutex_);
  if (auto it = inflight_.find(id); it != inflight_.end()) {
    it->second.cancel();
    return;
  }
  // Unknown id: either already answered, or a request still waiting to be
  // parsed. Remembering it covers the second case.
  constexpr size_t kMaxEarlyCancelled = 1024;
  if (earlyCancelled_.size() < kMaxEarlyCancelled) earlyCancelled_.insert(id);
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
