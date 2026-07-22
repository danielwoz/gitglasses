// gtest entry point that doubles as the rebase editor shim: during the
// rebase E2E tests git re-invokes this binary as GIT_SEQUENCE_EDITOR /
// GIT_EDITOR, so the shim modes must be handled before gtest starts.

#include <gtest/gtest.h>

#include "exec/sequence_editor.h"

int main(int argc, char** argv) {
  gg::exec::setSelfPathFallback(argc > 0 ? argv[0] : nullptr);
  if (const auto shimExit = gg::exec::maybeRunEditorShim(argc, argv)) return *shimExit;
  ::testing::InitGoogleTest(&argc, argv);
  return RUN_ALL_TESTS();
}
