# Cross toolchain for local Windows verification: mingw-w64 on a Linux host.
# Used through the `mingw` preset as VCPKG_CHAINLOAD_TOOLCHAIN_FILE; the
# resulting binaries run under wine. CI's real Windows job builds with MSVC.

set(CMAKE_SYSTEM_NAME Windows)
set(CMAKE_SYSTEM_PROCESSOR x86_64)

set(CMAKE_C_COMPILER x86_64-w64-mingw32-gcc)
set(CMAKE_CXX_COMPILER x86_64-w64-mingw32-g++)
set(CMAKE_RC_COMPILER x86_64-w64-mingw32-windres)

# Appended, never set: vcpkg.cmake re-includes this file on every one of its
# own inclusions, and overwriting the list would drop the vcpkg-installed
# paths it prepends.
list(APPEND CMAKE_FIND_ROOT_PATH /usr/x86_64-w64-mingw32)
set(CMAKE_FIND_ROOT_PATH_MODE_PROGRAM NEVER)
set(CMAKE_FIND_ROOT_PATH_MODE_LIBRARY ONLY)
set(CMAKE_FIND_ROOT_PATH_MODE_INCLUDE ONLY)
set(CMAKE_FIND_ROOT_PATH_MODE_PACKAGE ONLY)

# Static libgcc/libstdc++/winpthread so test binaries run under wine without
# copying mingw runtime DLLs next to them.
set(CMAKE_EXE_LINKER_FLAGS_INIT "-static")

# Lets gtest_discover_tests (and ctest) execute the cross-built binaries.
set(CMAKE_CROSSCOMPILING_EMULATOR wine)
