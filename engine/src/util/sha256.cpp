#include "util/sha256.h"

#include <array>
#include <cstddef>
#include <cstdint>

namespace gg::util {

namespace {

// Round constants: fractional parts of the cube roots of the first 64 primes.
constexpr std::array<std::uint32_t, 64> kRoundConstants = {
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4,
    0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
    0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
    0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
    0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
    0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
    0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116,
    0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
    0xc67178f2};

std::uint32_t rotr(std::uint32_t value, int bits) {
  return (value >> bits) | (value << (32 - bits));
}

void compressBlock(std::array<std::uint32_t, 8>& state, const unsigned char* block) {
  std::array<std::uint32_t, 64> schedule;
  for (int i = 0; i < 16; ++i) {
    schedule[static_cast<size_t>(i)] =
        (static_cast<std::uint32_t>(block[4 * i]) << 24) |
        (static_cast<std::uint32_t>(block[4 * i + 1]) << 16) |
        (static_cast<std::uint32_t>(block[4 * i + 2]) << 8) |
        static_cast<std::uint32_t>(block[4 * i + 3]);
  }
  for (size_t i = 16; i < 64; ++i) {
    const std::uint32_t s0 =
        rotr(schedule[i - 15], 7) ^ rotr(schedule[i - 15], 18) ^ (schedule[i - 15] >> 3);
    const std::uint32_t s1 =
        rotr(schedule[i - 2], 17) ^ rotr(schedule[i - 2], 19) ^ (schedule[i - 2] >> 10);
    schedule[i] = schedule[i - 16] + s0 + schedule[i - 7] + s1;
  }

  std::uint32_t a = state[0], b = state[1], c = state[2], d = state[3];
  std::uint32_t e = state[4], f = state[5], g = state[6], h = state[7];
  for (size_t i = 0; i < 64; ++i) {
    const std::uint32_t s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
    const std::uint32_t ch = (e & f) ^ (~e & g);
    const std::uint32_t temp1 = h + s1 + ch + kRoundConstants[i] + schedule[i];
    const std::uint32_t s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
    const std::uint32_t maj = (a & b) ^ (a & c) ^ (b & c);
    const std::uint32_t temp2 = s0 + maj;
    h = g;
    g = f;
    f = e;
    e = d + temp1;
    d = c;
    c = b;
    b = a;
    a = temp1 + temp2;
  }
  state[0] += a;
  state[1] += b;
  state[2] += c;
  state[3] += d;
  state[4] += e;
  state[5] += f;
  state[6] += g;
  state[7] += h;
}

}  // namespace

std::string sha256Hex(std::string_view data) {
  // Initial state: fractional parts of the square roots of the first 8 primes.
  std::array<std::uint32_t, 8> state = {0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
                                        0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19};

  size_t offset = 0;
  for (; offset + 64 <= data.size(); offset += 64) {
    compressBlock(state, reinterpret_cast<const unsigned char*>(data.data() + offset));
  }

  // Final block(s): 0x80 terminator, zero padding, 64-bit big-endian bit count.
  std::array<unsigned char, 128> tail{};
  const size_t remaining = data.size() - offset;
  for (size_t i = 0; i < remaining; ++i) {
    tail[i] = static_cast<unsigned char>(data[offset + i]);
  }
  tail[remaining] = 0x80;
  const size_t tailBlocks = remaining < 56 ? 1 : 2;
  const std::uint64_t bitCount = static_cast<std::uint64_t>(data.size()) * 8;
  for (int i = 0; i < 8; ++i) {
    tail[tailBlocks * 64 - 1 - static_cast<size_t>(i)] =
        static_cast<unsigned char>((bitCount >> (8 * i)) & 0xff);
  }
  compressBlock(state, tail.data());
  if (tailBlocks == 2) compressBlock(state, tail.data() + 64);

  static constexpr char kHexDigits[] = "0123456789abcdef";
  std::string hex;
  hex.reserve(64);
  for (const std::uint32_t word : state) {
    for (int shift = 28; shift >= 0; shift -= 4) {
      hex.push_back(kHexDigits[(word >> shift) & 0xf]);
    }
  }
  return hex;
}

}  // namespace gg::util
