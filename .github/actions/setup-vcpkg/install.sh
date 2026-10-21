#!/usr/bin/env bash
# Installs the engine's dependencies for one triplet into INSTALL_ROOT.
#
#   VCPKG_ROOT                  the bootstrapped vcpkg checkout
#   TRIPLET                     the triplet to install for
#   INSTALL_ROOT                the install directory (--x-install-root)
#   PACKAGES                    space-separated packages for a classic-mode
#                               install; empty installs vcpkg.json from the
#                               current directory
#   CACHE_HIT                   "true" when the cache restored the install
#                               directory saved for exactly this request
#   VCPKG_DEFAULT_BINARY_CACHE  the binary cache directory
#   GITHUB_WORKSPACE            the checkout, which holds ci/triplets
#   RUNNER_TEMP                 a directory outside the checkout
set -euo pipefail

# An install directory from an older cache entry holds the packages of an
# older baseline or package list. A classic-mode install leaves installed
# packages alone, so it would keep an outdated libgit2 for good. Start from an
# empty directory instead; the binary cache still supplies every package
# whose build did not change.
if [ "${CACHE_HIT:-}" != true ]; then
  rm -rf "$INSTALL_ROOT"
fi

mkdir -p "$VCPKG_DEFAULT_BINARY_CACHE"
args=(install --triplet "$TRIPLET" --overlay-triplets="$GITHUB_WORKSPACE/ci/triplets"
      --x-install-root="$INSTALL_ROOT")
if [ -n "${PACKAGES:-}" ]; then
  # Classic mode: from inside the checkout vcpkg would find vcpkg.json and
  # reject package arguments.
  cd "$RUNNER_TEMP"
  read -ra packages <<< "$PACKAGES"
  args+=("${packages[@]}")
fi
"$VCPKG_ROOT/vcpkg" "${args[@]}"
