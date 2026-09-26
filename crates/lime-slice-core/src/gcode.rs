use std::collections::BTreeMap;
use std::fmt::Write;
use std::sync::Arc;

use rayon::prelude::*;

use crate::strategy::{BlendMode, PrinterProfile};
use crate::toolpath::Extrusion;

#[derive(Clone, Debug)]
pub struct GcodeStats {
    pub text: String,
    pub extrusion_moves: usize,
    pub travel_moves: usize,
    pub final_e: f64,
    pub min_x: f64,
    pub max_x: f64,
    pub min_y: f64,
    pub max_y: f64,
    pub extrusion_length_mm: f64,
    pub travel_length_mm: f64,
    pub layer_count: usize,
    pub print_time_s: f64,
    pub filament_mm: f64,
    pub filament_g: f64,
    pub arc_moves: usize,
    pub retracts: usize,
    pub z_hops: usize,
    /// Print time and filament grouped by path kind. Travel is its own row.
    pub by_feature: Vec<FeatureStat>,
    /// Estimator seconds for each emitted layer, in layer order.
    pub layer_seconds: Vec<f64>,
    pub cancelled: bool,
}

#[derive(Clone, Debug)]
pub struct FeatureStat {
    pub kind: String,
    pub seconds: f64,
    pub filament_mm: f64,
}

#[allow(clippy::too_many_arguments)]
pub fn emit_gcode(
    layers: &[LayerPaths],
    profile: &PrinterProfile,
    blend: &BlendMode,
    layer_height: f64,
    line_width: f64,
    features: &str,
    arc_fit: bool,
    classic_estimator: bool,
    junction_deviation_mm: f64,
    job: crate::cancel::Job,
) -> GcodeStats {
    emit_gcode_inner(
        layers,
        profile,
        blend,
        layer_height,
        line_width,
        features,
        arc_fit,
        classic_estimator,
        junction_deviation_mm,
        job,
        true,
    )
}

/// Single-writer emit. Tests use it to prove the parallel reduce is the same G-code.
#[cfg(test)]
#[allow(clippy::too_many_arguments)]
pub(crate) fn emit_gcode_linear(
    layers: &[LayerPaths],
    profile: &PrinterProfile,
    blend: &BlendMode,
    layer_height: f64,
    line_width: f64,
    features: &str,
    arc_fit: bool,
    classic_estimator: bool,
    junction_deviation_mm: f64,
    job: crate::cancel::Job,
) -> GcodeStats {
    emit_gcode_inner(
        layers,
        profile,
        blend,
        layer_height,
        line_width,
        features,
        arc_fit,
        classic_estimator,
        junction_deviation_mm,
        job,
        false,
    )
}

#[allow(clippy::too_many_arguments)]
fn emit_gcode_inner(
    layers: &[LayerPaths],
    profile: &PrinterProfile,
    blend: &BlendMode,
    layer_height: f64,
    line_width: f64,
    features: &str,
    arc_fit: bool,
    classic_estimator: bool,
    junction_deviation_mm: f64,
    job: crate::cancel::Job,
    parallel: bool,
) -> GcodeStats {
    let junction_deviation = if junction_deviation_mm.is_finite() && junction_deviation_mm > 0.0 {
        junction_deviation_mm
    } else {
        DEFAULT_JUNCTION_DEVIATION_MM
    };
    let cfg = EmitCfg {
        classic_estimator,
        junction_deviation,
        arc_fit,
        max_accel: profile.max_accel,
        max_volumetric_mm3_s: profile.max_volumetric_mm3_s,
        filament_diameter: profile.filament_diameter,
        pa_base: profile.pressure_advance.max(0.0),
        la_base: profile.linear_advance.max(0.0),
        emit_pa: profile.pressure_advance > 0.0 || profile.linear_advance > 0.0,
    };
    if !parallel {
        let mut w = Writer::blank(&cfg, Carry::initial(&cfg), false);
        write_preamble(
            &mut w.out,
            profile,
            blend,
            layer_height,
            line_width,
            features,
            classic_estimator,
            junction_deviation,
        );
        let mut emitted_layers = 0usize;
        for layer in layers {
            if job.cancelled() {
                w.cancelled = true;
                break;
            }
            if layer.paths.is_empty() {
                continue;
            }
            w.write_layer(layer);
            emitted_layers += 1;
        }
        w.finish(profile);
        return w.stats(emitted_layers, profile);
    }

    // Arc choices do not depend on machine state, so they are planned once per
    // layer. A quiet scan then replays them to carry E, fan, accel, and
    // pressure advance across layers. Formatting replays the same arcs into
    // one string per layer and the strings are joined in layer index order.
    // Lookahead stays on the quiet scan: it already stops at each layer, and
    // that pass is what the print-time totals come from.
    let scripts: Vec<Arc<Vec<Vec<Span>>>> = layers
        .par_iter()
        .map(|layer| {
            Arc::new(if layer.paths.is_empty() {
                Vec::new()
            } else {
                chain_scripts(layer, arc_fit)
            })
        })
        .collect();
    let mut w = Writer::blank(&cfg, Carry::initial(&cfg), false);
    w.quiet = true;
    let mut seeds = Vec::new();
    let mut emitted_layers = 0usize;
    for (index, layer) in layers.iter().enumerate() {
        if job.cancelled() {
            w.cancelled = true;
            break;
        }
        if layer.paths.is_empty() {
            continue;
        }
        seeds.push(Seed {
            index,
            carry: w.carry(),
        });
        w.replay = Some(Arc::clone(&scripts[index]));
        w.replay_i = 0;
        w.write_layer(layer);
        emitted_layers += 1;
    }
    w.quiet = false;
    w.out.clear();
    w.finish(profile);
    let epilogue = std::mem::take(&mut w.out);
    let mut stats = w.stats(emitted_layers, profile);

    let mut text = String::new();
    write_preamble(
        &mut text,
        profile,
        blend,
        layer_height,
        line_width,
        features,
        classic_estimator,
        junction_deviation,
    );
    let bodies: Vec<String> = seeds
        .par_iter()
        .map(|seed| {
            let layer = &layers[seed.index];
            let mut layer_w = Writer::blank(&cfg, seed.carry, true);
            let points: usize = layer
                .paths
                .iter()
                .map(|path| path.points.len() + path.lead_in.len())
                .sum();
            layer_w
                .out
                .reserve(points.saturating_mul(48).saturating_add(128));
            layer_w.replay = Some(Arc::clone(&scripts[seed.index]));
            layer_w.write_layer(layer);
            layer_w.out
        })
        .collect();
    let extra: usize = bodies.iter().map(String::len).sum::<usize>() + epilogue.len();
    text.reserve(extra);
    for body in &bodies {
        text.push_str(body);
    }
    text.push_str(&epilogue);
    stats.text = text;
    stats
}

