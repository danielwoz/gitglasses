// Wasm build: logging is a plain stderr shim (see shim/spdlog/spdlog.h);
// there is no logger to configure.

#include "util/log.h"

namespace gg::log {

void init(const std::string&) {}

}  // namespace gg::log
