cmake_minimum_required(VERSION 3.25)

# extension/package.json is the single source of the release version: the
# engine reports it from --version and initialize, and the release workflow
# checks the tag against it. Editing the manifest re-runs the configure step.
file(READ "${CMAKE_CURRENT_SOURCE_DIR}/extension/package.json" GG_EXTENSION_MANIFEST)
string(JSON GG_VERSION GET "${GG_EXTENSION_MANIFEST}" version)
set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS extension/package.json)

project(gitglasses VERSION ${GG_VERSION} LANGUAGES C CXX)

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
# Alpine builds link the engine fully statically against musl, so it has no
# runtime dependencies at all and runs on any Linux of the same architecture.
option(GG_FULLY_STATIC "Link the engine executable fully statically (Linux)" OFF)

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
  # Standard C functions (getenv, fopen) are used deliberately and portably.
  target_compile_definitions(gg_warnings INTERFACE _CRT_SECURE_NO_WARNINGS)
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
