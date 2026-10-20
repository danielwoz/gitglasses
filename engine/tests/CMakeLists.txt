find_package(GTest CONFIG REQUIRED)

add_executable(engine_tests
  unit/test_main.cpp
  unit/test_harness_test.cpp
  unit/framing_test.cpp
  unit/dispatcher_test.cpp
  unit/registry_test.cpp
  unit/server_test.cpp
  unit/incremental_blame_test.cpp
  unit/git_process_test.cpp
  unit/blame_service_test.cpp
  unit/doc_overlay_test.cpp
  unit/blame_backend_parity_test.cpp
  unit/blame_session_test.cpp
  unit/no_cli_session_test.cpp
  unit/restricted_mode_test.cpp
  unit/history_log_parser_test.cpp
  unit/history_service_test.cpp
  unit/commit_service_test.cpp
  unit/rev_service_test.cpp
  unit/graph_service_test.cpp
  unit/status_service_test.cpp
  unit/sequence_editor_test.cpp
  unit/mutate_service_test.cpp
  unit/patch_service_test.cpp
  unit/rebase_service_test.cpp
  unit/sha256_test.cpp
  unit/hardening_test.cpp
  unit/watch_manager_test.cpp
  unit/protocol_contract_test.cpp
  unit/version_test.cpp
  ../src/server.cpp
)
target_include_directories(engine_tests PRIVATE ../src)
# The protocol contract test validates live responses against the JSON Schema
# artifact committed in the TypeScript protocol package.
target_compile_definitions(engine_tests PRIVATE
  GG_PROTOCOL_SCHEMA_PATH="${CMAKE_CURRENT_SOURCE_DIR}/../../packages/protocol/protocol.schema.json"
  GG_EXTENSION_MANIFEST_PATH="${PROJECT_SOURCE_DIR}/extension/package.json")
# The fixtures use std::fopen/std::getenv, which MSVC flags as "insecure".
if(MSVC)
  target_compile_definitions(engine_tests PRIVATE _CRT_SECURE_NO_WARNINGS)
endif()
target_link_libraries(engine_tests PRIVATE
  gg_rpc gg_repo gg_services gg_watch gg_version
  GTest::gtest GTest::gmock
  gg_warnings)

include(GoogleTest)
gtest_discover_tests(engine_tests DISCOVERY_TIMEOUT 30)

# The executable itself prints the project version and nothing else.
add_test(NAME engine_version_flag COMMAND gitglasses-engine --version)
set_tests_properties(engine_version_flag PROPERTIES
  PASS_REGULAR_EXPRESSION "^${PROJECT_VERSION}\r?\n$")
