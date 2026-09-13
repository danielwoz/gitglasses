#include "rpc/dispatcher.h"

#include <spdlog/spdlog.h>

namespace gg::rpc {

std::string dumpForWire(const Json& message) {
  return message.dump(/*indent=*/-1, /*indent_char=*/' ', /*ensure_ascii=*/false,
                      Json::error_handler_t::replace);
}

namespace {

// Rejects payloads nested deeper than kMaxParseDepth before handing them to
// the parser, which recurses per level and would otherwise overflow the stack.
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
    : pool_(pool), send_(std::move(send)), serialStrand_(pool, Priority::Interactive) {
  notification("$/cancelRequest", [this](const Json& params) { cancelRequest(params); });
}

void Dispatcher::method(const std::string& name, Handler handler, Mode mode, Priority priority) {
  methods_[name] = {std::move(handler), mode, priority};
}

void Dispatcher::notification(const std::string& name, NotificationHandler handler) {
  notifications_[name] = std::move(handler);
}

void Dispatcher::dispatch(const std::string& payload) {
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
  Json params = message.value("params", Json::object());

  const auto idIt = message.find("id");
  if (idIt == message.end() || idIt->is_null()) {
    if (auto it = notifications_.find(methodName); it != notifications_.end()) {
      it->second(params);
    } else {
      spdlog::debug("ignoring unknown notification: {}", methodName);
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

  CancelToken token;
  {
    std::lock_guard lock(inflightMutex_);
    token = inflight_[numericId].token();
  }

  const MethodEntry& entry = it->second;
  auto task = [this, id, numericId, handler = entry.handler, params = std::move(params)] {
    CancelToken token;
    {
      std::lock_guard lock(inflightMutex_);
      auto entry = inflight_.find(numericId);
      if (entry == inflight_.end()) return;  // cancelled before we started
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
      // A param of the wrong JSON type is the caller's mistake, not ours:
      // nlohmann's value()/get<>() throw here and would otherwise be reported
      // as Internal.
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

  if (entry.mode == Mode::Serial) {
    serialStrand_.post(std::move(task));
  } else {
    pool_.post(entry.priority, std::move(task));
  }
}

void Dispatcher::cancelRequest(const Json& params) {
  const auto idIt = params.find("id");
  if (idIt == params.end() || !idIt->is_number_integer()) return;
  std::lock_guard lock(inflightMutex_);
  if (auto it = inflight_.find(idIt->get<std::int64_t>()); it != inflight_.end()) {
    it->second.cancel();
  }
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
