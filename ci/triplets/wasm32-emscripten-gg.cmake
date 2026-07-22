# GitGlasses wasm triplet: stock community wasm32-emscripten plus a targeted
# diagnostic downgrade. libgit2 1.9's overflow-builtin selection passes
# size_t* (unsigned long* on Emscripten) where 32-bit platforms are assumed
# to use unsigned int*; identical width on wasm32, but clang >= 16 hard-errors
# on the pointer mismatch. Tracked upstream; revisit when libgit2 fixes it.

set(VCPKG_ENV_PASSTHROUGH_UNTRACKED EMSCRIPTEN_ROOT EMSDK PATH)

if(NOT DEFINED ENV{EMSCRIPTEN_ROOT})
   find_path(EMSCRIPTEN_ROOT "emcc")
else()
   set(EMSCRIPTEN_ROOT "$ENV{EMSCRIPTEN_ROOT}")
endif()

if(NOT EMSCRIPTEN_ROOT)
   if(NOT DEFINED ENV{EMSDK})
      message(FATAL_ERROR "The emcc compiler not found in PATH")
   endif()
   set(EMSCRIPTEN_ROOT "$ENV{EMSDK}/upstream/emscripten")
endif()

if(NOT EXISTS "${EMSCRIPTEN_ROOT}/cmake/Modules/Platform/Emscripten.cmake")
   message(FATAL_ERROR "Emscripten.cmake toolchain file not found")
endif()

set(VCPKG_TARGET_ARCHITECTURE wasm32)
set(VCPKG_CRT_LINKAGE dynamic)
set(VCPKG_LIBRARY_LINKAGE static)
set(VCPKG_CMAKE_SYSTEM_NAME Emscripten)
set(VCPKG_CHAINLOAD_TOOLCHAIN_FILE "${VCPKG_ROOT_DIR}/scripts/toolchains/emscripten.cmake")

set(VCPKG_C_FLAGS "-Wno-error=incompatible-pointer-types -Wno-incompatible-pointer-types")
set(VCPKG_CXX_FLAGS "")
