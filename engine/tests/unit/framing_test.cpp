#include "rpc/framing.h"

#include <gtest/gtest.h>

#include <sstream>

namespace gg::rpc {
namespace {

std::string frame(const std::string& payload) {
  return "Content-Length: " + std::to_string(payload.size()) + "\r\n\r\n" + payload;
}

TEST(FrameReader, ReadsSingleMessage) {
  std::istringstream in(frame(R"({"id":1})"));
  FrameReader reader(in);
  auto payload = reader.read();
  ASSERT_TRUE(payload.has_value());
  EXPECT_EQ(*payload, R"({"id":1})");
  EXPECT_FALSE(reader.read().has_value());
}

TEST(FrameReader, ReadsBackToBackMessages) {
  std::istringstream in(frame("aaa") + frame("bbbb"));
  FrameReader reader(in);
  EXPECT_EQ(reader.read(), "aaa");
  EXPECT_EQ(reader.read(), "bbbb");
  EXPECT_FALSE(reader.read().has_value());
}

TEST(FrameReader, SkipsUnknownHeaders) {
  std::istringstream in(
      "Content-Type: application/json\r\nContent-Length: 2\r\nX-Junk: 1\r\n\r\nok");
  FrameReader reader(in);
  EXPECT_EQ(reader.read(), "ok");
}

TEST(FrameReader, RejectsMissingContentLength) {
  std::istringstream in("Content-Type: application/json\r\n\r\nbody");
  FrameReader reader(in);
  EXPECT_FALSE(reader.read().has_value());
}

TEST(FrameReader, RejectsTruncatedPayload) {
  std::istringstream in("Content-Length: 100\r\n\r\nshort");
  FrameReader reader(in);
  EXPECT_FALSE(reader.read().has_value());
}

TEST(FrameReader, HandlesEmptyInput) {
  std::istringstream in("");
  FrameReader reader(in);
  EXPECT_FALSE(reader.read().has_value());
}

TEST(FrameWriter, RoundTripsThroughReader) {
  std::stringstream stream;
  FrameWriter writer(stream);
  writer.write(R"({"jsonrpc":"2.0"})");
  writer.write("second");

  FrameReader reader(stream);
  EXPECT_EQ(reader.read(), R"({"jsonrpc":"2.0"})");
  EXPECT_EQ(reader.read(), "second");
}

TEST(FrameWriter, HandlesPayloadWithEmbeddedNewlines) {
  std::stringstream stream;
  FrameWriter writer(stream);
  const std::string payload = "line1\r\n\r\nline2\nline3";
  writer.write(payload);

  FrameReader reader(stream);
  EXPECT_EQ(reader.read(), payload);
}

}  // namespace
}  // namespace gg::rpc
