// Known-answer tests for the local SHA-256 implementation (FIPS 180-4 and
// NIST CAVP vectors).

#include <gtest/gtest.h>

#include <string>

#include "util/sha256.h"

namespace gg {
namespace {

TEST(Sha256, EmptyInput) {
  EXPECT_EQ(util::sha256Hex(""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
}

TEST(Sha256, ShortVectors) {
  EXPECT_EQ(util::sha256Hex("abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  EXPECT_EQ(util::sha256Hex("The quick brown fox jumps over the lazy dog"),
            "d7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592");
  // 56 bytes: padding spills into a second block.
  EXPECT_EQ(util::sha256Hex("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"),
            "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1");
}

TEST(Sha256, MillionRepeatedBytes) {
  EXPECT_EQ(util::sha256Hex(std::string(1000000, 'a')),
            "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0");
}

}  // namespace
}  // namespace gg
