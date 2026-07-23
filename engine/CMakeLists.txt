if(EMSCRIPTEN)
  # Wasm build: one module target from the service/cache/core/rpc sources.
  # Excluded relative to native: exec/git_process.cpp + exec/cli_detect's
  # probe path (child processes replaced by src/wasm/git_process_stub.cpp),
  # watch/ (no watcher threads), util/log.cpp and spdlog/fmt (replaced by the
  # stderr shim under src/wasm/shim), main.cpp + sequence_editor.cpp (no
  # stdio loop, no editor shim re-exec).
  find_package(nlohmann_json CONFIG REQUIRED)
  find_package(libgit2 CONFIG REQUIRED)

  add_executable(gitglasses-engine-wasm
    src/wasm/wasm_main.cpp
    src/wasm/git_process_stub.cpp
    src/wasm/log_stub.cpp
    src/server.cpp
    src/util/sha256.cpp
    src/util/task_pool.cpp
    src/util/temp_file.cpp
    src/core/git2.cpp
    src/core/repo.cpp
    src/repo/registry.cpp
    src/exec/cli_detect.cpp
    src/exec/parsers/history_log.cpp
    src/exec/parsers/incremental_blame.cpp
    src/cache/blame_cache.cpp
    src/rpc/framing.cpp
    src/rpc/dispatcher.cpp
    src/services/blame/blame_service.cpp
    src/services/blame/blame_methods.cpp
    src/services/graph/graph_methods.cpp
    src/services/history/history_methods.cpp
    src/services/mutate/mutate_common.cpp
    src/services/mutate/mutate_methods.cpp
    src/services/mutate/rebase_methods.cpp
    src/services/mutate/stash_worktree_methods.cpp
    src/services/patch/patch_methods.cpp
    src/services/refs/refs_methods.cpp
    src/services/status/diff_common.cpp
    src/services/status/diff_methods.cpp
    src/services/status/stage_methods.cpp
    src/services/status/status_methods.cpp
    src/services/repo_methods.cpp
    src/services/rev_methods.cpp
  )
  target_include_directories(gitglasses-engine-wasm PRIVATE src src/wasm/shim)
  target_compile_definitions(gitglasses-engine-wasm PRIVATE GG_WASM)
  # Same warning posture as gg_warnings, minus warnings that only emsdk's
  # newer clang enables under -Wextra (native sources stay untouched).
  target_compile_options(gitglasses-engine-wasm PRIVATE
    -fexceptions
    -Wall -Wextra -Wpedantic
    $<$<BOOL:${GG_WARNINGS_AS_ERRORS}>:-Werror>
    -Wno-missing-designated-field-initializers)
  target_link_libraries(gitglasses-engine-wasm PRIVATE
    nlohmann_json::nlohmann_json
    libgit2::libgit2package)
  target_link_options(gitglasses-engine-wasm PRIVATE
    -fexceptions
    -sDISABLE_EXCEPTION_CATCHING=0
    -sMODULARIZE=1
    -sEXPORT_ES6=1
    "-sEXPORTED_FUNCTIONS=_gg_wasm_init,_gg_wasm_handle,_malloc,_free"
    "-sEXPORTED_RUNTIME_METHODS=ccall,cwrap,FS"
    -sALLOW_MEMORY_GROWTH=1
    # libgit2's status/blame paths need far more than the 64 KiB default.
    -sSTACK_SIZE=2097152
    -lnodefs.js
    "-sENVIRONMENT=node,worker")
  set_target_properties(gitglasses-engine-wasm PROPERTIES SUFFIX ".mjs")
else()

find_package(nlohmann_json CONFIG REQUIRED)
find_package(fmt CONFIG REQUIRED)
find_package(spdlog CONFIG REQUIRED)
find_package(libgit2 CONFIG REQUIRED)

if(WIN32)
  # Lean Win32 headers everywhere; keep min/max as functions, not macros.
  add_compile_definitions(NOMINMAX WIN32_LEAN_AND_MEAN)
  if(MSVC)
    add_compile_options(/utf-8)
    # Static triplets ship static-CRT libraries; the consuming targets must
    # match or the link fails with runtime-library mismatches.
    if(VCPKG_TARGET_TRIPLET MATCHES "-static$")
      set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")
    endif()
  endif()
endif()

# Layering (dependencies flow downward only):
#   rpc -> services -> {cache, repo, watch} -> {core, exec} -> util

add_library(gg_util STATIC
  src/util/log.cpp
  src/util/sha256.cpp
  src/util/task_pool.cpp
  src/util/temp_file.cpp
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

# Process spawning is the one per-platform source: posix_spawn process
# groups on POSIX, CreateProcessW + job objects on Windows.
if(WIN32)
  set(GG_GIT_PROCESS_SOURCE src/exec/git_process_win.cpp)
else()
  set(GG_GIT_PROCESS_SOURCE src/exec/git_process_posix.cpp)
endif()

add_library(gg_exec STATIC
  src/exec/cli_detect.cpp
  ${GG_GIT_PROCESS_SOURCE}
  src/exec/parsers/history_log.cpp
  src/exec/parsers/incremental_blame.cpp
  src/exec/sequence_editor.cpp
)
target_link_libraries(gg_exec
  PUBLIC gg_util
  PRIVATE nlohmann_json::nlohmann_json gg_warnings)

add_library(gg_cache STATIC
  src/cache/blame_cache.cpp
)
target_link_libraries(gg_cache PUBLIC gg_exec PRIVATE gg_warnings)

add_library(gg_watch STATIC
  src/watch/watch_manager.cpp
)
target_link_libraries(gg_watch PUBLIC gg_util PRIVATE gg_warnings)

add_library(gg_services STATIC
  src/services/blame/blame_service.cpp
  src/services/blame/blame_methods.cpp
  src/services/graph/graph_methods.cpp
  src/services/history/history_methods.cpp
  src/services/mutate/mutate_common.cpp
  src/services/mutate/mutate_methods.cpp
  src/services/mutate/rebase_methods.cpp
  src/services/mutate/stash_worktree_methods.cpp
  src/services/patch/patch_methods.cpp
  src/services/refs/refs_methods.cpp
  src/services/status/diff_common.cpp
  src/services/status/diff_methods.cpp
  src/services/status/stage_methods.cpp
  src/services/status/status_methods.cpp
  src/services/repo_methods.cpp
  src/services/rev_methods.cpp
)
target_link_libraries(gg_services
  PUBLIC gg_cache gg_core gg_exec gg_repo gg_rpc gg_watch
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

if(GG_STATIC_RUNTIME AND CMAKE_SYSTEM_NAME STREQUAL "Linux")
  target_link_options(gitglasses-engine PRIVATE -static-libstdc++ -static-libgcc)
endif()

if(GG_BUILD_TESTS)
  add_subdirectory(tests)
endif()

endif()
