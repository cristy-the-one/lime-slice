"""Where a G-code file spends its time, by feature, with one move model for every slicer.

usage: python tools/gcode_profile.py [options] a.gcode [b.gcode ...]

Each slicer's own estimate uses its own model, so two files are only comparable
when one model times both. This one replays the moves: a trapezoid per move at
the acceleration in force (`M204 S`, or Klipper's `SET_VELOCITY_LIMIT ACCEL=`),
entering and leaving at a junction speed from the angle to the neighbouring
moves (Klipper's junction deviation). It ignores layer-time slowdowns,
firmware smoothing, and dwell. Arcs (G2/G3 with I/J) are timed by their length.

The feature is the last `;TYPE:` (Orca, Prusa, Cura) or `; TYPE:` (Lime Slice)
comment. A move with E > 0 counts to that feature, E == 0 is travel, E < 0 is a
retract or wipe. Relative (M83) and absolute (M82) E both work.

Options:
  --max-speed X=500,Y=500,Z=12   per-axis speed caps, mm/s (default: none)
  --max-accel 20000              acceleration cap, mm/s² (default: none)
  --junction-deviation 0.02      mm (default 0.02)
  --filament-diameter 1.75       mm (default 1.75)
  --travel-by-feature            split travel by the feature it occurs in
"""

import argparse
import collections
import math
import re

WORD = re.compile(r"([A-Z])(-?\d*\.?\d+)")


def parse_caps(text):
    caps = {}
    for part in (text or "").split(","):
        if part.strip():
            axis, value = part.split("=")
            caps[axis.strip().upper()] = float(value)
    return caps


def junction_speed(d0, d1, v, a, jd):
    if d0 is None or d1 is None:
        return 0.0
    cos = -(d0[0] * d1[0] + d0[1] * d1[1] + d0[2] * d1[2])
    cos = max(-0.999999, min(0.999999, cos))
    sin_half = math.sqrt((1 - cos) / 2)
    if sin_half > 0.999:
        return v
    r = jd * sin_half / (1 - sin_half)
    return min(v, math.sqrt(a * r))


def trapezoid(length, v, a, v0, v1):
    v0, v1 = min(v0, v), min(v1, v)
    d_acc = (v * v - v0 * v0) / (2 * a)
    d_dec = (v * v - v1 * v1) / (2 * a)
    if d_acc + d_dec <= length:
        return (v - v0) / a + (v - v1) / a + (length - d_acc - d_dec) / v
    peak = math.sqrt(max(0.0, (2 * a * length + v0 * v0 + v1 * v1) / 2))
    return max(0.0, (peak - v0) / a) + max(0.0, (peak - v1) / a)


