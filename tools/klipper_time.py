"""What a Klipper printer takes to run a G-code file: a port of its toolhead lookahead.

usage: python tools/klipper_time.py [options] file.gcode [more.gcode]

Ported from klippy/toolhead.py (Move, LookAheadQueue.flush, minimum_cruise_ratio) and
klippy/kinematics/extruder.py (check_move, calc_junction) as of Klipper 0.12, and
klippy/kinematics/corexy.py for the Z limits. The defaults are the Ideaformer IR3 V2
read from the printer's own `printer.cfg` (Moonraker `/printer/objects/query?configfile=settings`).

What it models, because each one changes the time:
  * Junction speed from `square_corner_velocity`: junction_deviation = scv^2 (sqrt 2 - 1) / accel,
    recomputed at every M204 and SET_VELOCITY_LIMIT. At accel 3500 and scv 5 that is 0.003 mm.
  * `minimum_cruise_ratio`: a move may not peak above sqrt(d * accel * (1 - ratio)) when its
    neighbours leave it nothing else to do, so short moves stay slow.
  * The extruder's `instantaneous_corner_velocity`: a junction where E per mm changes (an extrusion
    meeting a travel) is capped at corner_v / |change|.
  * An extrude-only move (retract, prime) stops the toolhead before and after, at the extruder's
    max_extrude_only velocity and accel.
  * Z limits (the belt on a belt printer): max_z_velocity and max_z_accel scale with the move.
  * Commands that flush the lookahead queue, so the toolhead decelerates to rest: SET_PRESSURE_ADVANCE
    (it re-times step generation), G4, M400, G28, and a heating wait (M109/M190).
  * M204 S/P/T, SET_VELOCITY_LIMIT VELOCITY/ACCEL/SQUARE_CORNER_VELOCITY/MINIMUM_CRUISE_RATIO/
    ACCEL_TO_DECEL, G2/G3 (split into 1 mm chords, as `gcode_arcs` does), G90/G91, M82/M83, G92.

What it leaves out: input shaping (it changes no move time), heat-up and homing waits (pass
--overhead-s), fan and temperature commands, and host-side stalls when the G-code feeds too slowly.

Checkpoints: --at-layer N prints the elapsed time when layer N (the `;LAYER:N` comment) starts;
--at-fraction 0.76 prints it where that fraction of the file's bytes has been read, which is
what Klipper's progress and Fluidd's percentage show.

Switches to take one effect out and see what it was worth:
  --jd 0.02            a fixed junction deviation, mm, as the app's old estimator used
  --no-mcr             minimum_cruise_ratio 0
  --no-extruder-corner no extruder junction limit
  --no-pa-flush        SET_PRESSURE_ADVANCE does not stop the toolhead
  --no-z-limit         no max_z_velocity / max_z_accel
  --no-lazy            one full flush at the end instead of Klipper's 0.25 s lazy flushes
"""

import argparse
import collections
import math
import re
import sys

LOOKAHEAD_FLUSH_TIME = 0.250
BIG_ACCEL = 99999999.9
SQRT2_MINUS_1 = math.sqrt(2.0) - 1.0


class Toolhead:
    """The limits in force: what M204 and SET_VELOCITY_LIMIT change."""

    def __init__(self, args):
        self.max_velocity = args.max_velocity
        self.max_accel = args.max_accel
        self.scv = args.square_corner_velocity
        self.min_cruise_ratio = 0.0 if args.no_mcr else args.minimum_cruise_ratio
        self.fixed_jd = args.jd
        self.max_z_velocity = None if args.no_z_limit else args.max_z_velocity
        self.max_z_accel = None if args.no_z_limit else args.max_z_accel
        self.instant_corner_v = None if args.no_extruder_corner else args.extruder_corner_velocity
        area = math.pi * args.filament_diameter ** 2 / 4.0
        cross = args.max_extrude_cross_section
        if cross is None:
            cross = 4.0 * args.nozzle_diameter ** 2
        self.max_e_velocity = args.max_extrude_only_velocity or args.max_velocity * cross / area
        self.max_e_accel = args.max_extrude_only_accel or args.max_accel * cross / area
        self.calc_junction_deviation()

    def calc_junction_deviation(self):
        scv2 = self.scv ** 2
        if self.fixed_jd is not None:
            self.junction_deviation = self.fixed_jd
        else:
            self.junction_deviation = scv2 * SQRT2_MINUS_1 / self.max_accel
        self.max_accel_to_decel = self.max_accel * (1.0 - self.min_cruise_ratio)


