#!/usr/bin/env bash
# Slice every sample under a fixed set of configs and print one line per run:
# config, sample, sha256 of the G-code, and the estimate summary.
# Diff two runs to prove a refactor left the output byte-identical.
#   tools/golden.sh [lime-slice binary] > out.tsv
set -euo pipefail
bin="${1:-target/release/lime-slice}"
root="$(cd "$(dirname "$0")/.." && pwd)"
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
  for mesh in "$root"/samples/*.stl "$root"/samples/*.3mf; do
    out="$tmp/out.gcode"
    # shellcheck disable=SC2086
    summary="$("$bin" slice "$mesh" $flags -o "$out" 2>&1 | sed -n 2p || true)"
    hash="$(sha256sum "$out" 2>/dev/null | cut -c1-16 || echo missing)"
    printf '%s\t%s\t%s\t%s\n' "$name" "$(basename "$mesh")" "$hash" "$summary"
  done
done
