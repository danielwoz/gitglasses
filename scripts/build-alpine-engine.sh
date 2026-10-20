#!/bin/sh
# Builds the engine for the alpine-x64 and alpine-arm64 targets: a fully
# static executable linked against musl, so it needs nothing from the host
# and also runs on glibc distributions of the same architecture.
#
# Runs as root inside an Alpine container with the repository mounted, on a
# host of the target architecture:
#   docker run --rm -v "$PWD:/src" alpine:3.22 sh /src/scripts/build-alpine-engine.sh
#
# The engine lands in build/alpine-<arch>/engine/gitglasses-engine. vcpkg,
# its binary cache and the installed dependencies live under $GG_CACHE
# (default: .cache/alpine-<arch> in the repository), so later runs reuse
# them. Set GG_SKIP_TESTS=1 to skip ctest.
set -eu

src=$(cd "$(dirname "$0")/.." && pwd)
case "$(uname -m)" in
  x86_64) arch=x64 triplet=x64-linux ;;
  aarch64) arch=arm64 triplet=arm64-linux ;;
  *) echo "build-alpine-engine: unsupported architecture $(uname -m)" >&2; exit 1 ;;
esac
if [ ! -e /etc/alpine-release ]; then
  echo "build-alpine-engine: run this inside an Alpine container" >&2
  exit 1
fi

cache=${GG_CACHE:-$src/.cache/alpine-$arch}
build=$src/build/alpine-$arch
mkdir -p "$cache" "$build"

# The container runs as root; hand the outputs back to the checkout's owner
# however the build ends.
owner=$(stat -c %u:%g "$src")
trap 'chown -R "$owner" "$build" "$cache"' EXIT

# vcpkg runs on Alpine only with the system's cmake and ninja.
apk add --no-cache build-base cmake samurai git curl zip unzip tar pkgconf linux-headers >/dev/null
# Configured from / so git never inspects the mounted checkout's .git.
(cd / && git config --global --add safe.directory '*' \
  && git config --global user.name CI \
  && git config --global user.email ci@example.invalid)

export VCPKG_ROOT="$cache/vcpkg"
export VCPKG_FORCE_SYSTEM_BINARIES=1
export VCPKG_DEFAULT_BINARY_CACHE="$cache/archives"
mkdir -p "$VCPKG_DEFAULT_BINARY_CACHE"

# vcpkg is pinned to the manifest's builtin-baseline, as in every other build.
baseline=$(sed -n 's/.*"builtin-baseline": *"\([0-9a-f]\{40\}\)".*/\1/p' "$src/vcpkg.json")
if [ "$(git -C "$VCPKG_ROOT" rev-parse HEAD 2>/dev/null || true)" != "$baseline" ] \
  || [ ! -x "$VCPKG_ROOT/vcpkg" ]; then
  rm -rf "$VCPKG_ROOT"
  git init -q "$VCPKG_ROOT"
  git -C "$VCPKG_ROOT" remote add origin https://github.com/microsoft/vcpkg.git
  git -C "$VCPKG_ROOT" fetch -q --depth 1 origin "$baseline"
  git -C "$VCPKG_ROOT" checkout -q FETCH_HEAD
  "$VCPKG_ROOT/bootstrap-vcpkg.sh" -disableMetrics
fi

cd "$src"
# Build trees are deleted once each port is installed, so the cache stays small.
"$VCPKG_ROOT/vcpkg" install --triplet "$triplet" --x-install-root="$cache/vcpkg_installed" --clean-after-build

cmake --preset release -B "$build" \
  -DVCPKG_TARGET_TRIPLET="$triplet" \
  -DVCPKG_INSTALLED_DIR="$cache/vcpkg_installed" \
  -DGG_FULLY_STATIC=ON
cmake --build "$build"

engine=$build/engine/gitglasses-engine
if readelf -lW "$engine" | grep -q 'INTERP' || readelf -dW "$engine" | grep -q 'NEEDED'; then
  echo "build-alpine-engine: $engine is dynamically linked" >&2
  exit 1
fi
echo "gitglasses-engine $("$engine" --version) (alpine-$arch, static)"

if [ "${GG_SKIP_TESTS:-0}" != 1 ]; then
  ctest --test-dir "$build" --output-on-failure
fi