#[derive(Clone, Copy)]
struct EmitCfg {
    classic_estimator: bool,
    junction_deviation: f64,
    arc_fit: bool,
    max_accel: f64,
    max_volumetric_mm3_s: f64,
    filament_diameter: f64,
    pa_base: f64,
    la_base: f64,
    emit_pa: bool,
}

/// Machine state that changes G-code across a layer boundary.
/// Lookahead and the nozzle direction do not: each layer header clears them.
#[derive(Clone, Copy)]
struct Carry {
    e: f64,
    x: f64,
    y: f64,
    z: f64,
    has_pos: bool,
    retracted: f64,
    accel: f64,
    fan: i32,
    pa_cur: f64,
    la_cur: f64,
}

impl Carry {
    fn initial(cfg: &EmitCfg) -> Self {
        Self {
            e: 0.0,
            x: 0.0,
            y: 0.0,
            z: 0.0,
            has_pos: false,
            retracted: 0.0,
            accel: 1500.0,
            fan: 0,
            pa_cur: cfg.pa_base,
            la_cur: cfg.la_base,
        }
    }
}

struct Seed {
    index: usize,
    carry: Carry,
}

#[allow(clippy::too_many_arguments)]
fn write_preamble(
    out: &mut String,
    profile: &PrinterProfile,
    blend: &BlendMode,
    layer_height: f64,
    line_width: f64,
    features: &str,
    classic_estimator: bool,
    junction_deviation: f64,
) {
    let filament = profile.filament_diameter;
    let bed = profile.bed_temp;
    let nozzle = profile.nozzle_temp;
    out.push_str("; generated by Lime Slice — FDM strategy blender\n");
    let _ = writeln!(out, "; printer: {}", profile.name);
    let _ = writeln!(out, "; blend: {}", blend.describe());
    let _ = writeln!(
        out,
        "; layer_height: {layer_height:.3} line_width: {line_width:.3} filament: {filament:.2}"
    );
    let _ = writeln!(out, "; features: {features}");
    let _ = writeln!(out, "M140 S{bed:.0}");
    let _ = writeln!(out, "M104 S{nozzle:.0}");
    let _ = writeln!(out, "M190 S{bed:.0}");
    let _ = writeln!(out, "M109 S{nozzle:.0}");
    if classic_estimator {
        out.push_str("; estimator: classic (stop at each segment end)\n");
    } else {
        let _ = writeln!(
            out,
            "; estimator: lookahead junction_deviation={junction_deviation:.4}"
        );
    }
    let start_accel = cap_accel(1500.0, profile.max_accel);
    let _ = writeln!(
        out,
        "G21\nG90\nM82\nG28\nG92 E0\nM106 S0\nM204 S{start_accel:.0}"
    );
    if profile.pressure_advance > 0.0 {
        let advance = profile.pressure_advance;
        let _ = writeln!(out, "SET_PRESSURE_ADVANCE ADVANCE={advance:.4}");
    }
    if profile.linear_advance > 0.0 {
        let linear = profile.linear_advance;
        let _ = writeln!(out, "M900 K{linear:.3}");
    }
}

pub struct LayerPaths {
    pub index: usize,
    pub z: f64,
    pub height: f64,
    pub paths: Vec<Extrusion>,
    pub note: String,
}

struct Writer {
    out: String,
    e: f64,
    x: f64,
    y: f64,
    z: f64,
    has_pos: bool,
    retracted: f64,
    accel: f64,
    fan: i32,
    extrusion_moves: usize,
    travel_moves: usize,
    min_x: f64,
    max_x: f64,
    min_y: f64,
    max_y: f64,
    extrusion_length_mm: f64,
    travel_length_mm: f64,
    bounds_init: bool,
    time_s: f64,
    arc_moves: usize,
    retracts: usize,
    z_hops: usize,
    dir: [f64; 2],
    has_dir: bool,
    pa_base: f64,
    la_base: f64,
    pa_cur: f64,
    la_cur: f64,
    emit_pa: bool,
    kind: String,
    feature_s: BTreeMap<String, f64>,
    feature_mm: BTreeMap<String, f64>,
    layer_seconds: Vec<f64>,
    layer_mark: f64,
    layer_open: bool,
    cancelled: bool,
    /// Stop to zero at every segment end. Reproduces the pre-lookahead benches.
    classic_estimator: bool,
    /// Klipper junction deviation, millimetres. Ignored by the classic estimator.
    junction_deviation: f64,
    pending: Vec<KinMove>,
    /// Planned arcs for this layer, shared with the formatter. Empty means fit inline.
    replay: Option<Arc<Vec<Vec<Span>>>>,
    replay_i: usize,
    /// Skip string writes. The carry scan uses this so formatting can run per layer.
    quiet: bool,
    /// Skip lookahead and feature totals. Layer tasks only need the G-code text;
    /// the quiet scan already accumulated print time.
    strings_only: bool,
    arc_fit: bool,
    max_accel: f64,
    max_volumetric_mm3_s: f64,
    filament_diameter: f64,
}

struct KinMove {
    dist: f64,
    cruise: f64,
    accel: f64,
    entry_dir: [f64; 2],
    exit_dir: [f64; 2],
    kind: String,
}

impl Writer {
    fn blank(cfg: &EmitCfg, carry: Carry, strings_only: bool) -> Self {
        Self {
            out: String::new(),
            e: carry.e,
            x: carry.x,
            y: carry.y,
            z: carry.z,
            has_pos: carry.has_pos,
            retracted: carry.retracted,
            accel: carry.accel,
            fan: carry.fan,
            extrusion_moves: 0,
            travel_moves: 0,
            min_x: 0.0,
            max_x: 0.0,
            min_y: 0.0,
            max_y: 0.0,
            extrusion_length_mm: 0.0,
            travel_length_mm: 0.0,
            bounds_init: false,
            time_s: 0.0,
            arc_moves: 0,
            retracts: 0,
            z_hops: 0,
            dir: [1.0, 0.0],
            has_dir: false,
            pa_base: cfg.pa_base,
            la_base: cfg.la_base,
            pa_cur: carry.pa_cur,
            la_cur: carry.la_cur,
            emit_pa: cfg.emit_pa,
            kind: "travel".into(),
            feature_s: BTreeMap::new(),
            feature_mm: BTreeMap::new(),
            layer_seconds: Vec::new(),
            layer_mark: 0.0,
            layer_open: false,
            cancelled: false,
            classic_estimator: cfg.classic_estimator,
            junction_deviation: cfg.junction_deviation,
            pending: Vec::new(),
            replay: None,
            replay_i: 0,
            quiet: false,
            strings_only,
            arc_fit: cfg.arc_fit,
            max_accel: cfg.max_accel,
            max_volumetric_mm3_s: cfg.max_volumetric_mm3_s,
            filament_diameter: cfg.filament_diameter,
        }
    }

    fn carry(&self) -> Carry {
        Carry {
            e: self.e,
            x: self.x,
            y: self.y,
            z: self.z,
            has_pos: self.has_pos,
            retracted: self.retracted,
            accel: self.accel,
            fan: self.fan,
            pa_cur: self.pa_cur,
            la_cur: self.la_cur,
        }
    }

