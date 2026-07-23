cmake_minimum_required(VERSION 3.25)

project(gitglasses VERSION 0.1.0 LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

option(GG_BUILD_TESTS "Build engine tests" ON)
option(GG_WARNINGS_AS_ERRORS "Treat warnings as errors" ON)
option(GG_SINGLE_THREADED "Run all tasks inline on the caller (no worker threads)" OFF)
# Release builds ship with libstdc++/libgcc linked statically so the binary's
# only dynamic dependency is glibc (whose floor is set by building in a
# glibc-2.28 container, matching VS Code's own minimum).
option(GG_STATIC_RUNTIME "Statically link libstdc++ and libgcc (Linux)" OFF)

# Wasm has no worker pool, watcher threads, or child processes.
if(EMSCRIPTEN)
  set(GG_SINGLE_THREADED ON)
  set(GG_BUILD_TESTS OFF)
endif()

if(GG_SINGLE_THREADED)
  add_compile_definitions(GG_SINGLE_THREADED)
endif()

add_library(gg_warnings INTERFACE)
if(MSVC)
  target_compile_options(gg_warnings INTERFACE /W4 $<$<BOOL:${GG_WARNINGS_AS_ERRORS}>:/WX>)
else()
  target_compile_options(gg_warnings INTERFACE
    -Wall -Wextra -Wpedantic
    # -Wextra's missing-field-initializers fires on C++20 designated
    # initializers with omitted (value-initialized) members on GCC <= 14,
    # which is idiomatic usage throughout this codebase; GCC 15 agrees and
    # no longer warns.
    -Wno-missing-field-initializers
    $<$<BOOL:${GG_WARNINGS_AS_ERRORS}>:-Werror>)
endif()

if(GG_BUILD_TESTS)
  enable_testing()
endif()

add_subdirectory(engine)