class Move:
    __slots__ = (
        "start_pos", "end_pos", "accel", "junction_deviation", "is_kinematic_move", "axes_d", "axes_r",
        "move_d", "min_move_t", "max_start_v2", "max_cruise_v2", "delta_v2", "max_smoothed_v2",
        "smooth_delta_v2", "start_v", "cruise_v", "end_v", "accel_t", "cruise_t", "decel_t",
        "offset", "layer", "kind",
    )

    def __init__(self, th, start_pos, end_pos, speed):
        self.accel = th.max_accel
        self.junction_deviation = th.junction_deviation
        velocity = min(speed, th.max_velocity)
        self.is_kinematic_move = True
        self.axes_d = axes_d = [e - s for s, e in zip(start_pos, end_pos)]
        self.move_d = move_d = math.sqrt(axes_d[0] * axes_d[0] + axes_d[1] * axes_d[1] + axes_d[2] * axes_d[2])
        if move_d < 0.000000001:
            self.end_pos = (start_pos[0], start_pos[1], start_pos[2], end_pos[3])
            axes_d[0] = axes_d[1] = axes_d[2] = 0.0
            self.move_d = move_d = abs(axes_d[3])
            inv_move_d = 1.0 / move_d if move_d else 0.0
            self.accel = BIG_ACCEL
            velocity = speed
            self.is_kinematic_move = False
        else:
            self.end_pos = end_pos
            inv_move_d = 1.0 / move_d
        self.axes_r = [d * inv_move_d for d in axes_d]
        self.min_move_t = move_d / velocity
        self.max_start_v2 = 0.0
        self.max_cruise_v2 = velocity ** 2
        self.delta_v2 = 2.0 * move_d * self.accel
        self.max_smoothed_v2 = 0.0
        self.smooth_delta_v2 = 2.0 * move_d * th.max_accel_to_decel

    def limit_speed(self, speed, accel):
        speed2 = speed ** 2
        if speed2 < self.max_cruise_v2:
            self.max_cruise_v2 = speed2
            self.min_move_t = self.move_d / speed
        self.accel = min(self.accel, accel)
        self.delta_v2 = 2.0 * self.move_d * self.accel
        self.smooth_delta_v2 = min(self.smooth_delta_v2, self.delta_v2)

    def calc_junction(self, prev_move, th):
        if not self.is_kinematic_move or not prev_move.is_kinematic_move:
            return
        # extruder.calc_junction
        extruder_v2 = self.max_cruise_v2
        if th.instant_corner_v is not None:
            diff_r = self.axes_r[3] - prev_move.axes_r[3]
            if diff_r:
                extruder_v2 = (th.instant_corner_v / abs(diff_r)) ** 2
        axes_r = self.axes_r
        prev_axes_r = prev_move.axes_r
        junction_cos_theta = -(axes_r[0] * prev_axes_r[0] + axes_r[1] * prev_axes_r[1] + axes_r[2] * prev_axes_r[2])
        if junction_cos_theta > 0.999999:
            return
        junction_cos_theta = max(junction_cos_theta, -0.999999)
        sin_theta_d2 = math.sqrt(max(0.5 * (1.0 - junction_cos_theta), 0.0))
        cos_theta_d2 = math.sqrt(max(0.5 * (1.0 + junction_cos_theta), 0.0))
        one_minus_sin_theta_d2 = 1.0 - sin_theta_d2
        if one_minus_sin_theta_d2 > 0.0 and cos_theta_d2 > 0.0:
            r_jd = sin_theta_d2 / one_minus_sin_theta_d2
            tan_theta_d2 = sin_theta_d2 / cos_theta_d2
            move_centripetal_v2 = 0.5 * self.move_d * tan_theta_d2 * self.accel
            prev_move_centripetal_v2 = 0.5 * prev_move.move_d * tan_theta_d2 * prev_move.accel
            self.max_start_v2 = min(
                r_jd * self.junction_deviation * self.accel,
                r_jd * prev_move.junction_deviation * prev_move.accel,
                move_centripetal_v2, prev_move_centripetal_v2,
                extruder_v2, self.max_cruise_v2, prev_move.max_cruise_v2,
                prev_move.max_start_v2 + prev_move.delta_v2)
            self.max_smoothed_v2 = min(
                self.max_start_v2, prev_move.max_smoothed_v2 + prev_move.smooth_delta_v2)

    def set_junction(self, start_v2, cruise_v2, end_v2):
        half_inv_accel = 0.5 / self.accel
        accel_d = (cruise_v2 - start_v2) * half_inv_accel
        decel_d = (cruise_v2 - end_v2) * half_inv_accel
        cruise_d = self.move_d - accel_d - decel_d
        self.start_v = start_v = math.sqrt(start_v2)
        self.cruise_v = cruise_v = math.sqrt(cruise_v2)
        self.end_v = end_v = math.sqrt(end_v2)
        self.accel_t = accel_d / ((start_v + cruise_v) * 0.5)
        self.cruise_t = cruise_d / cruise_v
        self.decel_t = decel_d / ((end_v + cruise_v) * 0.5)


