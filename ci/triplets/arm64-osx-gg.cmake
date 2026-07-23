# Stock arm64-osx plus a pinned deployment target: the engine's macOS floor
# is 11.0 (Apple Silicon's minimum, and VS Code's own floor), chosen
# deliberately instead of inheriting whatever SDK the CI runner ships.
set(VCPKG_TARGET_ARCHITECTURE arm64)
set(VCPKG_CRT_LINKAGE dynamic)
set(VCPKG_LIBRARY_LINKAGE static)

set(VCPKG_CMAKE_SYSTEM_NAME Darwin)
set(VCPKG_OSX_ARCHITECTURES arm64)
set(VCPKG_OSX_DEPLOYMENT_TARGET 11.0)
