#pragma once

#include <iosfwd>

namespace gg {

// Runs the engine over stdio until stdin closes. Returns the process exit
// code. Factored out of main() so tests can drive it over string streams.
int runServer(std::istream& in, std::ostream& out);

}  // namespace gg
