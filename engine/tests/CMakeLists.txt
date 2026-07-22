find_package(GTest CONFIG REQUIRED)

add_executable(engine_tests
  unit/framing_test.cpp
  unit/dispatcher_test.cpp
  unit/registry_test.cpp
  unit/server_test.cpp
  unit/incremental_blame_test.cpp
  unit/git_process_test.cpp
  unit/blame_service_test.cpp
  unit/history_log_parser_test.cpp
  unit/history_service_test.cpp
  unit/watch_manager_test.cpp
  ../src/server.cpp
)
target_include_directories(engine_tests PRIVATE ../src)
target_link_libraries(engine_tests PRIVATE
  gg_rpc gg_repo gg_services gg_watch
  GTest::gtest GTest::gtest_main GTest::gmock
  gg_warnings)

include(GoogleTest)
gtest_discover_tests(engine_tests DISCOVERY_TIMEOUT 30)
