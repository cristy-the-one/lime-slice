#!/usr/bin/env bash
# Golden A/B against a stored baseline:
#   tools/golden_ab.sh <base-rev> <new-binary> [new-rev]
# Prints every row whose G-code hash differs, then a same/diff count.
#
# Each golden run is stored under $GOLDEN_CACHE (default ~/.lime-slice/golden),
# keyed by the commit, tools/golden.sh, and the bytes of every mesh it slices.
# The base revision is sliced only when no stored run matches; it is then built
# in a temporary worktree. Pass new-rev to store the new run too, but only when
# new-binary was built from that commit with no local changes.
# GOLDEN_EXTRA works as in tools/golden.sh.
#   tools/golden_ab.sh --store <rev> <golden.tsv>
# stores a finished tools/golden.sh run of that commit.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
store="${GOLDEN_CACHE:-$HOME/.lime-slice/golden}"
mkdir -p "$store"

key() {
  local rev="$1"
  IFS=: read -r -a extra <<< "${GOLDEN_EXTRA:-}"
  {
    git -C "$root" rev-parse "$rev^{commit}"
    git -C "$root" show "$rev:tools/golden.sh" 2>/dev/null | sha256sum
    for mesh in "$root"/samples/*.stl "$root"/samples/*.3mf "${extra[@]}"; do
      [[ "$(basename "$mesh")" == "dragon_2_5.stl" ]] && continue
      printf '%s %s\n' "$(basename "$mesh")" "$(sha256sum < "$mesh" | cut -c1-64)"
    done
  } | sha256sum | cut -c1-16
}

# A run with a "missing" hash failed to slice something, so it is never stored.
store_run() {
  local tsv="$1" rev="$2" out
  if grep -q $'\tmissing\t' "$tsv"; then
    echo "not stored: $rev has missing rows" >&2
    return
  fi
  out="$store/$(key "$rev").tsv"
  cp "$tsv" "$out"
  printf '%s\t%s\t%s\n' "$(git -C "$root" rev-parse --short "$rev")" "$(date -u +%FT%TZ)" "${GOLDEN_EXTRA:-}" > "${out%.tsv}.meta"
}

if [[ "${1:-}" == "--store" ]]; then
  store_run "$3" "$2"
  exit 0
fi

base_rev="$1"
new_bin="$2"
new_rev="${3:-}"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

base_tsv="$store/$(key "$base_rev").tsv"
if [[ -f "$base_tsv" ]]; then
  echo "base $base_rev: stored run $base_tsv" >&2
else
  echo "base $base_rev: no stored run, building it" >&2
  wt="$tmp/base"
  git -C "$root" worktree add --detach "$wt" "$base_rev" >/dev/null
  # Sharing the target directory reuses the compiled dependencies.
  CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$root/target}" cargo build --release -p lime-slice --manifest-path "$wt/Cargo.toml" >&2
  cp "${CARGO_TARGET_DIR:-$root/target}/release/lime-slice$( [[ -f "${CARGO_TARGET_DIR:-$root/target}/release/lime-slice.exe" ]] && echo .exe)" "$tmp/base-bin"
  git -C "$root" worktree remove --force "$wt"
  bash "$root/tools/golden.sh" "$tmp/base-bin" > "$tmp/base.tsv"
  store_run "$tmp/base.tsv" "$base_rev"
  base_tsv="$tmp/base.tsv"
fi

bash "$root/tools/golden.sh" "$new_bin" > "$tmp/new.tsv"
if [[ -n "$new_rev" ]]; then
  store_run "$tmp/new.tsv" "$new_rev"
fi

awk -F'\t' '
  NR == FNR { hash[$1 FS $2] = $3; cost[$1 FS $2] = $4; next }
  {
    k = $1 FS $2
    if (!(k in hash)) { print "NEW\t" $1 "\t" $2 "\t" $4; diff++; next }
    if (hash[k] == $3) { same++; next }
    print "DIFF\t" $1 "\t" $2 "\n  base " cost[k] "\n  new  " $4
    diff++
  }
  END { printf "%d same, %d different\n", same, diff; exit diff > 0 }
' "$base_tsv" "$tmp/new.tsv"
