#pragma once

#include <cstdint>
#include <string>
#include <utility>

namespace gg {

// The client request a thread is running a handler for. Code far below the
// handler (a git invocation that ends up asking for a credential) reads it
// to say which request the prompt belongs to, without every service passing
// it down.
struct RequestContext {
  // JSON-RPC id of the request; -1 outside any request.
  std::int64_t id = -1;
  std::string method;
  // params.repoId of the request, when it names a repository.
  std::string repoId;
};

namespace detail {
inline thread_local RequestContext currentRequestContext;
}  // namespace detail

// The request the calling thread is serving, or an empty context.
inline const RequestContext& currentRequest() { return detail::currentRequestContext; }

// Makes `context` the calling thread's current request for its lifetime and
// restores the previous one afterwards.
class ScopedRequestContext {
 public:
  explicit ScopedRequestContext(RequestContext context)
      : previous_(std::exchange(detail::currentRequestContext, std::move(context))) {}
  ~ScopedRequestContext() { detail::currentRequestContext = std::move(previous_); }
  ScopedRequestContext(const ScopedRequestContext&) = delete;
  ScopedRequestContext& operator=(const ScopedRequestContext&) = delete;

 private:
  RequestContext previous_;
};

}  // namespace gg
