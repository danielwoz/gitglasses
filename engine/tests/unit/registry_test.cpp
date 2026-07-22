#include "repo/registry.h"

#include <gtest/gtest.h>

#include "core/git2.h"
#include "test_fixtures.h"

namespace gg::repo {
namespace {

struct RegistryTest : ::testing::Test {
  core::LibGit2 libgit2;
  gg::testing::FixtureRepo fixture;
  Registry registry;
};

TEST_F(RegistryTest, DiscoversRepoFromSubdirectory) {
  fixture.writeFile("src/deep/file.txt", "hello\n");

  auto info = registry.add((fixture.root() / "src" / "deep").string());
  ASSERT_TRUE(info.ok()) << info.error().message;
  EXPECT_EQ(info.value().id, "r1");
  EXPECT_FALSE(info.value().bare);

  // Registered root should be the working-directory root, not the subdir.
  auto canonical = std::filesystem::canonical(info.value().rootPath);
  EXPECT_EQ(canonical, std::filesystem::canonical(fixture.root()));
}

TEST_F(RegistryTest, ReusesEntryForSameRepo) {
  auto first = registry.add(fixture.root().string());
  ASSERT_TRUE(first.ok());
  auto second = registry.add((fixture.root()).string() + "/.");
  ASSERT_TRUE(second.ok());
  EXPECT_EQ(first.value().id, second.value().id);
  EXPECT_EQ(registry.list().size(), 1u);
}

TEST_F(RegistryTest, FailsOutsideAnyRepo) {
  auto info = registry.add(std::filesystem::temp_directory_path().string());
  ASSERT_FALSE(info.ok());
  EXPECT_EQ(info.error().code, ErrorCode::RepoNotFound);
}

TEST_F(RegistryTest, OpensHeadOfRegisteredRepo) {
  auto info = registry.add(fixture.root().string());
  ASSERT_TRUE(info.ok());

  auto repo = registry.open(info.value().id);
  ASSERT_TRUE(repo.ok());
  auto head = repo.value().head();
  ASSERT_TRUE(head.ok()) << head.error().message;
  EXPECT_EQ(head.value().branch, "main");
  EXPECT_EQ(head.value().oid.size(), 40u);
  EXPECT_FALSE(head.value().detached);
  EXPECT_FALSE(head.value().unborn);
}

TEST_F(RegistryTest, UnknownIdFails) {
  auto repo = registry.open("r999");
  ASSERT_FALSE(repo.ok());
  EXPECT_EQ(repo.error().code, ErrorCode::RepoNotFound);
}

TEST_F(RegistryTest, RemoveForgetsRepo) {
  auto info = registry.add(fixture.root().string());
  ASSERT_TRUE(info.ok());
  registry.remove(info.value().id);
  EXPECT_TRUE(registry.list().empty());
  EXPECT_FALSE(registry.open(info.value().id).ok());
}

}  // namespace
}  // namespace gg::repo
