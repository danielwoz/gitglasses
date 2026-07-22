#include <cstring>
#include <iostream>
#include <string>

#include "exec/sequence_editor.h"
#include "server.h"
#include "util/log.h"

namespace {

constexpr const char* kVersion = "0.1.0";

int printUsage() {
  std::cerr << "usage: gitglasses-engine --stdio [--log-level <level>]\n"
               "       gitglasses-engine --version\n"
               "       gitglasses-engine --edit-sequence <control-file> <todo-file>\n"
               "       gitglasses-engine --edit-message <control-file> <msg-file>\n";
  return 2;
}

}  // namespace

int main(int argc, char** argv) {
  gg::exec::setSelfPathFallback(argc > 0 ? argv[0] : nullptr);

  // Editor-shim modes: git re-invokes this binary as GIT_SEQUENCE_EDITOR /
  // GIT_EDITOR during an engine-driven interactive rebase.
  if (const auto shimExit = gg::exec::maybeRunEditorShim(argc, argv)) return *shimExit;

  bool stdio = false;
  std::string logLevel = "warn";

  for (int i = 1; i < argc; ++i) {
    const std::string arg = argv[i];
    if (arg == "--stdio") {
      stdio = true;
    } else if (arg == "--version") {
      std::cout << kVersion << "\n";
      return 0;
    } else if (arg == "--log-level" && i + 1 < argc) {
      logLevel = argv[++i];
    } else {
      return printUsage();
    }
  }

  if (!stdio) return printUsage();

  gg::log::init(logLevel);
  return gg::runServer(std::cin, std::cout);
}
