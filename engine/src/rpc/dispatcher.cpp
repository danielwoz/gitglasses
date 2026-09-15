#include "rpc/dispatcher.h"

#include <spdlog/spdlog.h>

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
      if (escaped) escaped = false;
      else if (c == '\\') escaped = true;
      else if (c == '"') inString = false;
      continue;
    }
    if (c == '"') inString = true;
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
      // deferral off permanently.
      struct Release {
        std::atomic<size_t>& counter;
        size_t size;
        ~Release() { counter.fetch_sub(size, std::memory_order_relaxed); }
      } release{deferredBytes_, size};
      route(payload);
    });
    return;
  }
  route(payload);
}

void Dispatcher::route(const std::string& payload) {
  if (exceedsDepthLimit(payload)) {
    sendError(nullptr, {ErrorCode::InvalidRequest, "message nesting too deep"});
    return;
  }
  Json message = Json::parse(payload, nullptr, /*allow_exceptions=*/false);
  if (message.is_discarded() || !message.is_object()) {
    sendError(nullptr, {ErrorCode::InvalidRequest, "malformed JSON"});
    return;
  }

  const auto methodIt = message.find("method");
  if (methodIt == message.end() || !methodIt->is_string()) {
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
    if (const auto early = earlyCancelled_.find(numericId);
        early != earlyCancelled_.end()) {
      source.cancel();
      earlyCancelled_.erase(early);
    }
  }

  const MethodEntry& entry = it->second;
  Strand* strand = entry.mode == Mode::Concurrent ? nullptr : &strandFor(entry.mode, params);
  auto task = [this, id, numericId, handler = entry.handler, params = std::move(params)] {
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

    try {
      Json result = handler(params, token, notify);
      token.throwIfCancelled();
      sendResult(id, result);
    } catch (const CancelledError&) {
      sendError(id, {ErrorCode::Cancelled, "request cancelled"});
    } catch (const HandlerError& e) {
      sendError(id, e.error);
    } catch (const Json::type_error& e) {
      // nlohmann's value()/get<>() throw this on a param of the wrong JSON
      // type, which is the caller's mistake, so it maps to InvalidParams.
      sendError(id, {ErrorCode::InvalidParams, "invalid params: " + jsonExceptionDetail(e)});
    } catch (const Json::out_of_range& e) {
      sendError(id, {ErrorCode::InvalidParams, "invalid params: " + jsonExceptionDetail(e)});
    } catch (const std::exception& e) {
      spdlog::error("handler '{}' failed: {}", dumpForWire(id), e.what());
      sendError(id, {ErrorCode::Internal, e.what()});
    }

    std::lock_guard lock(inflightMutex_);
    inflight_.erase(numericId);
  };

  if (strand) {
    strand->post(std::move(task));
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

void Dispatcher::sendResult(const Json& id, const Json& result) {
  send_({{"jsonrpc", "2.0"}, {"id", id}, {"result", result}});
}

void Dispatcher::sendError(const Json& id, const Error& error) {
  send_({{"jsonrpc", "2.0"},
         {"id", id},
         {"error", {{"code", static_cast<int>(error.code)}, {"message", error.message}}}});
}

size_t Dispatcher::inflight() const {
  std::lock_guard lock(inflightMutex_);
  return inflight_.size();
}

}  // namespace gg::rpc
