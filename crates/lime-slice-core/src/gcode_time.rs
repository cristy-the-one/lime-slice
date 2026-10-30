//! A G-code file's print time under Klipper's toolhead, read from the file
//! itself: the same lookahead the slice's estimate runs, fed the moves as
//! written. It is the engine's side of `tools/klipper_time.py`, and the check
//! that the estimate a slice writes is the time of the moves it wrote.

use crate::gcode::{hypot, plan_klipper, KinMove, KlipperCfg};
use crate::strategy::PrinterProfile;

/// Seconds Klipper takes to run `text` on `profile`'s printer: motion only,
/// without heat-up, homing waits or dwells.
///
/// Read the way `tools/klipper_time.py` reads a file: `G0`/`G1`, `G2`/`G3` as
/// 1 mm chords, `G90`/`G91`, `M82`/`M83`, `G92`, `M204`, and
/// `SET_VELOCITY_LIMIT`. An extrude-only move stops the toolhead before and
/// after. `SET_PRESSURE_ADVANCE`, `G4`, `M400`, `G28`, `M109` and `M190` empty
/// the lookahead queue. A new square corner velocity or cruise ratio also
/// ends the queue here, where Klipper would carry on; the slicer writes neither.
pub fn estimate_gcode_seconds(text: &str, profile: &PrinterProfile) -> f64 {
    let mut run = Run::new(profile);
    for raw in text.lines() {
        let code = raw.split(';').next().unwrap_or("").trim();
        if code.is_empty() {
            continue;
        }
        let mut words = code.split_whitespace();
        let cmd = words.next().unwrap_or("").to_ascii_uppercase();
        match cmd.as_str() {
            "G0" | "G1" => {
                let w = Words::of(words);
                run.feed(&w);
                let end = run.target(&w);
                run.line_to(end);
            }
            "G2" | "G3" => {
                let w = Words::of(words);
                run.feed(&w);
                let end = run.target(&w);
                run.arc_to(
                    end,
                    w.get('I').unwrap_or(0.0),
                    w.get('J').unwrap_or(0.0),
                    cmd == "G2",
                );
            }
            "G90" => run.absolute_xyz = true,
            "G91" => run.absolute_xyz = false,
            "M82" => run.absolute_e = true,
            "M83" => run.absolute_e = false,
            "G92" => {
                let w = Words::of(words);
                for (i, axis) in ['X', 'Y', 'Z', 'E'].into_iter().enumerate() {
                    if let Some(v) = w.get(axis) {
                        run.pos[i] = v;
                    }
                }
            }
            "M204" => {
                let w = Words::of(words);
                let accel = match (w.get('S'), w.get('P'), w.get('T')) {
                    (Some(s), _, _) => s,
                    (None, Some(p), Some(t)) => p.min(t),
                    _ => continue,
                };
                run.accel = accel;
            }
            "SET_VELOCITY_LIMIT" => run.velocity_limit(words),
            "SET_PRESSURE_ADVANCE" | "G4" | "M400" | "M109" | "M190" => run.flush(),
            "G28" => {
                run.flush();
                let mut any = false;
                for word in words {
                    if let Some(i) = "XYZ".find(word[..1].to_ascii_uppercase().as_str()) {
                        run.pos[i] = 0.0;
                        any = true;
                    }
                }
                if !any {
                    run.pos[..3].fill(0.0);
                }
            }
            _ => {}
        }
    }
    run.flush();
    run.seconds
}

struct Words(Vec<(char, f64)>);

impl Words {
    fn of<'a>(words: impl Iterator<Item = &'a str>) -> Self {
        Self(
            words
                .filter_map(|w| {
                    let mut chars = w.chars();
                    let letter = chars.next()?.to_ascii_uppercase();
                    chars.as_str().parse::<f64>().ok().map(|v| (letter, v))
                })
                .collect(),
        )
    }

    fn get(&self, letter: char) -> Option<f64> {
        self.0.iter().rev().find(|w| w.0 == letter).map(|w| w.1)
    }
}

struct Run {
    cfg: KlipperCfg,
    /// `SET_VELOCITY_LIMIT VELOCITY`, else the profile's cap. `0` is none.
    max_velocity: f64,
    /// The acceleration in force: `M204` or `SET_VELOCITY_LIMIT ACCEL`.
    accel: f64,
    pos: [f64; 4],
    absolute_xyz: bool,
    absolute_e: bool,
    /// mm/s, from the last `F`. Klipper starts at 25.
    speed: f64,
    chain: Vec<KinMove>,
    seconds: f64,
}

impl Run {
    fn new(profile: &PrinterProfile) -> Self {
        let cfg = KlipperCfg::new(profile);
        Self {
            max_velocity: cfg.max_velocity,
            cfg,
            accel: if profile.max_accel.is_finite() && profile.max_accel > 0.0 {
                profile.max_accel
            } else {
                1500.0
            },
            pos: [0.0; 4],
            absolute_xyz: true,
            absolute_e: true,
            speed: 25.0,
            chain: Vec::new(),
            seconds: 0.0,
        }
    }

