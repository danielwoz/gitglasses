#pragma once

#include <spdlog/spdlog.h>

#include <string>

namespace gg::log {

// Configures the global logger. All engine logging goes to stderr (stdout is
// reserved exclusively for the JSON-RPC channel).
void init(const std::string& level);

}  // namespace gg::log
