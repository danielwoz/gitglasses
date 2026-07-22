#!/usr/bin/env bash
# Generates deterministic fixture repositories for engine/extension tests.
# Usage: make-fixtures.sh <output-dir> [spec...]   (default: all specs)
# Deterministic: fixed identities and timestamps => stable SHAs across runs.

set -euo pipefail

OUT="${1:?usage: make-fixtures.sh <output-dir> [spec...]}"
shift || true
SPECS=("$@")
[ ${#SPECS[@]} -eq 0 ] && SPECS=(basic renames merges stashes large)

export GIT_AUTHOR_NAME="Fixture Author"
export GIT_AUTHOR_EMAIL="author@example.invalid"
export GIT_COMMITTER_NAME="Fixture Committer"
export GIT_COMMITTER_EMAIL="committer@example.invalid"

TICK=1700000000
tick() { TICK=$((TICK + 60)); export GIT_AUTHOR_DATE="@$TICK +0000" GIT_COMMITTER_DATE="@$TICK +0000"; }

init_repo() {
  local dir="$1"
  rm -rf "$dir" && mkdir -p "$dir" && cd "$dir"
  git init -q -b main
  git config commit.gpgsign false
}

commit() { tick; git commit -q --allow-empty -m "$1"; }

spec_basic() {
  init_repo "$OUT/basic"
  printf 'alpha\nbeta\ngamma\n' > file.txt
  git add file.txt && commit "add file"
  printf 'alpha\nbeta CHANGED\ngamma\n' > file.txt
  git add file.txt && commit "change beta"
  mkdir -p src && printf 'fn main\n' > src/app.c
  git add src/app.c && commit "add app"
}

spec_renames() {
  init_repo "$OUT/renames"
  printf 'one\ntwo\nthree\nfour\nfive\n' > original.txt
  git add original.txt && commit "create original"
  git mv original.txt renamed-once.txt && commit "first rename"
  printf 'one\ntwo\ntwo-and-a-half\nthree\nfour\nfive\n' > renamed-once.txt
  git add renamed-once.txt && commit "edit after rename"
  mkdir -p nested && git mv renamed-once.txt nested/renamed-twice.txt && commit "second rename into dir"
}

spec_merges() {
  init_repo "$OUT/merges"
  printf 'base\n' > shared.txt
  git add shared.txt && commit "base"
  git checkout -q -b feature
  printf 'base\nfeature line\n' > shared.txt
  git add shared.txt && commit "feature work"
  git checkout -q main
  printf 'main line\nbase\n' > shared.txt
  git add shared.txt && commit "main work"
  tick; git merge -q --no-edit feature
  git checkout -q -b conflict-branch HEAD~1 2>/dev/null || true
  git checkout -q main
}

spec_stashes() {
  init_repo "$OUT/stashes"
  printf 'stable\n' > work.txt
  git add work.txt && commit "initial"
  printf 'stable\nwip one\n' > work.txt
  tick; git stash push -q -m "first stash"
  printf 'stable\nwip two\n' > work.txt
  tick; git stash push -q -m "second stash"
}

# ~2k commits across 20 files: large enough to exercise paging, small enough
# to build in seconds. Sha-stable via fixed dates.
spec_large() {
  init_repo "$OUT/large"
  for i in $(seq 0 19); do printf 'seed %d\n' "$i" > "f$i.txt"; done
  git add . && commit "seed"
  for c in $(seq 1 2000); do
    f="f$((c % 20)).txt"
    printf 'change %d\n' "$c" >> "$f"
    git add "$f"
    commit "commit $c to $f"
  done
}

for spec in "${SPECS[@]}"; do
  "spec_$spec"
  cd - >/dev/null
done
echo "fixtures written to $OUT: ${SPECS[*]}"
