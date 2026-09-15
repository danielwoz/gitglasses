#include "cache/doc_overlay.h"

#include <gtest/gtest.h>

#include <string>

namespace gg::cache {
namespace {

TEST(DocOverlay, StoresAndReplacesByRepoAndPath) {
  DocOverlay overlay;
  overlay.update("r1", "a.txt", "one", 1);
  overlay.update("r2", "a.txt", "two", 1);

  auto first = overlay.get("r1", "a.txt");
  ASSERT_TRUE(first.has_value());
  EXPECT_EQ(first->contents, "one");
  EXPECT_EQ(overlay.get("r2", "a.txt")->contents, "two");
  EXPECT_FALSE(overlay.get("r1", "b.txt").has_value());

  overlay.update("r1", "a.txt", "one-edited", 2);
  EXPECT_EQ(overlay.get("r1", "a.txt")->contents, "one-edited");
  EXPECT_EQ(overlay.get("r1", "a.txt")->version, 2);
}

TEST(DocOverlay, RefusesDocumentsOverThePerDocumentCap) {
  DocOverlay overlay(/*maxDocBytes=*/16, /*budget=*/1024);
  overlay.update("r1", "a.txt", "small", 1);
  ASSERT_TRUE(overlay.get("r1", "a.txt").has_value());

  // Oversized replacement drops the stored version too: an older buffer is
  // worse than falling back to the file on disk.
  overlay.update("r1", "a.txt", std::string(64, 'x'), 2);
  EXPECT_FALSE(overlay.get("r1", "a.txt").has_value());
  EXPECT_EQ(overlay.bytesUsed(), 0u);
}

TEST(DocOverlay, EvictsLeastRecentlyUsedToStayUnderBudget) {
  const std::string body(100, 'x');
  DocOverlay overlay(/*maxDocBytes=*/1024, /*budget=*/350);
  overlay.update("r1", "a.txt", body, 1);
  overlay.update("r1", "b.txt", body, 1);
  overlay.update("r1", "c.txt", body, 1);
  EXPECT_LE(overlay.bytesUsed(), 350u);

  // Touch a.txt so b.txt becomes the eviction candidate.
  ASSERT_TRUE(overlay.get("r1", "a.txt").has_value());
  overlay.update("r1", "d.txt", body, 1);

  EXPECT_LE(overlay.bytesUsed(), 350u);
  EXPECT_TRUE(overlay.get("r1", "a.txt").has_value());
  EXPECT_TRUE(overlay.get("r1", "d.txt").has_value());
  EXPECT_FALSE(overlay.get("r1", "b.txt").has_value());
}

TEST(DocOverlay, CloseRepoDropsOnlyThatRepo) {
  DocOverlay overlay;
  overlay.update("r1", "a.txt", "one", 1);
  overlay.update("r1", "b.txt", "two", 1);
  overlay.update("r2", "a.txt", "three", 1);

  overlay.closeRepo("r1");
  EXPECT_FALSE(overlay.get("r1", "a.txt").has_value());
  EXPECT_FALSE(overlay.get("r1", "b.txt").has_value());
  EXPECT_TRUE(overlay.get("r2", "a.txt").has_value());
}

}  // namespace
}  // namespace gg::cache