    fn put(&mut self, args: std::fmt::Arguments<'_>) {
        if self.quiet {
            return;
        }
        let _ = self.out.write_fmt(args);
    }

    fn put_str(&mut self, text: &str) {
        if self.quiet {
            return;
        }
        self.out.push_str(text);
    }

    /// Header, paths, then flush. The flush used to run at the next layer's
    /// header, before that layer's Z time, which is the same moment.
    fn write_layer(&mut self, layer: &LayerPaths) {
        self.layer_header(layer);
        for path in &layer.paths {
            self.set_advance(path.kind.as_str());
            if layer.index >= 2 {
                self.set_fan(path.fan);
            } else if layer.index == 1 {
                self.set_fan(128);
            } else {
                self.set_fan(0);
            }
            let speed = if layer.index == 0 {
                path.speed.min(30.0)
            } else {
                path.speed
            };
            let flow = if layer.index == 0 { 1.06 } else { 1.0 };
            if !self.quiet {
                self.comment(&format!("TYPE:{}", path.kind.as_str().to_ascii_uppercase()));
            }
            if path.points.is_empty() {
                continue;
            }
            let bead_h = if path.bead_height > 1e-6 {
                path.bead_height
            } else {
                layer.height
            };
            self.kind = "travel".into();
            let travel_accel = cap_accel(path.travel_accel, self.max_accel);
            let print_accel = cap_accel(path.accel, self.max_accel);
            self.set_accel(travel_accel);
            let mut hop = path.lead_in.clone();
            hop.push(path.points[0]);
            let (retract_mm, min_travel) = path.travel_retract();
            self.travel_chain(
                &hop,
                path.travel_speed,
                retract_mm,
                min_travel,
                travel_accel,
                path.z_hop,
                layer.z,
            );
            self.kind = path.kind.as_str().into();
            self.set_accel(print_accel);
            let limited = limit_speed(
                speed,
                path.width,
                bead_h,
                flow * path.flow,
                self.max_volumetric_mm3_s,
            );
            let (fit, loose) = chain_fit(self.arc_fit, path);
            self.emit_chain(
                &path.points,
                limited,
                path.width,
                bead_h,
                flow * path.flow,
                self.filament_diameter,
                print_accel,
                fit,
                loose,
                &path.z_frac,
                &path.flow_frac,
                layer.z,
                layer.height,
            );
        }
        self.close_layer();
    }

    fn flush_motion(&mut self) {
        if self.pending.is_empty() {
            return;
        }
        let pending = std::mem::take(&mut self.pending);
        let times = plan_lookahead(&pending, self.junction_deviation);
        let saved = self.kind.clone();
        for (mv, dt) in pending.iter().zip(times) {
            self.kind.clone_from(&mv.kind);
            self.add_time(dt);
        }
        self.kind = saved;
    }

    fn queue_kin(
        &mut self,
        dist: f64,
        cruise: f64,
        accel: f64,
        entry_dir: [f64; 2],
        exit_dir: [f64; 2],
    ) {
        if self.strings_only || dist < 1e-6 {
            return;
        }
        self.pending.push(KinMove {
            dist,
            cruise: cruise.max(1.0),
            accel: accel.max(50.0),
            entry_dir,
            exit_dir,
            kind: self.kind.clone(),
        });
    }

    fn add_time(&mut self, dt: f64) {
        if self.strings_only || dt <= 0.0 {
            return;
        }
        self.time_s += dt;
        *self.feature_s.entry(self.kind.clone()).or_insert(0.0) += dt;
    }

    fn add_filament(&mut self, mm: f64) {
        if self.strings_only || mm <= 0.0 {
            return;
        }
        *self.feature_mm.entry(self.kind.clone()).or_insert(0.0) += mm;
    }

    fn close_layer(&mut self) {
        self.flush_motion();
        if self.layer_open {
            self.layer_seconds
                .push((self.time_s - self.layer_mark).max(0.0));
            self.layer_open = false;
        }
    }

    fn set_advance(&mut self, kind: &str) {
        if !self.emit_pa {
            return;
        }
        let scale = crate::strategy::advance_scale(kind);
        let pa = self.pa_base * scale;
        let la = self.la_base * scale;
        if self.pa_base > 0.0 && (pa - self.pa_cur).abs() > 1e-4 {
            self.put(format_args!("SET_PRESSURE_ADVANCE ADVANCE={pa:.4}\n"));
            self.pa_cur = pa;
        }
        if self.la_base > 0.0 && (la - self.la_cur).abs() > 1e-4 {
            self.put(format_args!("M900 K{la:.3}\n"));
            self.la_cur = la;
        }
    }

    fn comment(&mut self, text: &str) {
        self.put_str("; ");
        self.put_str(text);
        self.put_str("\n");
    }

    fn layer_header(&mut self, layer: &LayerPaths) {
        self.put(format_args!(
            ";LAYER:{} Z:{:.3} H:{:.3} {}\n",
            layer.index, layer.z, layer.height, layer.note
        ));
        let dz = (layer.z - self.z).abs();
        let f = (120.0_f64 * 60.0) as i32;
        let z = layer.z;
        self.put(format_args!("G1 Z{z:.3} F{f}\n"));
        self.close_layer();
        self.kind = "travel".into();
        if dz > 1e-6 {
            self.add_time(dz / 120.0);
        }
        self.layer_mark = self.time_s;
        self.layer_open = true;
        self.z = layer.z;
        self.has_dir = false;
    }

    fn set_accel(&mut self, accel: f64) {
        let accel = accel.round();
        if (accel - self.accel).abs() < 1.0 {
            return;
        }
        self.accel = accel;
        self.put(format_args!("M204 S{accel:.0}\n"));
    }

    fn set_fan(&mut self, pwm: u8) {
        let pwm = pwm as i32;
        if pwm == self.fan {
            return;
        }
        self.fan = pwm;
        self.put(format_args!("M106 S{pwm}\n"));
    }