class Timeline:
    """Moves leave the queue here in print order: the elapsed time and what it was spent on."""

    def __init__(self, at_layers, at_offsets):
        self.t = 0.0
        self.moves = 0
        self.by_kind = collections.defaultdict(float)
        self.layer_start = {}
        self.layer_wanted = set(at_layers)
        self.offsets = sorted(at_offsets)
        self.offset_t = {}
        self.next_offset = 0
        self.last_layer = None

    def process(self, moves):
        for m in moves:
            if m.layer != self.last_layer:
                self.last_layer = m.layer
                if m.layer in self.layer_wanted and m.layer not in self.layer_start:
                    self.layer_start[m.layer] = self.t
            while self.next_offset < len(self.offsets) and m.offset >= self.offsets[self.next_offset]:
                self.offset_t[self.offsets[self.next_offset]] = self.t
                self.next_offset += 1
            dt = m.accel_t + m.cruise_t + m.decel_t
            self.t += dt
            self.moves += 1
            self.by_kind[m.kind] += dt


class LookAheadQueue:
    def __init__(self, timeline, lazy):
        self.queue = []
        self.timeline = timeline
        self.lazy = lazy
        self.junction_flush = LOOKAHEAD_FLUSH_TIME

    def add_move(self, move, th):
        if self.queue:
            move.calc_junction(self.queue[-1], th)
        self.queue.append(move)
        if self.lazy:
            self.junction_flush -= move.min_move_t
            if self.junction_flush <= 0.0:
                self.flush(lazy=True)

    def flush(self, lazy=False):
        self.junction_flush = LOOKAHEAD_FLUSH_TIME
        update_flush_count = lazy
        queue = self.queue
        flush_count = len(queue)
        delayed = []
        next_end_v2 = next_smoothed_v2 = peak_cruise_v2 = 0.0
        for i in range(flush_count - 1, -1, -1):
            move = queue[i]
            reachable_start_v2 = next_end_v2 + move.delta_v2
            start_v2 = min(move.max_start_v2, reachable_start_v2)
            reachable_smoothed_v2 = next_smoothed_v2 + move.smooth_delta_v2
            smoothed_v2 = min(move.max_smoothed_v2, reachable_smoothed_v2)
            if smoothed_v2 < reachable_smoothed_v2:
                if smoothed_v2 + move.smooth_delta_v2 > next_smoothed_v2 or delayed:
                    if update_flush_count and peak_cruise_v2:
                        flush_count = i
                        update_flush_count = False
                    peak_cruise_v2 = min(move.max_cruise_v2, (smoothed_v2 + reachable_smoothed_v2) * 0.5)
                    if delayed:
                        if not update_flush_count and i < flush_count:
                            mc_v2 = peak_cruise_v2
                            for m, ms_v2, me_v2 in reversed(delayed):
                                mc_v2 = min(mc_v2, ms_v2)
                                m.set_junction(min(ms_v2, mc_v2), mc_v2, min(me_v2, mc_v2))
                        del delayed[:]
                if not update_flush_count and i < flush_count:
                    cruise_v2 = min((start_v2 + reachable_start_v2) * 0.5, move.max_cruise_v2, peak_cruise_v2)
                    move.set_junction(min(start_v2, cruise_v2), cruise_v2, min(next_end_v2, cruise_v2))
            else:
                delayed.append((move, start_v2, next_end_v2))
            next_end_v2 = start_v2
            next_smoothed_v2 = smoothed_v2
        if update_flush_count or not flush_count:
            return
        self.timeline.process(queue[:flush_count])
        del queue[:flush_count]


