// gtest entry point that doubles as the engine's shims: during the rebase
// E2E tests git re-invokes this binary as GIT_SEQUENCE_EDITOR / GIT_EDITOR,
// and during the prompt tests as GIT_ASKPASS / SSH_ASKPASS and gpg.program,
// so the shim modes must be handled before gtest starts.

#include <gtest/gtest.h>

#include <filesystem>
#include <fstream>
#include <system_error>

#include "exec/askpass.h"
#include "exec/sequence_editor.h"
#include "test_fixtures.h"

namespace {

// Gives each test process a git global config of its own, so the suite never
// reads or depends on the developer's ~/.gitconfig (hooks, signing, aliases)
// and commits made outside a fixture's repo-local identity still have an
// author. Child processes, including the git the engine spawns, inherit it.
class GitConfigEnvironment : public ::testing::Environment {
 public:
  void SetUp() override {
    dir_ = gg::testing::makeTempDir("gg-gitconfig-");
    const std::filesystem::path config = dir_ / "config";
    std::ofstream(config, std::ios::binary)
        << "[user]\n\tname = GitGlasses Tests\n\temail = tests@example.invalid\n";
    gg::testing::setEnvVar("GIT_CONFIG_GLOBAL", config.string());
    gg::testing::setEnvVar("GIT_CONFIG_NOSYSTEM", "1");
  }

  void TearDown() override {
    std::error_code ec;
    std::filesystem::remove_all(dir_, ec);
  }

 private:
  std::filesystem::path dir_;
};

}  // namespace

int main(int argc, char** argv) {
  gg::exec::setSelfPathFallback(argc > 0 ? argv[0] : nullptr);
  if (const auto shimExit = gg::exec::maybeRunEditorShim(argc, argv)) return *shimExit;
  if (const auto shimExit = gg::exec::maybeRunAskpassShim(argc, argv)) return *shimExit;
  if (const auto shimExit = gg::exec::maybeRunGpgShim(argc, argv)) return *shimExit;
  ::testing::InitGoogleTest(&argc, argv);
  ::testing::AddGlobalTestEnvironment(new GitConfigEnvironment);
  return RUN_ALL_TESTS();
}