def profile(path, caps, max_accel, jd, fil_d, travel_by_feature):
    area = math.pi * fil_d * fil_d / 4
    # feature -> [length mm, feed-only s, modelled s, moves, filament mm]
    stats = collections.defaultdict(lambda: [0.0, 0.0, 0.0, 0, 0.0])
    pos = [0.0, 0.0, 0.0]
    e_rel, e_abs = False, 0.0
    feed, accel, kind = 1800.0, 1500.0, "Start"
    layers = retracts = 0
    pending = None  # the previous move, waiting for its exit speed
    with open(path, encoding="utf-8", errors="replace") as fh:
        for line in fh:
            if line.startswith(";"):
                if "TYPE:" in line[:8]:
                    kind = line.split("TYPE:", 1)[1].strip()
                elif line.startswith((";LAYER_CHANGE", ";LAYER:")):
                    layers += 1
                continue
            code = line.split(";", 1)[0].split()
            if not code:
                continue
            cmd = code[0].upper()
            if cmd == "M83":
                e_rel = True
            elif cmd == "M82":
                e_rel = False
            elif cmd == "M204":
                words = dict((k, float(v)) for k, v in WORD.findall(" ".join(code[1:]).upper()))
                accel = words.get("S", words.get("P", accel))
            elif cmd == "SET_VELOCITY_LIMIT":
                for tok in code[1:]:
                    if tok.upper().startswith("ACCEL="):
                        accel = float(tok.split("=", 1)[1])
            elif cmd == "G92":
                words = dict((k, float(v)) for k, v in WORD.findall(" ".join(code[1:]).upper()))
                for i, ax in enumerate("XYZ"):
                    if ax in words:
                        pos[i] = words[ax]
                if "E" in words:
                    e_abs = words["E"]
            elif cmd in ("G0", "G1", "G2", "G3"):
                words = dict((k, float(v)) for k, v in WORD.findall(" ".join(code[1:]).upper()))
                if "F" in words:
                    feed = words["F"]
                target = [words.get(ax, pos[i]) for i, ax in enumerate("XYZ")]
                if "E" not in words:
                    e = 0.0
                elif e_rel:
                    e = words["E"]
                else:
                    e, e_abs = words["E"] - e_abs, words["E"]
                delta = [target[i] - pos[i] for i in range(3)]
                chord = math.sqrt(sum(c * c for c in delta))
                length = chord
                if cmd in ("G2", "G3") and ("I" in words or "J" in words):
                    cx, cy = pos[0] + words.get("I", 0.0), pos[1] + words.get("J", 0.0)
                    a0 = math.atan2(pos[1] - cy, pos[0] - cx)
                    a1 = math.atan2(target[1] - cy, target[0] - cx)
                    sweep = (a0 - a1) if cmd == "G2" else (a1 - a0)
                    sweep %= 2 * math.pi
                    if sweep < 1e-9:
                        sweep = 2 * math.pi
                    r = math.hypot(pos[0] - cx, pos[1] - cy)
                    length = math.hypot(r * sweep, delta[2])
                if length < 1e-9:
                    if e < 0:
                        retracts += 1
                    pos = target
                    continue
                d = [c / chord for c in delta] if chord > 1e-9 else [0.0, 0.0, 1.0]
                v = feed / 60
                for i, ax in enumerate("XYZ"):
                    if ax in caps and abs(d[i]) > 1e-9:
                        v = min(v, caps[ax] / abs(d[i]))
                a = min(accel, max_accel) if max_accel else accel
                if e > 0:
                    k = kind
                elif e == 0:
                    k = f"Travel in {kind}" if travel_by_feature else "Travel"
                else:
                    k = "Wipe"
                v_in = 0.0
                if pending:
                    pk, plen, pv, pa, pd, pin = pending
                    v_in = junction_speed(pd, d, pv, pa, jd)
                    stats[pk][2] += trapezoid(plen, pv, pa, pin, v_in)
                st = stats[k]
                st[0] += length
                st[1] += length / v
                st[3] += 1
                st[4] += max(0.0, e)
                pending = (k, length, v, a, d, v_in)
                pos = target
    if pending:
        pk, plen, pv, pa, pd, pin = pending
        stats[pk][2] += trapezoid(plen, pv, pa, pin, 0.0)
    return stats, layers, retracts, area


def report(path, stats, layers, retracts, area):
    total = sum(s[2] for s in stats.values())
    filament = sum(s[4] for s in stats.values())
    print(f"== {path}")
    print(f"layers {layers}, retractions {retracts}, filament {filament / 1000:.1f} m = {filament * area / 1000:.1f} cm3")
    print(f"modelled time {total / 3600:.2f} h (at the commanded feeds alone {sum(s[1] for s in stats.values()) / 3600:.2f} h)")
    print(f"{'feature':30} {'time h':>7} {'share':>6} {'length m':>9} {'moves':>9} {'cm3':>7} {'mm3/s':>7}")
    for k, s in sorted(stats.items(), key=lambda kv: -kv[1][2]):
        rate = s[4] * area / s[2] if s[2] and s[4] else 0.0
        print(f"{k[:30]:30} {s[2] / 3600:7.2f} {100 * s[2] / total:5.1f}% {s[0] / 1000:9.1f} {s[3]:9d} {s[4] * area / 1000:7.1f} {rate:7.2f}")


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    ap.add_argument("files", nargs="+")
    ap.add_argument("--max-speed", default="")
    ap.add_argument("--max-accel", type=float, default=0.0)
    ap.add_argument("--junction-deviation", type=float, default=0.02)
    ap.add_argument("--filament-diameter", type=float, default=1.75)
    ap.add_argument("--travel-by-feature", action="store_true")
    args = ap.parse_args()
    caps = parse_caps(args.max_speed)
    for path in args.files:
        report(path, *profile(path, caps, args.max_accel, args.junction_deviation, args.filament_diameter, args.travel_by_feature))


if __name__ == "__main__":
    main()
