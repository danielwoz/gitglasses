find_package(nlohmann_json CONFIG REQUIRED)
find_package(fmt CONFIG REQUIRED)
find_package(spdlog CONFIG REQUIRED)
find_package(libgit2 CONFIG REQUIRED)

# Layering (dependencies flow downward only):
#   rpc -> services -> {cache, repo, watch} -> {core, exec} -> util

add_library(gg_util STATIC
  src/util/log.cpp
  src/util/task_pool.cpp
)
target_include_directories(gg_util PUBLIC src)
target_link_libraries(gg_util PUBLIC fmt::fmt spdlog::spdlog PRIVATE gg_warnings)

add_library(gg_core STATIC
  src/core/git2.cpp
  src/core/repo.cpp
)
target_link_libraries(gg_core
  PUBLIC gg_util libgit2::libgit2package
  PRIVATE gg_warnings)

add_library(gg_repo STATIC
  src/repo/registry.cpp
)
target_link_libraries(gg_repo PUBLIC gg_core PRIVATE gg_warnings)

add_library(gg_exec STATIC
  src/exec/git_process.cpp
  src/exec/parsers/incremental_blame.cpp
)
target_link_libraries(gg_exec PUBLIC gg_util PRIVATE gg_warnings)

add_library(gg_cache STATIC
  src/cache/blame_cache.cpp
)
target_link_libraries(gg_cache PUBLIC gg_exec PRIVATE gg_warnings)

add_library(gg_services STATIC
  src/services/blame/blame_service.cpp
  src/services/blame/blame_methods.cpp
  src/services/repo_methods.cpp
)
target_link_libraries(gg_services
  PUBLIC gg_cache gg_core gg_exec gg_repo gg_rpc
  PRIVATE gg_warnings)

add_library(gg_rpc STATIC
  src/rpc/framing.cpp
  src/rpc/dispatcher.cpp
)
target_link_libraries(gg_rpc
  PUBLIC gg_util nlohmann_json::nlohmann_json
  PRIVATE gg_warnings)

add_executable(gitglasses-engine
  src/main.cpp
  src/server.cpp
)
target_link_libraries(gitglasses-engine PRIVATE gg_rpc gg_repo gg_services gg_warnings)

if(GG_BUILD_TESTS)
  add_subdirectory(tests)
endif()
