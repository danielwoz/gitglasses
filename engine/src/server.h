#pragma once

#include <atomic>
#include <iosfwd>

namespace gg {

namespace rpc {
class Dispatcher;
}
namespace services {
struct ServiceContext;
}

// Registers every protocol method (initialize, shutdown, all service
// methods) on the dispatcher. Shared by the stdio server loop and the wasm
// entry point, which differ only in transport.
void configureDispatcher(rpc::Dispatcher& dispatcher, services::ServiceContext& context,
                         std::atomic<bool>& shutdownRequested);

// Runs the engine over stdio until stdin closes. Returns the process exit
// code. Factored out of main() so tests can drive it over string streams.
int runServer(std::istream& in, std::ostream& out);

}  // namespace gg
