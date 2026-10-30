#!/usr/bin/env bash
# The engine's print-time estimate against tools/klipper_time.py, the Klipper
# lookahead port that matches real prints, on golden samples sliced for Klipper.
# Fails when the two part by more than 1 %.
#   tools/estimate_check.sh [lime-slice binary]
# The CLI's printer is the default profile: max_accel 10000, square corner
# velocity 5, cruise ratio 0.5, no velocity cap and no Z limit, so klipper_time.py
# runs with the same numbers.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
bin="${1:-$root/target/release/lime-slice}"
py="$(command -v python3 || command -v python)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
status=0
for row in "calibration_cube_20mm.stl|--blend speed" "lime_hull.stl|--blend speed" "overhang_ledge.stl|--blend toughness --supports"; do
  mesh="${row%%|*}"
  flags="${row#*|}"
  out="$tmp/out.gcode"
  # shellcheck disable=SC2086
  "$bin" slice "$root/samples/$mesh" $flags --firmware klipper -o "$out" > /dev/null
  engine="$(sed -n 's/^; TIME:\([0-9.]*\)s.*/\1/p' "$out" | tail -n 1)"
  model="$("$py" "$root/tools/klipper_time.py" --max-velocity 1000000 --max-accel 10000 \
    --square-corner-velocity 5 --minimum-cruise-ratio 0.5 --no-z-limit "$out" \
    | sed -n 's/^toolhead time \([0-9.]*\) s.*/\1/p')"
  verdict="$(awk -v e="$engine" -v m="$model" 'BEGIN { d = (e - m) / m * 100; printf "%+.2f%% %s", d, (d < -1 || d > 1) ? "FAIL" : "ok" }')"
  printf '%s\t%s\tengine %s s\tklipper_time.py %s s\t%s\n' "$mesh" "$flags" "$engine" "$model" "$verdict"
  [[ "$verdict" == *FAIL ]] && status=1
done
exit "$status"