    fn unretract(&mut self) {
        if self.retracted > 0.0 {
            self.flush_motion();
            self.e += self.retracted;
            let feed = self.retracted;
            self.retracted = 0.0;
            let e_now = self.e;
            self.put(format_args!("G1 E{e_now:.5} F1800\n"));
            let prev = self.kind.clone();
            self.kind = "travel".into();
            self.add_time(feed / 30.0);
            self.kind = prev;
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn travel_chain(
        &mut self,
        pts: &[[f64; 2]],
        speed: f64,
        retract_mm: f64,
        min_travel: f64,
        accel: f64,
        z_hop: f64,
        layer_z: f64,
    ) {
        if z_hop > 1e-6 && self.has_pos {
            let mut full = Vec::with_capacity(pts.len() + 1);
            full.push([self.x, self.y]);
            full.extend(pts.iter().copied());
            let total: f64 = full
                .windows(2)
                .map(|w| hypot(w[1][0] - w[0][0], w[1][1] - w[0][1]))
                .sum();
            if total >= 0.02 {
                self.hop_travel(&full, speed, retract_mm, accel, z_hop, layer_z, total);
                return;
            }
        }
        for (i, p) in pts.iter().enumerate() {
            let retract = if i == 0 { retract_mm } else { 0.0 };
            self.travel_one(p[0], p[1], speed, retract, min_travel, accel);
        }
    }

    /// Retract, slope up to `layer_z + z_hop` along the travel, then slope back
    /// to the layer before the next extrusion. A short hop lifts vertically.
    #[allow(clippy::too_many_arguments)]
    fn hop_travel(
        &mut self,
        pts: &[[f64; 2]],
        speed: f64,
        retract_mm: f64,
        accel: f64,
        z_hop: f64,
        layer_z: f64,
        total: f64,
    ) {
        if retract_mm > 0.0 && self.retracted == 0.0 {
            self.flush_motion();
            self.e -= retract_mm;
            self.retracted = retract_mm;
            self.retracts += 1;
            let e_now = self.e;
            self.put(format_args!("G1 E{e_now:.5} F1800\n"));
            self.add_time(retract_mm / 30.0);
        }
        self.z_hops += 1;
        let ramp = (z_hop * 4.0).clamp(0.6, 2.5).min(total * 0.45);
        if total < ramp * 2.2 {
            self.set_z(layer_z + z_hop);
            for p in pts {
                self.travel_dry(p[0], p[1], speed, accel);
            }
            self.set_z(layer_z);
        } else {
            self.slope_along(pts, speed, accel, layer_z, z_hop, ramp, total);
        }
        self.unretract();
    }

    #[allow(clippy::too_many_arguments)]
    fn slope_along(
        &mut self,
        pts: &[[f64; 2]],
        speed: f64,
        accel: f64,
        layer_z: f64,
        z_hop: f64,
        ramp: f64,
        total: f64,
    ) {
        let mut walked = 0.0;
        for w in pts.windows(2) {
            let seg = hypot(w[1][0] - w[0][0], w[1][1] - w[0][1]);
            if seg < 1e-6 {
                continue;
            }
            let mut left = seg;
            let mut a = w[0];
            while left > 1e-4 {
                let dist = walked;
                let z_here = hop_height(dist, total, ramp, layer_z, z_hop);
                let next_mark = if dist < ramp {
                    ramp
                } else if dist < total - ramp {
                    total - ramp
                } else {
                    total
                };
                let step = (next_mark - dist).max(0.05).min(left);
                let _ = z_here;
                let b = [
                    a[0] + (w[1][0] - a[0]) * (step / left),
                    a[1] + (w[1][1] - a[1]) * (step / left),
                ];
                let z_next = hop_height(dist + step, total, ramp, layer_z, z_hop);
                self.travel_dry_z(b[0], b[1], z_next, speed, accel);
                walked += step;
                left -= step;
                a = b;
            }
        }
        self.set_z(layer_z);
    }

    fn travel_dry(&mut self, x: f64, y: f64, speed: f64, accel: f64) {
        self.travel_dry_z(x, y, self.z, speed, accel);
    }

    fn travel_dry_z(&mut self, x: f64, y: f64, z: f64, speed: f64, accel: f64) {
        if !self.has_pos {
            self.x = x;
            self.y = y;
            self.z = z;
            self.has_pos = true;
            return;
        }
        let d = hypot(x - self.x, y - self.y);
        let dz = (z - self.z).abs();
        if d < 0.02 && dz < 5e-4 {
            return;
        }
        self.travel_length_mm += d;
        let cruise = speed.max(10.0);
        let dist = (d * d + dz * dz).sqrt();
        if self.classic_estimator || d < 0.02 {
            if !self.classic_estimator {
                self.flush_motion();
            }
            self.add_time(move_time(dist, 0.0, 0.0, cruise, accel));
            self.has_dir = false;
        } else {
            self.queue_kin(
                dist,
                cruise,
                accel,
                [x - self.x, y - self.y],
                [x - self.x, y - self.y],
            );
        }
        let f = (speed.max(10.0) * 60.0).round() as i32;
        if dz > 5e-4 {
            self.put(format_args!("G1 X{x:.3} Y{y:.3} Z{z:.3} F{f}\n"));
            self.z = z;
        } else {
            self.put(format_args!("G1 X{x:.3} Y{y:.3} F{f}\n"));
        }
        self.x = x;
        self.y = y;
        self.has_pos = true;
        self.travel_moves += 1;
    }

    fn travel_one(
        &mut self,
        x: f64,
        y: f64,
        speed: f64,
        retract_mm: f64,
        min_travel: f64,
        accel: f64,
    ) {
        if self.has_pos {
            let d = hypot(x - self.x, y - self.y);
            if d < 0.02 {
                return;
            }
            if d >= min_travel && retract_mm > 0.0 && self.retracted == 0.0 {
                self.flush_motion();
                self.e -= retract_mm;
                self.retracted = retract_mm;
                self.retracts += 1;
                let e_now = self.e;
                self.put(format_args!("G1 E{e_now:.5} F1800\n"));
                self.add_time(retract_mm / 30.0);
            }
            self.travel_length_mm += d;
            let cruise = speed.max(10.0);
            if self.classic_estimator {
                self.add_time(move_time(d, 0.0, 0.0, cruise, accel));
                self.has_dir = false;
            } else {
                let dir = [x - self.x, y - self.y];
                self.queue_kin(d, cruise, accel, dir, dir);
            }
        }
        let f = (speed.max(10.0) * 60.0).round() as i32;
        self.put(format_args!("G1 X{x:.3} Y{y:.3} F{f}\n"));
        self.x = x;
        self.y = y;
        self.has_pos = true;
        self.travel_moves += 1;
    }

    #[allow(clippy::too_many_arguments)]
    fn emit_chain(
        &mut self,
        points: &[[f64; 2]],
        speed: f64,
        width: f64,
        layer_h: f64,
        flow: f64,
        filament_d: f64,
        accel: f64,
        arc_fit: bool,
        loose_arcs: bool,
        z_frac: &[f64],
        flow_frac: &[f64],
        layer_z: f64,
        nominal_h: f64,
    ) {
        if points.len() < 2 {
            return;
        }
        let scarfed = z_frac.len() == points.len() && flow_frac.len() == points.len();
        if scarfed {
            self.set_z(nozzle_z(layer_z, nominal_h, z_frac[0]));
        }
        if self.replay.is_some() {
            let replay = self.replay.clone().expect("replay");
            let i = self.replay_i;
            self.replay_i += 1;
            self.play_spans(
                points, &replay[i], speed, width, layer_h, flow, filament_d, accel, z_frac,
                flow_frac, layer_z, nominal_h,
            );
            if scarfed {
                self.set_z(layer_z);
            }
            return;
        }
        let arc_tol = if loose_arcs { 0.16 } else { 0.07 };
        let min_r = if loose_arcs { 0.35 } else { 0.8 };
        let max_span = if loose_arcs { 64 } else { 32 };
        let mut i = 0usize;
        while i + 1 < points.len() {
            let mut end = i + 1;
            if arc_fit && i + 3 < points.len() && span_planar(z_frac, flow_frac, i, i + 4) {
                let mut j = i + 3;
                while j < points.len()
                    && j - i <= max_span
                    && span_planar(z_frac, flow_frac, i, j + 1)
                {
                    if fit_arc(&points[i..=j], arc_tol, min_r).is_some() {
                        end = j;
                        j += 1;
                    } else {
                        break;
                    }
                }
            }
            if end >= i + 3 && span_planar(z_frac, flow_frac, i, end + 1) {
                if let Some(arc) = fit_arc(&points[i..=end], arc_tol, min_r) {
                    let h = if scarfed {
                        layer_h * z_frac[i].clamp(0.0, 1.0)
                    } else {
                        layer_h
                    };
                    self.arc(&arc, speed, width, h, flow, filament_d, accel);
                    i = end;
                    continue;
                }
            }
            let p = points[i + 1];
            let (h, seg_flow, z) = if scarfed {
                let z0 = z_frac[i].clamp(0.0, 1.0);
                let z1 = z_frac[i + 1].clamp(0.0, 1.0);
                let f0 = flow_frac[i].clamp(0.0, 2.0);
                let f1 = flow_frac[i + 1].clamp(0.0, 2.0);
                (
                    nominal_h * 0.5 * (z0 + z1),
                    flow * 0.5 * (f0 + f1),
                    Some(nozzle_z(layer_z, nominal_h, z1)),
                )
            } else {
                (layer_h, flow, None)
            };
            self.extrude(p[0], p[1], speed, width, h, seg_flow, filament_d, accel, z);
            i += 1;
        }
        if scarfed {
            self.set_z(layer_z);
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn play_spans(
        &mut self,
        points: &[[f64; 2]],
        spans: &[Span],
        speed: f64,
        width: f64,
        layer_h: f64,
        flow: f64,
        filament_d: f64,
        accel: f64,
        z_frac: &[f64],
        flow_frac: &[f64],
        layer_z: f64,
        nominal_h: f64,
    ) {
        let scarfed = z_frac.len() == points.len() && flow_frac.len() == points.len();
        let mut i = 0usize;
        for span in spans {
            match span {
                Span::Line => {
                    let p = points[i + 1];
                    let (h, seg_flow, z) = if scarfed {
                        let z0 = z_frac[i].clamp(0.0, 1.0);
                        let z1 = z_frac[i + 1].clamp(0.0, 1.0);
                        let f0 = flow_frac[i].clamp(0.0, 2.0);
                        let f1 = flow_frac[i + 1].clamp(0.0, 2.0);
                        (
                            nominal_h * 0.5 * (z0 + z1),
                            flow * 0.5 * (f0 + f1),
                            Some(nozzle_z(layer_z, nominal_h, z1)),
                        )
                    } else {
                        (layer_h, flow, None)
                    };
                    self.extrude(p[0], p[1], speed, width, h, seg_flow, filament_d, accel, z);
                    i += 1;
                }
                Span::Arc { end_i, arc } => {
                    let h = if scarfed {
                        layer_h * z_frac[i].clamp(0.0, 1.0)
                    } else {
                        layer_h
                    };
                    self.arc(arc, speed, width, h, flow, filament_d, accel);
                    i = *end_i as usize;
                }
            }
        }
    }

    fn set_z(&mut self, z: f64) {
        if (z - self.z).abs() < 5e-4 {
            return;
        }
        let dz = (z - self.z).abs();
        let f = (120.0_f64 * 60.0) as i32;
        self.put(format_args!("G1 Z{z:.3} F{f}\n"));
        self.flush_motion();
        self.add_time(dz / 120.0);
        self.z = z;
    }

    #[allow(clippy::too_many_arguments)]
    fn arc(
        &mut self,
        arc: &ArcFit,
        speed: f64,
        width: f64,
        layer_h: f64,
        flow: f64,
        filament_d: f64,
        accel: f64,
    ) {
        self.unretract();
        let bead = width * layer_h * flow;
        let fil = std::f64::consts::PI * (filament_d * 0.5).powi(2);
        let de = arc.length * bead / fil;
        self.e += de;
        self.add_filament(de);
        let f = (speed.max(5.0) * 60.0).round() as i32;
        let cmd = if arc.cw { "G2" } else { "G3" };
        let e_now = self.e;
        let x = arc.end[0];
        let y = arc.end[1];
        let i = arc.ij[0];
        let j = arc.ij[1];
        self.put(format_args!(
            "{cmd} X{x:.3} Y{y:.3} I{i:.4} J{j:.4} E{e_now:.5} F{f}\n"
        ));
        self.note_motion(arc.end, arc.dir, arc.exit_dir, speed, accel, arc.length);
        self.arc_moves += 1;
        self.extrusion_moves += 1;
        self.extrusion_length_mm += arc.length;
    }

    #[allow(clippy::too_many_arguments)]
    fn extrude(
        &mut self,
        x: f64,
        y: f64,
        speed: f64,
        width: f64,
        layer_h: f64,
        flow: f64,
        filament_d: f64,
        accel: f64,
        z: Option<f64>,
    ) {
        self.unretract();
        let d = hypot(x - self.x, y - self.y);
        if d < 1e-4 {
            if let Some(z) = z {
                self.set_z(z);
            }
            return;
        }
        let bead = width * layer_h.max(0.0) * flow.max(0.0);
        let fil = std::f64::consts::PI * (filament_d * 0.5).powi(2);
        let de = d * bead / fil;
        self.e += de;
        self.add_filament(de);
        let f = (speed.max(5.0) * 60.0).round() as i32;
        let e_now = self.e;
        if let Some(z) = z {
            if (z - self.z).abs() > 5e-4 {
                self.put(format_args!(
                    "G1 X{x:.3} Y{y:.3} Z{z:.3} E{e_now:.5} F{f}\n"
                ));
                self.z = z;
            } else {
                self.put(format_args!("G1 X{x:.3} Y{y:.3} E{e_now:.5} F{f}\n"));
            }
        } else {
            self.put(format_args!("G1 X{x:.3} Y{y:.3} E{e_now:.5} F{f}\n"));
        }
        let dir = [x - self.x, y - self.y];
        self.note_motion([x, y], dir, dir, speed, accel, d);
        self.extrusion_moves += 1;
        self.extrusion_length_mm += d;
    }

    fn note_motion(
        &mut self,
        end: [f64; 2],
        entry_dir: [f64; 2],
        exit_dir: [f64; 2],
        speed: f64,
        accel: f64,
        dist: f64,
    ) {
        let cruise = speed.max(5.0);
        if self.classic_estimator {
            let v0 = if self.has_dir {
                let prev = self.dir[0] * entry_dir[0] + self.dir[1] * entry_dir[1];
                let n0 = hypot(self.dir[0], self.dir[1]).max(1e-9);
                let n1 = hypot(entry_dir[0], entry_dir[1]).max(1e-9);
                junction_speed(cruise, accel, prev / (n0 * n1))
            } else {
                0.0
            };
            self.add_time(move_time(dist, v0, 0.0, cruise, accel));
            self.dir = entry_dir;
            self.has_dir = true;
        } else {
            self.queue_kin(dist, cruise, accel, entry_dir, exit_dir);
        }
        self.note_bounds(end[0], end[1]);
        self.x = end[0];
        self.y = end[1];
        self.has_pos = true;
    }

    fn note_bounds(&mut self, x: f64, y: f64) {
        if self.strings_only {
            return;
        }
        if !self.bounds_init {
            self.min_x = x;
            self.max_x = x;
            self.min_y = y;
            self.max_y = y;
            self.bounds_init = true;
            return;
        }
        self.min_x = self.min_x.min(x);
        self.max_x = self.max_x.max(x);
        self.min_y = self.min_y.min(y);
        self.max_y = self.max_y.max(y);
    }

    fn finish(&mut self, profile: &PrinterProfile) {
        self.close_layer();
        if self.has_pos && self.retracted == 0.0 {
            self.e -= 1.0;
            self.retracted = 1.0;
            let e_now = self.e;
            self.put(format_args!("G1 E{e_now:.5} F1800\n"));
        }
        let z = self.z + 10.0;
        self.put(format_args!("G1 Z{z:.3} F600\n"));
        self.put_str("M106 S0\n");
        self.put_str("M104 S0\nM140 S0\n");
        let bed_x = profile.bed_x;
        let bed_y = profile.bed_y;
        let nozzle = profile.nozzle_diameter;
        self.put(format_args!(
            "; bed {bed_x}x{bed_y} mm nozzle {nozzle:.2} mm\n"
        ));
        let filament_mm = self.e + self.retracted;
        let area = std::f64::consts::PI * (profile.filament_diameter * 0.5).powi(2);
        let filament_g = filament_mm * area * profile.filament_density_g_cm3 / 1000.0;
        let time_s = self.time_s;
        let arc_moves = self.arc_moves;
        self.put(format_args!(
            "; TIME:{time_s:.1}s FILAMENT_MM:{filament_mm:.2} FILAMENT_G:{filament_g:.3} ARCS:{arc_moves}\n"
        ));
        self.put_str("M84\n");
    }

    fn stats(self, layer_count: usize, profile: &PrinterProfile) -> GcodeStats {
        let filament_mm = self.e + self.retracted;
        let area = std::f64::consts::PI * (profile.filament_diameter * 0.5).powi(2);
        let filament_g = filament_mm * area * profile.filament_density_g_cm3 / 1000.0;
        GcodeStats {
            final_e: filament_mm,
            print_time_s: self.time_s,
            filament_mm,
            filament_g,
            arc_moves: self.arc_moves,
            retracts: self.retracts,
            z_hops: self.z_hops,
            text: self.out,
            extrusion_moves: self.extrusion_moves,
            travel_moves: self.travel_moves,
            min_x: self.min_x,
            max_x: self.max_x,
            min_y: self.min_y,
            max_y: self.max_y,
            extrusion_length_mm: self.extrusion_length_mm,
            travel_length_mm: self.travel_length_mm,
            layer_count,
            by_feature: feature_rows(&self.feature_s, &self.feature_mm),
            layer_seconds: self.layer_seconds,
            cancelled: self.cancelled,
        }
    }
}

fn hop_height(dist: f64, total: f64, ramp: f64, layer_z: f64, z_hop: f64) -> f64 {
    let up = (dist / ramp.max(1e-6)).clamp(0.0, 1.0);
    let down = ((total - dist) / ramp.max(1e-6)).clamp(0.0, 1.0);
    layer_z + z_hop * up.min(down)
}

fn feature_rows(seconds: &BTreeMap<String, f64>, mm: &BTreeMap<String, f64>) -> Vec<FeatureStat> {
    let mut kinds: Vec<String> = seconds.keys().cloned().collect();
    for key in mm.keys() {
        if !kinds.iter().any(|k| k == key) {
            kinds.push(key.clone());
        }
    }
    kinds.sort();
    kinds
        .into_iter()
        .map(|kind| FeatureStat {
            seconds: seconds.get(&kind).copied().unwrap_or(0.0),
            filament_mm: mm.get(&kind).copied().unwrap_or(0.0),
            kind,
        })
        .filter(|row| row.seconds > 1e-6 || row.filament_mm > 1e-6)
        .collect()
}

fn hypot(x: f64, y: f64) -> f64 {
    x.hypot(y)
}

fn nozzle_z(layer_z: f64, layer_h: f64, frac: f64) -> f64 {
    let frac = frac.clamp(0.0, 1.0);
    let z = layer_z - layer_h * (1.0 - frac);
    z.clamp(layer_z - layer_h, layer_z)
}

/// A span can be a planar arc only when Z and flow stay constant across it.
fn span_planar(z_frac: &[f64], flow_frac: &[f64], start: usize, end_exclusive: usize) -> bool {
    if z_frac.is_empty() && flow_frac.is_empty() {
        return true;
    }
    if z_frac.is_empty() || flow_frac.is_empty() {
        return false;
    }
    let z0 = z_frac[start];
    let f0 = flow_frac[start];
    (start..end_exclusive).all(|k| {
        z_frac
            .get(k)
            .zip(flow_frac.get(k))
            .map(|(z, f)| (z - z0).abs() < 1e-3 && (f - f0).abs() < 1e-3)
            .unwrap_or(false)
    })
}

pub(crate) fn cap_accel(accel: f64, max_accel: f64) -> f64 {
    if !max_accel.is_finite() || max_accel <= 0.0 {
        return accel;
    }
    accel.min(max_accel)
}

pub(crate) fn limit_speed(speed: f64, width: f64, height: f64, flow: f64, max_vol: f64) -> f64 {
    if !max_vol.is_finite() || max_vol <= 0.0 {
        return speed;
    }
    let area = (width * height * flow).max(1e-6);
    speed.min(max_vol / area)
}

const DEFAULT_JUNCTION_DEVIATION_MM: f64 = 0.02;

/// Classic corner speed: `sqrt(accel * 0.02 / sin(θ/2))`, then the move still ends at 0.
fn junction_speed(cruise: f64, accel: f64, cos_theta: f64) -> f64 {
    let sin_half = ((1.0 - cos_theta.clamp(-1.0, 1.0)) * 0.5).max(0.0).sqrt();
    if sin_half < 1e-3 {
        return cruise;
    }
    (accel.max(50.0) * 0.02 / sin_half).sqrt().min(cruise)
}

fn move_time(dist: f64, v0: f64, v1: f64, cruise: f64, accel: f64) -> f64 {
    let a = accel.max(50.0);
    let cruise = cruise.max(v0).max(v1).max(1.0);
    let d_acc = (cruise * cruise - v0 * v0).max(0.0) / (2.0 * a);
    let d_dec = (cruise * cruise - v1 * v1).max(0.0) / (2.0 * a);
    if d_acc + d_dec <= dist {
        (cruise - v0).max(0.0) / a + (cruise - v1).max(0.0) / a + (dist - d_acc - d_dec) / cruise
    } else {
        let peak2 = a * dist + 0.5 * (v0 * v0 + v1 * v1);
        let peak = peak2.max(0.0).sqrt();
        (peak - v0).abs() / a + (peak - v1).abs() / a
    }
}

/// Klipper junction speed between two moves.
///
/// `v² = min(cruise², jd * accel * sin(θ/2) / (1 - sin(θ/2)), centripetal)`.
/// A straight line returns the slower cruise. A reversal returns 0.
fn klipper_junction(a: &KinMove, b: &KinMove, junction_deviation: f64) -> f64 {
    let n0 = hypot(a.exit_dir[0], a.exit_dir[1]).max(1e-9);
    let n1 = hypot(b.entry_dir[0], b.entry_dir[1]).max(1e-9);
    let dot = (a.exit_dir[0] * b.entry_dir[0] + a.exit_dir[1] * b.entry_dir[1]) / (n0 * n1);
    if dot > 0.999999 {
        return a.cruise.min(b.cruise);
    }
    if dot < -0.999999 {
        return 0.0;
    }
    let junction_cos = (-dot).clamp(-0.999999, 0.999999);
    let sin_theta_d2 = (0.5 * (1.0 - junction_cos)).sqrt();
    let denom = (1.0 - sin_theta_d2).max(1e-6);
    let r_jd = sin_theta_d2 / denom;
    let jd = junction_deviation.max(0.0);
    let mut v2 = (r_jd * jd * a.accel)
        .min(r_jd * jd * b.accel)
        .min(a.cruise * a.cruise)
        .min(b.cruise * b.cruise);
    v2 = v2.min(0.5 * a.dist * a.accel * sin_theta_d2);
    v2 = v2.min(0.5 * b.dist * b.accel * sin_theta_d2);
    v2.max(0.0).sqrt()
}

/// Forward and reverse passes so each move's exit speed is the next move's entry.
/// The chain starts and ends at rest. A second reverse clamps any exit the forward
/// pass lowered so the trapezoid still fits in the segment.
fn plan_lookahead(moves: &[KinMove], junction_deviation: f64) -> Vec<f64> {
    let n = moves.len();
    if n == 0 {
        return Vec::new();
    }
    let mut entry = vec![0.0; n];
    for i in 0..n - 1 {
        entry[i + 1] = klipper_junction(&moves[i], &moves[i + 1], junction_deviation);
    }
    for _ in 0..2 {
        let last = n - 1;
        let stop = (2.0 * moves[last].accel * moves[last].dist).sqrt();
        entry[last] = entry[last].min(stop).min(moves[last].cruise);
        for i in (0..last).rev() {
            let allow = (entry[i + 1] * entry[i + 1] + 2.0 * moves[i].accel * moves[i].dist).sqrt();
            entry[i] = entry[i].min(allow).min(moves[i].cruise);
        }
        entry[0] = 0.0;
        for i in 0..n - 1 {
            let reachable = (entry[i] * entry[i] + 2.0 * moves[i].accel * moves[i].dist).sqrt();
            entry[i + 1] = entry[i + 1]
                .min(reachable)
                .min(moves[i].cruise)
                .min(moves[i + 1].cruise);
        }
    }
    let mut times = Vec::with_capacity(n);
    for i in 0..n {
        let v0 = entry[i];
        let v1 = if i + 1 < n { entry[i + 1] } else { 0.0 };
        let cruise = moves[i].cruise.max(v0).max(v1);
        times.push(move_time(moves[i].dist, v0, v1, cruise, moves[i].accel));
    }
    times
}

#[derive(Clone)]
struct ArcFit {
    end: [f64; 2],
    ij: [f64; 2],
    cw: bool,
    length: f64,
    /// Tangent at the arc start. The classic estimator stores this as the exit direction.
    dir: [f64; 2],
    /// Tangent at the arc end. Lookahead uses it for the next junction.
    exit_dir: [f64; 2],
}

fn chain_fit(arc_fit: bool, path: &Extrusion) -> (bool, bool) {
    let wall = matches!(
        path.kind,
        crate::toolpath::PathKind::Wall
            | crate::toolpath::PathKind::Outer
            | crate::toolpath::PathKind::Inner
            | crate::toolpath::PathKind::ThinWall
            | crate::toolpath::PathKind::Skirt
    );
    (arc_fit && (path.fit_arcs || wall), path.fit_arcs)
}

fn chain_scripts(layer: &LayerPaths, arc_fit: bool) -> Vec<Vec<Span>> {
    let mut scripts = Vec::new();
    for path in &layer.paths {
        if path.points.len() < 2 {
            continue;
        }
        let (fit, loose) = chain_fit(arc_fit, path);
        scripts.push(plan_spans(
            &path.points,
            &path.z_frac,
            &path.flow_frac,
            fit,
            loose,
        ));
    }
    scripts
}

fn plan_spans(
    points: &[[f64; 2]],
    z_frac: &[f64],
    flow_frac: &[f64],
    arc_fit: bool,
    loose_arcs: bool,
) -> Vec<Span> {
    let arc_tol = if loose_arcs { 0.16 } else { 0.07 };
    let min_r = if loose_arcs { 0.35 } else { 0.8 };
    let max_span = if loose_arcs { 64 } else { 32 };
    let mut spans = Vec::new();
    let mut i = 0usize;
    while i + 1 < points.len() {
        let mut end = i + 1;
        if arc_fit && i + 3 < points.len() && span_planar(z_frac, flow_frac, i, i + 4) {
            let mut j = i + 3;
            while j < points.len() && j - i <= max_span && span_planar(z_frac, flow_frac, i, j + 1)
            {
                if fit_arc(&points[i..=j], arc_tol, min_r).is_some() {
                    end = j;
                    j += 1;
                } else {
                    break;
                }
            }
        }
        if end >= i + 3 && span_planar(z_frac, flow_frac, i, end + 1) {
            if let Some(arc) = fit_arc(&points[i..=end], arc_tol, min_r) {
                spans.push(Span::Arc {
                    end_i: end as u32,
                    arc,
                });
                i = end;
                continue;
            }
        }
        spans.push(Span::Line);
        i += 1;
    }
    spans
}

#[derive(Clone)]
enum Span {
    Line,
    Arc { end_i: u32, arc: ArcFit },
}

fn fit_arc(pts: &[[f64; 2]], tol: f64, min_r: f64) -> Option<ArcFit> {
    if pts.len() < 4 {
        return None;
    }
    let a = pts[0];
    let mid = pts[pts.len() / 2];
    let c = *pts.last().unwrap();
    let center = circumcenter(a, mid, c)?;
    let r = hypot(a[0] - center[0], a[1] - center[1]);
    if !(min_r..=140.0).contains(&r) {
        return None;
    }
    for p in pts {
        let d = hypot(p[0] - center[0], p[1] - center[1]);
        if (d - r).abs() > tol {
            return None;
        }
    }
    let a0 = (a[1] - center[1]).atan2(a[0] - center[0]);
    let am = (mid[1] - center[1]).atan2(mid[0] - center[0]);
    let a1 = (c[1] - center[1]).atan2(c[0] - center[0]);
    let cw = sweep(a0, am) < 0.0;
    let mut prev = a0;
    for p in pts.iter().skip(1) {
        let ang = (p[1] - center[1]).atan2(p[0] - center[0]);
        let step = sweep(prev, ang);
        if cw && step > 0.05 {
            return None;
        }
        if !cw && step < -0.05 {
            return None;
        }
        prev = ang;
    }
    let total = sweep(a0, a1);
    if cw && total >= -0.15 {
        return None;
    }
    if !cw && total <= 0.15 {
        return None;
    }
    if (a1 - am).abs() < 1e-6 {
        return None;
    }
    let length = r * total.abs();
    let chord = hypot(c[0] - a[0], c[1] - a[1]);
    if length < chord + 1e-4 {
        return None;
    }
    let tangent = if cw {
        [a[1] - center[1], center[0] - a[0]]
    } else {
        [center[1] - a[1], a[0] - center[0]]
    };
    let exit_dir = if cw {
        [c[1] - center[1], center[0] - c[0]]
    } else {
        [center[1] - c[1], c[0] - center[0]]
    };
    Some(ArcFit {
        end: c,
        ij: [center[0] - a[0], center[1] - a[1]],
        cw,
        length,
        dir: tangent,
        exit_dir,
    })
}

fn sweep(from: f64, to: f64) -> f64 {
    let mut d = to - from;
    while d > std::f64::consts::PI {
        d -= std::f64::consts::TAU;
    }
    while d < -std::f64::consts::PI {
        d += std::f64::consts::TAU;
    }
    d
}

fn circumcenter(a: [f64; 2], b: [f64; 2], c: [f64; 2]) -> Option<[f64; 2]> {
    let d = 2.0 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
    if d.abs() < 1e-8 {
        return None;
    }
    let a2 = a[0] * a[0] + a[1] * a[1];
    let b2 = b[0] * b[0] + b[1] * b[1];
    let c2 = c[0] * c[0] + c[1] * c[1];
    Some([
        (a2 * (b[1] - c[1]) + b2 * (c[1] - a[1]) + c2 * (a[1] - b[1])) / d,
        (a2 * (c[0] - b[0]) + b2 * (a[0] - c[0]) + c2 * (b[0] - a[0])) / d,
    ])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kin(dist: f64, cruise: f64, accel: f64, dir: [f64; 2]) -> KinMove {
        KinMove {
            dist,
            cruise,
            accel,
            entry_dir: dir,
            exit_dir: dir,
            kind: "wall".into(),
        }
    }

    fn chain_time(moves: &[KinMove], jd: f64) -> f64 {
        plan_lookahead(moves, jd).iter().sum()
    }

    #[test]
    fn straight_short_segments_carry_speed() {
        let moves: Vec<_> = (0..10)
            .map(|_| kin(2.0, 100.0, 1000.0, [1.0, 0.0]))
            .collect();
        let carried = chain_time(&moves, 0.02);
        let stopped: f64 = moves
            .iter()
            .map(|m| move_time(m.dist, 0.0, 0.0, m.cruise, m.accel))
            .sum();
        let one = move_time(20.0, 0.0, 0.0, 100.0, 1000.0);
        assert!((carried - one).abs() < 0.02, "carried {carried} one {one}");
        assert!(
            carried < stopped * 0.5,
            "carried {carried} stopped {stopped}"
        );
    }

    #[test]
    fn corner_is_slower_than_straight_and_faster_than_a_stop() {
        let straight = [
            kin(40.0, 80.0, 2000.0, [1.0, 0.0]),
            kin(40.0, 80.0, 2000.0, [1.0, 0.0]),
        ];
        let corner = [
            kin(40.0, 80.0, 2000.0, [1.0, 0.0]),
            kin(40.0, 80.0, 2000.0, [0.0, 1.0]),
        ];
        let reverse = [
            kin(40.0, 80.0, 2000.0, [1.0, 0.0]),
            kin(40.0, 80.0, 2000.0, [-1.0, 0.0]),
        ];
        let t_straight = chain_time(&straight, 0.02);
        let t_corner = chain_time(&corner, 0.02);
        let t_reverse = chain_time(&reverse, 0.02);
        let t_stop = move_time(40.0, 0.0, 0.0, 80.0, 2000.0) * 2.0;
        assert!(t_straight < t_corner, "{t_straight} vs {t_corner}");
        assert!(t_corner < t_reverse, "{t_corner} vs {t_reverse}");
        assert!((t_reverse - t_stop).abs() < 1e-6, "{t_reverse} vs {t_stop}");
        let v = klipper_junction(&corner[0], &corner[1], 0.02);
        assert!(v > 5.0 && v < 80.0, "junction {v}");
    }

    #[test]
    fn zero_junction_deviation_stops_the_corner() {
        let corner = [
            kin(30.0, 100.0, 3000.0, [1.0, 0.0]),
            kin(30.0, 100.0, 3000.0, [0.0, 1.0]),
        ];
        assert!(klipper_junction(&corner[0], &corner[1], 0.0) < 1e-6);
    }

    #[test]
    fn volumetric_cap_still_limits_cruise() {
        let capped = limit_speed(200.0, 0.45, 0.2, 1.0, 12.0);
        assert!((capped - 12.0 / (0.45 * 0.2)).abs() < 1e-6);
        assert!(capped < 200.0);
    }

    #[test]
    fn arc_exit_tangent_is_not_the_start_tangent() {
        let mut pts = Vec::new();
        for i in 0..=8 {
            let a = std::f64::consts::FRAC_PI_2 * (i as f64) / 8.0;
            pts.push([a.cos() * 10.0, a.sin() * 10.0]);
        }
        let arc = fit_arc(&pts, 0.05, 0.8).expect("quarter circle");
        let dot = arc.dir[0] * arc.exit_dir[0] + arc.dir[1] * arc.exit_dir[1];
        let n0 = hypot(arc.dir[0], arc.dir[1]);
        let n1 = hypot(arc.exit_dir[0], arc.exit_dir[1]);
        let cos = dot / (n0 * n1);
        assert!(
            cos.abs() < 0.2,
            "start and end tangents of a quarter circle, cos {cos}"
        );
    }
}
