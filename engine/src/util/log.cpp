#include "util/log.h"

#include <spdlog/sinks/stdout_color_sinks.h>

namespace gg::log {

void init(const std::string& level) {
  auto logger = spdlog::stderr_color_mt("engine");
  spdlog::set_default_logger(logger);
  spdlog::set_pattern("[%H:%M:%S.%e] [%^%l%$] %v");
  spdlog::set_level(spdlog::level::from_str(level));
}

}  // namespace gg::log
