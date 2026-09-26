#!/usr/bin/env bash
# Slice every sample under a fixed set of configs and print one line per run:
# config, sample, sha256 of the G-code, and the estimate summary.
# Diff two runs to prove a refactor left the output byte-identical.
#   tools/golden.sh [lime-slice binary] > out.tsv
# GOLDEN_EXTRA adds meshes outside samples/, separated by colons.
# samples/dragon_2_5.stl is checked in and left out of the hash set.
#   GOLDEN_DRAGON=1 bash tools/golden.sh
# runs dragon_2_5_headlines (speed and toughness, supports on).
# A missing file prints one skip line and exits 0.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
if [[ "${GOLDEN_DRAGON:-}" == "1" ]]; then
  dragon="$root/samples/dragon_2_5.stl"
  if [[ ! -f "$dragon" ]]; then
    printf '%s\n' "skip dragon_2_5: samples/dragon_2_5.stl is missing"
    exit 0
  fi
  cd "$root"
  exec cargo test -p lime-slice-core --release -- dragon_2_5_headlines --ignored --nocapture
fi
bin="${1:-target/release/lime-slice}"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
configs=(
  "speed|--blend speed"
  "tough|--blend toughness"
  "region|--blend region"
  "grid|--blend speed --supports"
  "tree|--blend toughness --supports --support-style tree"
  "adaptive|--blend layer --adaptive"
)
for cfg in "${configs[@]}"; do
  name="${cfg%%|*}"
  flags="${cfg#*|}"
  IFS=: read -r -a extra <<< "${GOLDEN_EXTRA:-}"
  for mesh in "$root"/samples/*.stl "$root"/samples/*.3mf "${extra[@]}"; do
    # The Dragon audit is opt-in (GOLDEN_DRAGON=1). The checked-in mesh stays out of the hash set.
    if [[ "$(basename "$mesh")" == "dragon_2_5.stl" ]]; then
      continue
    fi
    out="$tmp/out.gcode"
    rm -f "$out"
    # shellcheck disable=SC2086
    summary="$("$bin" slice "$mesh" $flags -o "$out" 2>&1 | sed -n 2p || true)"
    hash="$(sha256sum "$out" 2>/dev/null | cut -c1-16 || echo missing)"
    printf '%s\t%s\t%s\t%s\n' "$name" "$(basename "$mesh")" "$hash" "$summary"
  done
done
