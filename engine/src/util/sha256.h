#pragma once

#include <string>
#include <string_view>

namespace gg::util {

// Hex-encoded (lowercase) SHA-256 digest of `data`, per FIPS 180-4. Used for
// remote-URL fingerprints in patch envelopes; libgit2 has no public SHA-256
// API, so the engine carries its own single-shot implementation.
std::string sha256Hex(std::string_view data);

}  // namespace gg::util
