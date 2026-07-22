#pragma once

#include <atomic>
#include <memory>
#include <stdexcept>

namespace gg {

struct CancelledError : std::runtime_error {
  CancelledError() : std::runtime_error("request cancelled") {}
};

// Copyable cancellation token. Cancellation is cooperative: long-running work
// must poll at natural boundaries (per hunk, per commit, per parsed line).
class CancelToken {
 public:
  CancelToken() : flag_(std::make_shared<std::atomic<bool>>(false)) {}

  bool cancelled() const noexcept { return flag_->load(std::memory_order_relaxed); }

  void throwIfCancelled() const {
    if (cancelled()) throw CancelledError();
  }

  static CancelToken none() { return CancelToken(); }

 private:
  friend class CancelSource;
  std::shared_ptr<std::atomic<bool>> flag_;
};

class CancelSource {
 public:
  CancelToken token() const { return token_; }
  void cancel() { token_.flag_->store(true, std::memory_order_relaxed); }
  bool cancelled() const { return token_.cancelled(); }

 private:
  CancelToken token_;
};

}  // namespace gg