    fn feed(&mut self, w: &Words) {
        if let Some(f) = w.get('F') {
            self.speed = f / 60.0;
        }
    }

    fn target(&self, w: &Words) -> [f64; 4] {
        let mut end = self.pos;
        for (i, axis) in ['X', 'Y', 'Z'].into_iter().enumerate() {
            if let Some(v) = w.get(axis) {
                end[i] = if self.absolute_xyz {
                    v
                } else {
                    self.pos[i] + v
                };
            }
        }
        if let Some(v) = w.get('E') {
            end[3] = if self.absolute_e { v } else { self.pos[3] + v };
        }
        end
    }

    fn velocity_limit<'a>(&mut self, words: impl Iterator<Item = &'a str>) {
        let mut corner = self.cfg.square_corner_velocity;
        let mut ratio = self.cfg.min_cruise_ratio;
        let mut to_decel = None;
        let mut named_ratio = false;
        for word in words {
            let Some((key, value)) = word.split_once('=') else {
                continue;
            };
            let Ok(value) = value.parse::<f64>() else {
                continue;
            };
            match key.to_ascii_uppercase().as_str() {
                "VELOCITY" => self.max_velocity = value,
                "ACCEL" => self.accel = value,
                "SQUARE_CORNER_VELOCITY" => corner = value,
                "MINIMUM_CRUISE_RATIO" => {
                    ratio = value;
                    named_ratio = true;
                }
                "ACCEL_TO_DECEL" => to_decel = Some(value),
                _ => {}
            }
        }
        if let (false, Some(to_decel)) = (named_ratio, to_decel) {
            ratio = 1.0 - (to_decel / self.accel.max(1e-9)).min(1.0);
        }
        let ratio = ratio.clamp(0.0, 0.999);
        if corner != self.cfg.square_corner_velocity || ratio != self.cfg.min_cruise_ratio {
            self.flush();
            self.cfg.square_corner_velocity = corner;
            self.cfg.corner_k = corner * corner * (std::f64::consts::SQRT_2 - 1.0);
            self.cfg.min_cruise_ratio = ratio;
        }
    }

    fn line_to(&mut self, end: [f64; 4]) {
        let d = [
            end[0] - self.pos[0],
            end[1] - self.pos[1],
            end[2] - self.pos[2],
            end[3] - self.pos[3],
        ];
        let dist = (d[0] * d[0] + d[1] * d[1] + d[2] * d[2]).sqrt();
        if dist < 1e-9 {
            self.pos[3] = end[3];
            if d[3] != 0.0 {
                self.extrude_only(d[3].abs());
            }
            return;
        }
        self.pos = end;
        let mut cruise = self.speed;
        if self.max_velocity > 0.0 {
            cruise = cruise.min(self.max_velocity);
        }
        let mut accel = self.accel;
        if d[2] != 0.0 {
            let ratio = dist / d[2].abs();
            if self.cfg.z_velocity > 0.0 {
                cruise = cruise.min(self.cfg.z_velocity * ratio);
            }
            if self.cfg.z_accel > 0.0 {
                accel = accel.min(self.cfg.z_accel * ratio);
            }
        }
        let e_per_mm = d[3] / dist;
        // Klipper's extruder check: a move that only lifts or pulls back filament
        // runs no faster than the extruder alone may.
        if d[3] != 0.0 && ((d[0] == 0.0 && d[1] == 0.0) || d[3] < 0.0) {
            let inv = 1.0 / e_per_mm.abs();
            cruise = cruise.min(self.cfg.e_velocity * inv);
            accel = accel.min(self.cfg.e_accel * inv);
        }
        self.chain.push(KinMove {
            dist,
            cruise,
            accel,
            entry_dir: [d[0], d[1]],
            exit_dir: [d[0], d[1]],
            kind: "move",
            dz: d[2],
            e_per_mm,
            m204: self.accel,
        });
    }

    /// `G2`/`G3` as Klipper's `gcode_arcs` runs it, in chords of about a millimetre.
    fn arc_to(&mut self, end: [f64; 4], i: f64, j: f64, clockwise: bool) {
        let start = self.pos;
        let center = [start[0] + i, start[1] + j];
        let radius = hypot(start[0] - center[0], start[1] - center[1]);
        let a0 = (start[1] - center[1]).atan2(start[0] - center[0]);
        let a1 = (end[1] - center[1]).atan2(end[0] - center[0]);
        let tau = std::f64::consts::TAU;
        let mut sweep = if clockwise { a0 - a1 } else { a1 - a0 }.rem_euclid(tau);
        if sweep < 1e-9 {
            sweep = tau;
        }
        let length = hypot(radius * sweep, end[2] - start[2]);
        let chords = (length.floor() as usize).max(1);
        let sign = if clockwise { -1.0 } else { 1.0 };
        for s in 1..=chords {
            let f = s as f64 / chords as f64;
            let point = if s == chords {
                end
            } else {
                let a = a0 + sign * sweep * f;
                [
                    center[0] + radius * a.cos(),
                    center[1] + radius * a.sin(),
                    start[2] + (end[2] - start[2]) * f,
                    start[3] + (end[3] - start[3]) * f,
                ]
            };
            self.line_to(point);
        }
    }

    fn extrude_only(&mut self, mm: f64) {
        self.flush();
        let one = [crate::gcode::extruder_only_move(
            mm, self.speed, self.accel, &self.cfg,
        )];
        self.seconds += plan_klipper(&one, &self.cfg).iter().sum::<f64>();
    }

    fn flush(&mut self) {
        if self.chain.is_empty() {
            return;
        }
        self.seconds += plan_klipper(&self.chain, &self.cfg).iter().sum::<f64>();
        self.chain.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::strategy::Firmware;

    fn ir3() -> PrinterProfile {
        PrinterProfile {
            firmware: Some(Firmware::Klipper),
            max_accel: 20000.0,
            square_corner_velocity: 8.0,
            minimum_cruise_ratio: 0.5,
            extruder_corner_velocity: 1.0,
            max_velocity: 400.0,
            max_z_velocity: 20.0,
            max_z_accel: 500.0,
            ..PrinterProfile::default()
        }
    }

    /// A 20 mm square walled twice per layer, a retracted travel to the next
    /// square, and a layer change, on the flat bed or (`belt`) along the belt.
    fn synthetic(belt: bool) -> String {
        let mut out = String::from("G90\nM82\nG92 E0\nM204 S7000\n");
        let mut e = 0.0;
        for layer in 0..20 {
            let z = if belt {
                0.2828 * (layer + 1) as f64
            } else {
                0.2 * (layer + 1) as f64
            };
            out.push_str(&format!("G1 Z{z:.3} F7200\n"));
            for (k, (accel, feed)) in [(3500, 7800), (4000, 8000)].into_iter().enumerate() {
                let o = 10.0 + k as f64 * 0.45;
                let s = 20.0 - 2.0 * k as f64 * 0.45;
                out.push_str("M204 S7000\n");
                out.push_str(&format!("G1 X{o:.3} Y{o:.3} F18000\n"));
                out.push_str(&format!("M204 S{accel}\nG1 E{:.5} F1800\n", e + 0.35));
                e += 0.35;
                for (x, y) in [(o + s, o), (o + s, o + s), (o, o + s), (o, o)] {
                    e += s * 0.0333;
                    out.push_str(&format!("G1 X{x:.3} Y{y:.3} E{e:.5} F{feed}\n"));
                }
                e -= 0.35;
                out.push_str(&format!("G1 E{e:.5} F1800\n"));
            }
            for i in 0..30 {
                let x = 11.0 + (i % 2) as f64 * 17.0;
                let y = 11.0 + i as f64 * 0.55;
                e += 17.0 * 0.0333;
                out.push_str(&format!("G1 X{x:.3} Y{y:.3} E{e:.5} F9000\n"));
            }
        }
        out
    }

    // The numbers are `tools/klipper_time.py` on the same text, written out by
    // `write_synthetic_files`, at its IR3 V2 defaults (`--max-velocity 40` for
    // the last one).
    #[test]
    fn flat_file_takes_what_the_klipper_model_says() {
        let s = estimate_gcode_seconds(&synthetic(false), &ir3());
        assert!(
            (s - FLAT_S).abs() < FLAT_S * 0.001,
            "{s} s against {FLAT_S} s"
        );
    }

    #[test]
    fn belt_file_takes_what_the_klipper_model_says() {
        let s = estimate_gcode_seconds(&synthetic(true), &ir3());
        assert!(
            (s - BELT_S).abs() < BELT_S * 0.001,
            "{s} s against {BELT_S} s"
        );
    }

    #[test]
    fn a_low_max_velocity_is_what_a_slow_estimate_comes_from() {
        let slow = PrinterProfile {
            max_velocity: 40.0,
            ..ir3()
        };
        let s = estimate_gcode_seconds(&synthetic(true), &slow);
        assert!(
            (s - BELT_40_S).abs() < BELT_40_S * 0.001,
            "{s} s against {BELT_40_S} s"
        );
    }

    #[test]
    #[ignore]
    fn write_synthetic_files() {
        let dir = std::env::var("LIME_SYNTHETIC_DIR").expect("LIME_SYNTHETIC_DIR");
        std::fs::write(format!("{dir}/flat.gcode"), synthetic(false)).unwrap();
        std::fs::write(format!("{dir}/belt.gcode"), synthetic(true)).unwrap();
    }

    const FLAT_S: f64 = 121.704_233;
    const BELT_S: f64 = 121.850_854;
    const BELT_40_S: f64 = 348.369_629;
}