WORDS = re.compile(rb"([A-Za-z])\s*(-?\d*\.?\d+)")


def parse_words(tokens):
    out = {}
    for tok in tokens:
        if len(tok) > 1:
            try:
                out[chr(tok[0]).upper()] = float(tok[1:])
            except ValueError:
                pass
    return out


def kv(tokens):
    out = {}
    for tok in tokens:
        if b"=" in tok:
            k, v = tok.split(b"=", 1)
            out[k.decode().upper()] = v.decode()
    return out


def run(path, args):
    th = Toolhead(args)
    at_offsets = []
    size = 0
    if args.at_fraction:
        import os
        size = os.path.getsize(path)
        at_offsets = [int(f * size) for f in args.at_fraction]
    timeline = Timeline(args.at_layer, at_offsets)
    look = LookAheadQueue(timeline, not args.no_lazy)
    pos = [0.0, 0.0, 0.0, 0.0]
    absolute_xyz, absolute_e = True, True
    speed = 25.0
    layer = -1
    kind = "Start"
    offset = 0
    flushes = collections.Counter()
    stats = collections.Counter()
    clamp = {}

    def flush(reason):
        look.flush()
        flushes[reason] += 1

    def add(end_pos):
        nonlocal pos
        move = Move(th, pos, end_pos, speed)
        move.offset, move.layer, move.kind = offset, layer, kind
        if move.move_d:
            # corexy.check_move
            if move.axes_d[2] and th.max_z_velocity is not None:
                z_ratio = move.move_d / abs(move.axes_d[2])
                move.limit_speed(th.max_z_velocity * z_ratio, th.max_z_accel * z_ratio)
            # extruder.check_move
            if move.axes_d[3]:
                axis_r = move.axes_r[3]
                if (not move.axes_d[0] and not move.axes_d[1]) or axis_r < 0.0:
                    inv_extrude_r = 1.0 / abs(axis_r)
                    move.limit_speed(th.max_e_velocity * inv_extrude_r, th.max_e_accel * inv_extrude_r)
            pos = list(move.end_pos)
            look.add_move(move, th)
            stats["moves"] += 1
            if not move.is_kinematic_move:
                stats["extruder-only moves"] += 1

    with open(path, "rb") as fh:
        for raw in fh:
            line_offset = offset
            offset += len(raw)
            if raw[:1] == b";":
                if raw.startswith(b";LAYER:"):
                    try:
                        layer = int(raw[7:].split()[0])
                    except (ValueError, IndexError):
                        pass
                elif raw.startswith(b"; TYPE:"):
                    kind = raw[7:].strip().decode(errors="replace")
                elif raw.startswith(b";TYPE:"):
                    kind = raw[6:].strip().decode(errors="replace")
                continue
            code = raw.split(b";", 1)[0].split()
            if not code:
                continue
            cmd = code[0].upper()
            cur_offset = offset
            if cmd in (b"G1", b"G0"):
                w = parse_words(code[1:])
                if "F" in w:
                    speed = w["F"] / 60.0
                end = list(pos)
                for i, ax in enumerate("XYZ"):
                    if ax in w:
                        end[i] = w[ax] if absolute_xyz else pos[i] + w[ax]
                if "E" in w:
                    end[3] = w["E"] if absolute_e else pos[3] + w["E"]
                offset_save, offset = offset, line_offset
                add(end)
                offset = offset_save
            elif cmd in (b"G2", b"G3"):
                w = parse_words(code[1:])
                if "F" in w:
                    speed = w["F"] / 60.0
                end = list(pos)
                for i, ax in enumerate("XYZ"):
                    if ax in w:
                        end[i] = w[ax] if absolute_xyz else pos[i] + w[ax]
                if "E" in w:
                    end[3] = w["E"] if absolute_e else pos[3] + w["E"]
                cx, cy = pos[0] + w.get("I", 0.0), pos[1] + w.get("J", 0.0)
                r = math.hypot(pos[0] - cx, pos[1] - cy)
                a0 = math.atan2(pos[1] - cy, pos[0] - cx)
                a1 = math.atan2(end[1] - cy, end[0] - cx)
                sweep = (a0 - a1) if cmd == b"G2" else (a1 - a0)
                sweep %= 2 * math.pi
                if sweep < 1e-9:
                    sweep = 2 * math.pi
                arc_len = math.hypot(r * sweep, end[2] - pos[2])
                segments = max(1, int(arc_len / 1.0))
                sign = -1.0 if cmd == b"G2" else 1.0
                start = list(pos)
                offset_save, offset = offset, line_offset
                for s in range(1, segments + 1):
                    f = s / segments
                    if s == segments:
                        point = list(end)
                    else:
                        ang = a0 + sign * sweep * f
                        point = [cx + r * math.cos(ang), cy + r * math.sin(ang),
                                 start[2] + (end[2] - start[2]) * f, start[3] + (end[3] - start[3]) * f]
                    add(point)
                offset = offset_save
                stats["arcs"] += 1
            elif cmd == b"G90":
                absolute_xyz = True
            elif cmd == b"G91":
                absolute_xyz = False
            elif cmd == b"M82":
                absolute_e = True
            elif cmd == b"M83":
                absolute_e = False
            elif cmd == b"G92":
                w = parse_words(code[1:])
                for i, ax in enumerate("XYZE"):
                    if ax in w:
                        pos[i] = w[ax]
            elif cmd == b"M204":
                w = parse_words(code[1:])
                if "S" in w:
                    accel = w["S"]
                elif "P" in w and "T" in w:
                    accel = min(w["P"], w["T"])
                else:
                    continue
                th.max_accel = accel
                th.calc_junction_deviation()
            elif cmd == b"SET_VELOCITY_LIMIT":
                p = kv(code[1:])
                if "VELOCITY" in p:
                    th.max_velocity = float(p["VELOCITY"])
                if "ACCEL" in p:
                    th.max_accel = float(p["ACCEL"])
                if "SQUARE_CORNER_VELOCITY" in p:
                    th.scv = float(p["SQUARE_CORNER_VELOCITY"])
                if "MINIMUM_CRUISE_RATIO" in p:
                    if not args.no_mcr:
                        th.min_cruise_ratio = float(p["MINIMUM_CRUISE_RATIO"])
                elif "ACCEL_TO_DECEL" in p and not args.no_mcr:
                    th.min_cruise_ratio = 1.0 - min(1.0, float(p["ACCEL_TO_DECEL"]) / th.max_accel)
                th.calc_junction_deviation()
            elif cmd == b"SET_PRESSURE_ADVANCE":
                if not args.no_pa_flush:
                    flush("SET_PRESSURE_ADVANCE")
            elif cmd in (b"G4", b"M400"):
                flush(cmd.decode())
            elif cmd == b"G28":
                flush("G28")
                for ax in code[1:]:
                    i = "XYZ".find(chr(ax[0]).upper())
                    if i >= 0:
                        pos[i] = 0.0
                if len(code) == 1:
                    pos[:3] = [0.0, 0.0, 0.0]
            elif cmd in (b"M109", b"M190"):
                flush(cmd.decode())
    flush("end")
    return timeline, th, flushes, stats


