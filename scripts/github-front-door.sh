#!/usr/bin/env bash
# Sets the GitHub repository's front door: description, website, topics,
# Discussions (the listing's Q&A link points there), private vulnerability
# reporting, no empty wiki, and release notes taken from the changelog for
# releases published before notes came from it.
#
# Prints every gh command it would run and changes nothing, unless run with
# --apply by someone with admin rights on the repository:
#   scripts/github-front-door.sh            # review
#   scripts/github-front-door.sh --apply    # apply
# REPO overrides the repository (default danielwoz/gitglasses).
# See docs/github-front-door.md for what this sets and why.

set -euo pipefail

REPO="${REPO:-danielwoz/gitglasses}"
APPLY=0
if [[ "${1:-}" == "--apply" ]]; then
  APPLY=1
elif [[ $# -gt 0 ]]; then
  echo "usage: $0 [--apply]" >&2
  exit 2
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

DESCRIPTION="Free, open-source git toolkit for VS Code and Open VSX: inline blame, Commit Graph, history, commit search, rebase and worktrees. No account, no telemetry, and an MCP server for agents."
HOMEPAGE="https://marketplace.visualstudio.com/items?itemName=gitglasses.gitglasses"
TOPICS=(
  vscode-extension
  open-vsx
  vscodium
  git
  git-blame
  git-history
  commit-graph
  interactive-rebase
  libgit2
  mcp
  model-context-protocol
  developer-tools
)

run() {
  printf '+'
  printf ' %q' "$@"
  printf '\n'
  if [[ $APPLY -eq 1 ]]; then "$@"; fi
}

run gh repo edit "$REPO" --description "$DESCRIPTION" --homepage "$HOMEPAGE"

topic_args=()
for topic in "${TOPICS[@]}"; do topic_args+=(--add-topic "$topic"); done
run gh repo edit "$REPO" "${topic_args[@]}"

run gh repo edit "$REPO" --enable-discussions --enable-wiki=false

run gh api --method PUT "repos/$REPO/private-vulnerability-reporting"

# Release notes from the changelog, for every changelog version that has a
# GitHub release. Later releases get them from the release workflow.
notes_dir="$(mktemp -d)"
trap 'rm -rf "$notes_dir"' EXIT
versions="$(sed -n 's/^## \[\{0,1\}v\{0,1\}\([0-9][0-9.]*\)\]\{0,1\}.*/\1/p' "$ROOT/extension/CHANGELOG.md")"
for version in $versions; do
  notes="$notes_dir/$version.md"
  if ! node "$ROOT/scripts/release-notes.mjs" "$version" >"$notes" 2>/dev/null; then
    continue
  fi
  if [[ $APPLY -eq 1 ]] && ! gh release view "v$version" --repo "$REPO" >/dev/null 2>&1; then
    echo "skip v$version: no GitHub release"
    continue
  fi
  run gh release edit "v$version" --repo "$REPO" --notes-file "$notes"
done

if [[ $APPLY -eq 0 ]]; then
  echo
  echo "Nothing was changed. Re-run with --apply to make these changes to $REPO."
fi