def hms(seconds):
    s = int(round(seconds))
    return f"{s // 3600} h {s % 3600 // 60:02d} m {s % 60:02d} s"


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    ap.add_argument("files", nargs="+")
    ap.add_argument("--max-velocity", type=float, default=400.0)
    ap.add_argument("--max-accel", type=float, default=20000.0)
    ap.add_argument("--square-corner-velocity", type=float, default=8.0)
    ap.add_argument("--minimum-cruise-ratio", type=float, default=0.5)
    ap.add_argument("--max-z-velocity", type=float, default=20.0)
    ap.add_argument("--max-z-accel", type=float, default=500.0)
    ap.add_argument("--extruder-corner-velocity", type=float, default=1.0)
    ap.add_argument("--max-extrude-only-velocity", type=float, default=0.0,
                    help="mm/s of filament (default: max_velocity * cross section / filament area)")
    ap.add_argument("--max-extrude-only-accel", type=float, default=0.0)
    ap.add_argument("--max-extrude-cross-section", type=float, default=None)
    ap.add_argument("--nozzle-diameter", type=float, default=0.4)
    ap.add_argument("--filament-diameter", type=float, default=1.75)
    ap.add_argument("--jd", type=float, default=None, help="fixed junction deviation, mm")
    ap.add_argument("--no-mcr", action="store_true")
    ap.add_argument("--no-extruder-corner", action="store_true")
    ap.add_argument("--no-pa-flush", action="store_true")
    ap.add_argument("--no-z-limit", action="store_true")
    ap.add_argument("--no-lazy", action="store_true")
    ap.add_argument("--at-layer", type=int, action="append", default=[])
    ap.add_argument("--at-fraction", type=float, action="append", default=[])
    ap.add_argument("--overhead-s", type=float, default=0.0,
                    help="seconds of heat-up and homing to add to every elapsed time printed")
    ap.add_argument("--features", action="store_true", help="time by the `; TYPE:` comment")
    args = ap.parse_args()
    for path in args.files:
        timeline, th, flushes, stats = run(path, args)
        o = args.overhead_s
        print(f"== {path}")
        print(f"moves {stats['moves']}, extruder-only {stats['extruder-only moves']}, arcs {stats['arcs']}, "
              f"flushes {dict(flushes)}")
        print(f"toolhead time {timeline.t:.2f} s = {hms(timeline.t)}" + (f"; with overhead {hms(timeline.t + o)}" if o else ""))
        for layer in args.at_layer:
            if layer in timeline.layer_start:
                t = timeline.layer_start[layer]
                print(f"at start of layer {layer}: {t:.1f} s = {hms(t)}" + (f"; with overhead {hms(t + o)}" if o else ""))
            else:
                print(f"layer {layer} not found")
        for f in args.at_fraction:
            key = int(f * __import__("os").path.getsize(path))
            if key in timeline.offset_t:
                t = timeline.offset_t[key]
                print(f"at {100 * f:.1f}% of the file: {t:.1f} s = {hms(t)}" + (f"; with overhead {hms(t + o)}" if o else ""))
        if args.features:
            for k, v in sorted(timeline.by_kind.items(), key=lambda kv_: -kv_[1]):
                print(f"  {k:24} {v / 3600:7.2f} h {100 * v / timeline.t:5.1f}%")


if __name__ == "__main__":
    sys.exit(main())
