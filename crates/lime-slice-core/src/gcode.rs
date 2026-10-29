use std::collections::BTreeMap;
use std::fmt::Write;
use std::ops::Range;
use std::sync::{Arc, Mutex, OnceLock};

use rayon::prelude::*;

use crate::progress::{Stage, Watch};
use crate::strategy::{fan_pwm, BlendMode, Firmware, PrinterProfile};
use crate::toolpath::{Extrusion, FanRole, PathKind};

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
    /// The factor each emitted layer's extrusion feeds were scaled by to reach
    /// the minimum layer time, in layer order. Empty when no layer was slowed.
    pub layer_slow: Vec<f64>,
    pub cancelled: bool,
}

#[derive(Clone, Debug)]
pub struct FeatureStat {
    pub kind: String,
    pub seconds: f64,
    pub filament_mm: f64,
}

/// A planned layer as the G-code writer takes it. Its arc fit is kept
/// beside it, so every emit of the same layer plans its arcs once.
#[derive(Clone)]
pub(crate) struct PrintLayer {
    layer: Arc<LayerPaths>,
    arcs: Arc<Arcs>,
}

impl PrintLayer {
    pub(crate) fn new(layer: LayerPaths) -> Self {
        Self {
            layer: Arc::new(layer),
            arcs: Arc::default(),
        }
    }

    /// Replace the layer's paths, and the arcs planned for the old ones.
    pub(crate) fn set_paths(&mut self, paths: Vec<Extrusion>) {
        Arc::make_mut(&mut self.layer).paths = paths;
        self.arcs = Arc::default();
    }

    /// Change the layer, and forget the arcs planned for the old one.
    pub(crate) fn edit(&mut self, change: impl FnOnce(&mut LayerPaths)) {
        change(Arc::make_mut(&mut self.layer));
        self.arcs = Arc::default();
    }

    /// Both are the same layer, shared or equal path for path.
    pub(crate) fn same(&self, other: &PrintLayer) -> bool {
        Arc::ptr_eq(&self.layer, &other.layer) || *self.layer == *other.layer
    }

    /// The runs of one object layer share this path list.
    pub(crate) fn shares_paths(&self, other: &PrintLayer) -> bool {
        Arc::ptr_eq(&self.layer, &other.layer)
    }

    fn script(&self, arc_fit: bool) -> Arc<Vec<Vec<Span>>> {
        let slot = if arc_fit {
            &self.arcs.fitted
        } else {
            &self.arcs.lines
        };
        Arc::clone(slot.get_or_init(|| {
            Arc::new(if self.layer.paths.is_empty() {
                Vec::new()
            } else {
                chain_scripts(&self.layer, arc_fit)
            })
        }))
    }
}

impl std::ops::Deref for PrintLayer {
    type Target = LayerPaths;

    fn deref(&self) -> &LayerPaths {
        &self.layer
    }
}

/// One printed layer of a plate: runs of the objects' own joined layers, each
/// in its object's part frame. A layer with no run prints nothing.
#[derive(Clone)]
pub(crate) struct PlateLayer {
    pub index: usize,
    /// The layer's place in its own object's stack. It is `index` unless the
    /// plate prints one object at a time, where each object starts at 0 and
    /// its first layer gets the first-layer speed, flow and fan.
    pub own: usize,
    /// On a plate printed one object at a time, the first layer of every
    /// object after the first: the height in mm the nozzle climbs to, above
    /// every object already printed, before it travels to this one.
    pub clear_z: Option<f64>,
    pub z: f64,
    pub height: f64,
    pub note: String,
    pub runs: Vec<Run>,
    /// Added to the belt position before the direction sign. Zero on a cartesian layer.
    pub belt_shift: f64,
    /// Scales the feed of every extrusion on the layer, down to the minimum-layer
    /// floor. `1` leaves the planned feeds. Set at emit, never by the planner.
    pub slow: f64,
    /// Pause, filament change, or custom lines emitted after this layer's Z move.
    /// Empty on every planned layer, so a slice that asks for none is unchanged.
    pub actions: Vec<LayerCue>,
}

/// One line written at a layer transition, with an optional comment before it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct LayerCue {
    pub line: String,
    pub note: Option<String>,
}

/// A stretch of one object's joined layer: its head (skirt and supports) or
/// its part. The layer is shared with the object's plan, arcs and all.
#[derive(Clone)]
pub(crate) struct Run {
    pub object: u16,
    pub layer: PrintLayer,
    pub paths: Range<usize>,
    pub entry: Entry,
    /// Written as `;OBJECT:<label>` before the run.
    pub label: Option<Arc<str>>,
}

/// How the nozzle reaches a run's first path.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum Entry {
    /// The run before is the same object's, so the nozzle stands where that
    /// object's plan left it and the planned travel holds.
    AsPlanned,
    /// The run before is another object's: a straight travel that retracts,
    /// and hops `z_hop` millimetres when that is not zero.
    Cross { z_hop: f64 },
}

impl PlateLayer {
    /// One object's layer as the whole plate layer.
    #[cfg(test)]
    pub(crate) fn single(layer: PrintLayer) -> Self {
        let runs = if layer.paths.is_empty() {
            Vec::new()
        } else {
            vec![Run {
                object: 0,
                paths: 0..layer.paths.len(),
                layer: layer.clone(),
                entry: Entry::AsPlanned,
                label: None,
            }]
        };
        Self {
            index: layer.index,
            own: layer.index,
            clear_z: None,
            z: layer.z,
            height: layer.height,
            note: layer.note.clone(),
            runs,
            belt_shift: 0.0,
            slow: 1.0,
            actions: Vec::new(),
        }
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.runs.is_empty()
    }

    /// Every path in print order, with the object it belongs to.
    pub(crate) fn paths(&self) -> impl Iterator<Item = (u16, &Extrusion)> + '_ {
        self.runs
            .iter()
            .flat_map(|r| r.layer.paths[r.paths.clone()].iter().map(|p| (r.object, p)))
    }

    /// The same runs of the same object layers, entered the same way.
    pub(crate) fn same(&self, other: &PlateLayer) -> bool {
        self.runs.len() == other.runs.len()
            && self.runs.iter().zip(&other.runs).all(|(a, b)| {
                a.object == b.object
                    && a.paths == b.paths
                    && std::mem::discriminant(&a.entry) == std::mem::discriminant(&b.entry)
                    && a.label == b.label
                    && a.layer.same(&b.layer)
            })
    }
}

impl Run {
    /// Index of the run's first arc script: one script per path of two or
    /// more points, as `chain_scripts` plans them.
    fn first_script(&self) -> usize {
        self.layer.paths[..self.paths.start]
            .iter()
            .filter(|p| p.points.len() >= 2)
            .count()
    }
}

/// One layer's arc plan, with arc fitting on and off. Neither depends on
/// the printer, so it lasts as long as the layer's paths.
#[derive(Default)]
struct Arcs {
    fitted: OnceLock<Arc<Vec<Vec<Span>>>>,
    lines: OnceLock<Arc<Vec<Vec<Span>>>>,
}

/// A slice's G-code text, formatted the first time it is read. The scan
/// that found the print's totals left the machine state at each layer, so
/// the text formats each layer on its own, as a whole emit does.
#[derive(Clone)]
pub struct GcodeText(Arc<Mutex<Body>>);

enum Body {
    Ready(String),
    Later(Box<Formatter>),
}

impl GcodeText {
    /// Text that is already formatted.
    pub fn ready(text: String) -> Self {
        Self(Arc::new(Mutex::new(Body::Ready(text))))
    }

    /// The text, formatted now if no read did yet.
    pub fn text(&self) -> String {
        self.with_text(str::to_owned)
    }

    /// `read` on the text, formatted now if no read did yet, without a copy.
    /// Other reads wait until it returns.
    pub fn with_text<R>(&self, read: impl FnOnce(&str) -> R) -> R {
        let mut body = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if let Body::Later(formatter) = &*body {
            *body = Body::Ready(formatter.format());
        }
        match &*body {
            Body::Ready(text) => read(text),
            Body::Later(_) => unreachable!("formatted above"),
        }
    }
}

impl std::fmt::Debug for GcodeText {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("GcodeText")
    }
}

/// What formatting the text needs once the scan is done.
struct Formatter {
    cfg: EmitCfg,
    layers: Vec<PlateLayer>,
    seeds: Vec<Seed>,
    preamble: String,
    epilogue: String,
}

impl Formatter {
    fn format(&self) -> String {
        let bodies: Vec<String> = self
            .seeds
            .par_iter()
            .map(|seed| {
                let layer = &self.layers[seed.index];
                let mut layer_w = Writer::blank(&self.cfg, seed.carry, true);
                let points: usize = layer
                    .paths()
                    .map(|(_, path)| path.points.len() + path.lead_in.len())
                    .sum();
                layer_w
                    .out
                    .reserve(points.saturating_mul(48).saturating_add(128));
                layer_w.scripted = true;
                layer_w.write_layer(layer);
                layer_w.out
            })
            .collect();
        let extra: usize = bodies.iter().map(String::len).sum::<usize>() + self.epilogue.len();
        let mut text = String::with_capacity(self.preamble.len() + extra);
        text.push_str(&self.preamble);
        for body in &bodies {
            text.push_str(body);
        }
        text.push_str(&self.epilogue);
        text
    }
}

/// Retract length and speed for emit. `None` keeps the planned length and 30 mm/s.
#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct RetractEmit {
    pub length_mm: Option<f64>,
    pub speed_mm_s: Option<f64>,
}

/// No layer prints in less than `time_s`: a layer that would is slowed, all its
/// extrusion feeds scaled by one factor, none taken below `floor_mm_s`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct MinLayer {
    pub time_s: f64,
    pub floor_mm_s: f64,
}

impl MinLayer {
    /// The slowest a slowed layer prints when the request names none.
    pub(crate) const DEFAULT_FLOOR_MM_S: f64 = 15.0;
}

/// When the G-code text is formatted.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Text {
    /// Into `GcodeStats.text`.
    Now,
    /// When the returned `GcodeText` is read.
    Later,
    /// Never: only the totals are wanted.
    Never,
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn emit_gcode(
    layers: &[PlateLayer],
    profile: &PrinterProfile,
    blend: &BlendMode,
    layer_height: f64,
    line_width: f64,
    features: &str,
    arc_fit: bool,
    classic_estimator: bool,
    junction_deviation_mm: f64,
    offsets: &[[f64; 2]],
    belt: Option<&crate::belt::Belt>,
    flow: f64,
    retract: RetractEmit,
    min_layer: Option<MinLayer>,
    job: crate::cancel::Job,
    watch: &Watch,
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
        offsets,
        belt,
        flow,
        retract,
        min_layer,
        job,
        watch,
        true,
        Text::Now,
    )
    .0
}

/// Print-time totals without the G-code text. The quiet scan is what the
/// totals come from; formatting is only for the string the caller keeps.
#[allow(clippy::too_many_arguments)]
pub(crate) fn emit_estimates(
    layers: &[PlateLayer],
    profile: &PrinterProfile,
    blend: &BlendMode,
    layer_height: f64,
    line_width: f64,
    features: &str,
    arc_fit: bool,
    classic_estimator: bool,
    junction_deviation_mm: f64,
    offsets: &[[f64; 2]],
    belt: Option<&crate::belt::Belt>,
    flow: f64,
    retract: RetractEmit,
    min_layer: Option<MinLayer>,
    job: crate::cancel::Job,
    watch: &Watch,
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
        offsets,
        belt,
        flow,
        retract,
        min_layer,
        job,
        watch,
        true,
        Text::Never,
    )
    .0
}

/// The totals now and the text when it is first read: the same bytes
/// `emit_gcode` writes.
#[allow(clippy::too_many_arguments)]
pub(crate) fn emit_later(
    layers: &[PlateLayer],
    profile: &PrinterProfile,
    blend: &BlendMode,
    layer_height: f64,
    line_width: f64,
    features: &str,
    arc_fit: bool,
    classic_estimator: bool,
    junction_deviation_mm: f64,
    offsets: &[[f64; 2]],
    belt: Option<&crate::belt::Belt>,
    flow: f64,
    retract: RetractEmit,
    min_layer: Option<MinLayer>,
    job: crate::cancel::Job,
    watch: &Watch,
) -> (GcodeStats, GcodeText) {
    let (stats, text) = emit_gcode_inner(
        layers,
        profile,
        blend,
        layer_height,
        line_width,
        features,
        arc_fit,
        classic_estimator,
        junction_deviation_mm,
        offsets,
        belt,
        flow,
        retract,
        min_layer,
        job,
        watch,
        true,
        Text::Later,
    );
    (
        stats,
        text.unwrap_or_else(|| GcodeText::ready(String::new())),
    )
}

/// Single-writer emit. Tests use it to prove the parallel reduce is the same G-code.
#[cfg(test)]
#[allow(clippy::too_many_arguments)]
pub(crate) fn emit_gcode_linear(
    layers: &[PlateLayer],
    profile: &PrinterProfile,
    blend: &BlendMode,
    layer_height: f64,
    line_width: f64,
    features: &str,
    arc_fit: bool,
    classic_estimator: bool,
    junction_deviation_mm: f64,
    offsets: &[[f64; 2]],
    belt: Option<&crate::belt::Belt>,
    flow: f64,
    retract: RetractEmit,
    min_layer: Option<MinLayer>,
    job: crate::cancel::Job,
    watch: &Watch,
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
        offsets,
        belt,
        flow,
        retract,
        min_layer,
        job,
        watch,
        false,
        Text::Now,
    )
    .0
}

#[allow(clippy::too_many_arguments)]
fn emit_gcode_inner(
    layers: &[PlateLayer],
    profile: &PrinterProfile,
    blend: &BlendMode,
    layer_height: f64,
    line_width: f64,
    features: &str,
    arc_fit: bool,
    classic_estimator: bool,
    junction_deviation_mm: f64,
    offsets: &[[f64; 2]],
    belt: Option<&crate::belt::Belt>,
    flow: f64,
    retract: RetractEmit,
    min_layer: Option<MinLayer>,
    job: crate::cancel::Job,
    watch: &Watch,
    parallel: bool,
    text: Text,
) -> (GcodeStats, Option<GcodeText>) {
    let cfg = EmitCfg::new(
        profile,
        arc_fit,
        classic_estimator,
        junction_deviation_mm,
        offsets,
        belt,
        flow,
        retract,
        min_layer,
    );
    let junction_deviation = cfg.junction_deviation;
    let slowed;
    let layers = match cfg.min_layer {
        Some(min) => {
            slowed = slowed_layers(&cfg, layers, min);
            slowed.as_slice()
        }
        None => layers,
    };
    let layer_slow = emitted_slow(layers);
    let emit_total = layers
        .iter()
        .filter(|layer| !layer.is_empty())
        .count()
        .max(1) as u32;
    watch.begin(Stage::Emit, emit_total);
    if !parallel {
        let mut w = Writer::blank(&cfg, Carry::initial(&cfg), false);
        write_preamble(
            &mut w.out,
            profile,
            blend,
            layer_height,
            line_width,
            features,
            cfg.arc_note,
            classic_estimator,
            junction_deviation,
            cfg.klipper.as_ref(),
            belt,
        );
        let mut emitted_layers = 0usize;
        for layer in layers {
            if watch.stopped(job) {
                w.cancelled = true;
                break;
            }
            if layer.is_empty() {
                continue;
            }
            w.write_layer(layer);
            emitted_layers += 1;
            watch.tick();
        }
        if !w.cancelled {
            watch.fill();
        }
        w.finish(profile);
        let mut stats = w.stats(emitted_layers, profile);
        stats.layer_slow = layer_slow;
        return (stats, None);
    }

    // Arc choices do not depend on machine state, so they are planned once per
    // object layer and kept with it. A quiet scan then replays them to carry E,
    // fan, accel, and pressure advance across layers. Formatting replays the
    // same arcs into one string per layer and the strings are joined in layer
    // index order. Lookahead stays on the quiet scan: it already stops at each
    // layer, and that pass is what the print-time totals come from.
    layers.par_iter().for_each(|layer| {
        for run in &layer.runs {
            run.layer.script(cfg.arc_fit);
        }
    });
    let mut w = Writer::blank(&cfg, Carry::initial(&cfg), false);
    w.quiet = true;
    let mut seeds = Vec::new();
    let mut emitted_layers = 0usize;
    match scan_layers(&cfg, layers, job, watch) {
        Some(scans) => {
            for scan in scans {
                if watch.stopped(job) {
                    w.cancelled = true;
                    break;
                }
                seeds.push(Seed {
                    index: scan.index,
                    carry: Carry {
                        e: w.e,
                        ..scan.entry
                    },
                });
                w.take_scan(scan);
                emitted_layers += 1;
                watch.tick();
            }
        }
        None => {
            for (index, layer) in layers.iter().enumerate() {
                if watch.stopped(job) {
                    w.cancelled = true;
                    break;
                }
                if layer.is_empty() {
                    continue;
                }
                seeds.push(Seed {
                    index,
                    carry: w.carry(),
                });
                w.scripted = true;
                w.write_layer(layer);
                emitted_layers += 1;
                watch.tick();
            }
        }
    }
    if watch.stopped(job) {
        w.cancelled = true;
    } else {
        watch.fill();
    }
    if text == Text::Never {
        w.finish(profile);
        let mut stats = w.stats(emitted_layers, profile);
        stats.layer_slow = layer_slow;
        return (stats, None);
    }
    w.quiet = false;
    w.out.clear();
    w.finish(profile);
    let epilogue = std::mem::take(&mut w.out);
    let cancelled = w.cancelled;
    let mut stats = w.stats(emitted_layers, profile);
    stats.layer_slow = layer_slow;
    let mut preamble = String::new();
    write_preamble(
        &mut preamble,
        profile,
        blend,
        layer_height,
        line_width,
        features,
        cfg.arc_note,
        classic_estimator,
        junction_deviation,
        cfg.klipper.as_ref(),
        belt,
    );
    let formatter = Formatter {
        cfg,
        layers: layers.to_vec(),
        seeds,
        preamble,
        epilogue,
    };
    if text == Text::Now {
        if !cancelled {
            stats.text = formatter.format();
        }
        return (stats, None);
    }
    let later = GcodeText(Arc::new(Mutex::new(Body::Later(Box::new(formatter)))));
    (stats, Some(later))
}

/// Every emitted layer's slowdown factor, or none when the plate has no slowed layer.
fn emitted_slow(layers: &[PlateLayer]) -> Vec<f64> {
    if layers.iter().all(|l| l.slow >= 1.0) {
        return Vec::new();
    }
    layers
        .iter()
        .filter(|l| !l.is_empty())
        .map(|l| l.slow)
        .collect()
}

/// The feed a path prints at before any slowdown: the first layer never goes over 30 mm/s.
fn planned_feed(layer: &PlateLayer, path: &Extrusion) -> f64 {
    if layer.own == 0 {
        path.speed.min(30.0)
    } else {
        path.speed
    }
}

/// `layers` with the slowdown each needs so that none prints in less than
/// `min.time_s`. A layer is timed the way its scan times it, from where the
/// layer below leaves the machine; the factor does not move that state, so a
/// layer that clearly takes long enough is not timed at all.
fn slowed_layers(cfg: &EmitCfg, layers: &[PlateLayer], min: MinLayer) -> Vec<PlateLayer> {
    let order: Vec<usize> = (0..layers.len())
        .filter(|&i| !layers[i].is_empty())
        .collect();
    let initial = Carry::initial(cfg);
    let factors: Vec<f64> = order
        .par_iter()
        .enumerate()
        .map(|(k, &i)| {
            let layer = &layers[i];
            // Even at full feed along its paths alone, a layer this long is done.
            let at_feed: f64 = layer
                .paths()
                .filter(|(_, p)| p.points.len() >= 2)
                .map(|(_, p)| path_length(&p.points) / planned_feed(layer, p).max(1.0))
                .sum();
            if at_feed >= min.time_s {
                return 1.0;
            }
            let entry = if k == 0 {
                initial
            } else {
                let below = scan_layer(cfg, initial, &layers[order[k - 1]], false).carry();
                Carry { e: 0.0, ..below }
            };
            slow_factor(cfg, entry, layer, min)
        })
        .collect();
    let mut slowed = layers.to_vec();
    for (&i, &factor) in order.iter().zip(&factors) {
        slowed[i].slow = factor;
    }
    slowed
}

fn path_length(points: &[[f64; 2]]) -> f64 {
    points
        .windows(2)
        .map(|w| hypot(w[1][0] - w[0][0], w[1][1] - w[0][1]))
        .sum()
}

/// The largest factor in `(0, 1]` at which the layer, entered from `entry`,
/// takes `min.time_s`, or the one that prints everything at the floor when
/// even that is short. The layer's time only grows as the factor falls, and
/// is close to a line in its inverse, so a false-position search lands within
/// 1% in a few timings.
fn slow_factor(cfg: &EmitCfg, entry: Carry, layer: &PlateLayer, min: MinLayer) -> f64 {
    let fastest = layer
        .paths()
        .filter(|(_, p)| p.points.len() >= 2)
        .map(|(_, p)| planned_feed(layer, p))
        .fold(0.0, f64::max);
    if fastest <= min.floor_mm_s {
        return 1.0;
    }
    let time_at = |factor: f64| {
        let mut trial = layer.clone();
        trial.slow = factor;
        let mut w = Writer::blank(cfg, entry, false);
        w.quiet = true;
        w.scripted = true;
        w.write_layer(&trial);
        w.layer_seconds.last().copied().unwrap_or(0.0)
    };
    let target = min.time_s;
    let full = time_at(1.0);
    if full >= target {
        return 1.0;
    }
    let floor_factor = min.floor_mm_s / fastest;
    let floored = time_at(floor_factor);
    if floored <= target {
        return floor_factor;
    }
    // Illinois false position on x = 1 / factor, bracketing the target.
    let (mut x_lo, mut g_lo) = (1.0, full - target);
    let (mut x_hi, mut g_hi) = (1.0 / floor_factor, floored - target);
    let mut last_hi = None;
    for _ in 0..16 {
        let x = x_hi - g_hi * (x_hi - x_lo) / (g_hi - g_lo);
        let g = time_at(1.0 / x) - target;
        if g >= 0.0 {
            (x_hi, g_hi) = (x, g);
            if last_hi == Some(true) {
                g_lo *= 0.5;
            }
            last_hi = Some(true);
            if g <= target * 0.01 {
                break;
            }
        } else {
            (x_lo, g_lo) = (x, g);
            if last_hi == Some(false) {
                g_hi *= 0.5;
            }
            last_hi = Some(false);
        }
    }
    1.0 / x_hi
}

#[derive(Clone)]
struct EmitCfg {
    classic_estimator: bool,
    junction_deviation: f64,
    arc_fit: bool,
    /// Appended to the header's features line. See `arc_note`.
    arc_note: &'static str,
    max_accel: f64,
    max_volumetric_mm3_s: f64,
    filament_diameter: f64,
    pa_base: f64,
    la_base: f64,
    emit_pa: bool,
    /// Each object's part frame's place on the bed, added to every X/Y
    /// written in that frame.
    offsets: Arc<[[f64; 2]]>,
    /// Set for a belt slice. Cartesian emit leaves this empty and writes
    /// the same bytes it wrote before belt existed.
    belt: Option<crate::belt::Belt>,
    /// Multiplies every extrusion. `1` leaves the filament length unchanged.
    flow_scale: f64,
    /// `None` keeps each path's planned retract length.
    retract_length: Option<f64>,
    /// Retract feed. 30 mm/s is `F1800`, the feed a slice had before this existed.
    retract_speed: f64,
    /// `None` keeps every layer at its planned feeds.
    min_layer: Option<MinLayer>,
    /// Set for a Klipper printer: the toolhead model times the print.
    klipper: Option<KlipperCfg>,
    /// The printer's part fan, set at emit so a fan change never re-plans.
    fans: Fans,
}

/// The fan values a request names, as PWM. `None` leaves each bead at the
/// fan it was planned with.
#[derive(Clone, Copy, Default)]
struct Fans {
    part: Option<u8>,
    overhang: Option<u8>,
    support: Option<u8>,
    /// Layers below this print with the fan off. `None` keeps the first
    /// layer off and the second at half.
    off_layers: Option<usize>,
}

impl Fans {
    fn of(profile: &PrinterProfile) -> Self {
        Self {
            part: profile.fan_percent.map(fan_pwm),
            overhang: profile.overhang_fan_percent.map(fan_pwm),
            support: profile.support_fan_percent.map(fan_pwm),
            off_layers: profile.fan_off_layers.map(|n| n as usize),
        }
    }

    /// The PWM a bead runs at once its layer's fan is on.
    fn pwm(&self, path: &Extrusion) -> u8 {
        if path.fan_hold {
            return path.fan;
        }
        let named = match path.fan_role {
            FanRole::Part => self.part,
            FanRole::Overhang { boost } => self.overhang.or(self.part.map(|p| p.max(boost))),
            FanRole::Gap => self.overhang.or(self.part),
            FanRole::Support => self.support.or(self.part),
            FanRole::Off => None,
        };
        named.unwrap_or(path.fan)
    }
}

impl EmitCfg {
    #[allow(clippy::too_many_arguments)]
    fn new(
        profile: &PrinterProfile,
        arc_fit: bool,
        classic_estimator: bool,
        junction_deviation_mm: f64,
        offsets: &[[f64; 2]],
        belt: Option<&crate::belt::Belt>,
        flow: f64,
        retract: RetractEmit,
        min_layer: Option<MinLayer>,
    ) -> Self {
        let offsets = if offsets.is_empty() {
            Arc::from([[0.0, 0.0]])
        } else {
            Arc::from(offsets)
        };
        let junction_deviation = if junction_deviation_mm.is_finite() && junction_deviation_mm > 0.0
        {
            junction_deviation_mm
        } else {
            DEFAULT_JUNCTION_DEVIATION_MM
        };
        // G2/G3 are arcs in the machine XY plane. That plane is the nozzle
        // plane only when the belt is Z. Any other belt axis prints lines.
        let plane = !matches!(
            belt.map(|b| b.axis),
            Some(crate::belt::BeltAxis::X | crate::belt::BeltAxis::Y)
        );
        // The one gate: a firmware that skips G2/G3 gets none, whatever the
        // request's `arcFit` says. Every emit path builds its config here.
        let takes_arcs = profile.accepts_arcs();
        let arc_note = arc_note(profile.firmware_arcs.is_some(), arc_fit, takes_arcs, plane);
        let arc_fit = arc_fit && takes_arcs && plane;
        Self {
            classic_estimator,
            junction_deviation,
            arc_fit,
            arc_note,
            max_accel: profile.max_accel,
            max_volumetric_mm3_s: profile.max_volumetric_mm3_s,
            filament_diameter: profile.filament_diameter,
            pa_base: profile.pressure_advance.max(0.0),
            la_base: profile.linear_advance.max(0.0),
            emit_pa: profile.pressure_advance > 0.0 || profile.linear_advance > 0.0,
            offsets,
            belt: belt.copied(),
            flow_scale: flow_scale(flow),
            retract_length: retract.length_mm.filter(|n| n.is_finite()),
            retract_speed: retract
                .speed_mm_s
                .filter(|n| n.is_finite() && *n > 0.0)
                .unwrap_or(30.0),
            min_layer: min_layer.filter(|m| m.time_s.is_finite() && m.time_s > 0.0),
            klipper: (profile.firmware == Some(Firmware::Klipper) && !classic_estimator)
                .then(|| KlipperCfg::new(profile)),
            fans: Fans::of(profile),
        }
    }
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
    /// The object whose part frame `x` and `y` are in.
    frame: u16,
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
            frame: 0,
        }
    }
}

impl Carry {
    /// Everything but E, bit for bit. A layer's scan depends on these and
    /// only adds to E.
    fn same_but_e(&self, other: &Carry) -> bool {
        let bits = |c: &Carry| {
            (
                [c.x, c.y, c.z, c.retracted, c.accel, c.pa_cur, c.la_cur].map(f64::to_bits),
                c.has_pos,
                c.fan,
                c.frame,
            )
        };
        bits(self) == bits(other)
    }
}

struct Seed {
    index: usize,
    carry: Carry,
}

/// Every float a layer's scan adds to a running total, in the order it adds
/// them, so the totals can be summed in layer order afterwards with the
/// same rounding as one serial scan.
#[derive(Default)]
struct ScanLog {
    e: Vec<f64>,
    time: Vec<f64>,
    /// `(first index into time, kind)` for each run of one kind.
    time_kinds: Vec<(usize, &'static str)>,
    filament: Vec<f64>,
    filament_kinds: Vec<(usize, &'static str)>,
    extruded: Vec<f64>,
    travelled: Vec<f64>,
    /// Entries of `time` added before the layer's time starts counting.
    mark: usize,
}

impl ScanLog {
    fn time(&mut self, kind: &'static str, dt: f64) {
        if self.time_kinds.last().is_none_or(|k| k.1 != kind) {
            self.time_kinds.push((self.time.len(), kind));
        }
        self.time.push(dt);
    }

    fn filament(&mut self, kind: &'static str, mm: f64) {
        if self.filament_kinds.last().is_none_or(|k| k.1 != kind) {
            self.filament_kinds.push((self.filament.len(), kind));
        }
        self.filament.push(mm);
    }
}

/// One emitted layer scanned on its own.
struct LayerScan {
    index: usize,
    entry: Carry,
    exit: Carry,
    log: ScanLog,
    extrusion_moves: usize,
    travel_moves: usize,
    arc_moves: usize,
    retracts: usize,
    z_hops: usize,
    bounds: Option<[f64; 4]>,
}

/// One layer scanned from `entry`. Without `log` the scan only finds where
/// the layer leaves the machine, which does not depend on timing, so it
/// skips lookahead and the totals.
fn scan_layer(cfg: &EmitCfg, entry: Carry, layer: &PlateLayer, log: bool) -> Writer {
    let mut w = Writer::blank(cfg, entry, !log);
    w.quiet = true;
    w.log = log.then(Box::default);
    w.scripted = true;
    w.write_layer(layer);
    w
}

/// The quiet scan of every emitted layer, in parallel. A layer's scan needs
/// the machine state the layer below left, and that state never depends on
/// where the layer below began: each path sets accel, fan, and advance, and
/// a layer ends on its last move. So every layer is scanned once from the
/// initial state to learn where it leaves the machine, then again from
/// where the layer below left it, logging its sums. The second scans are
/// the real ones exactly when each ends where its first scan did; when one
/// does not, this returns `None` and the caller scans serially.
fn scan_layers(
    cfg: &EmitCfg,
    layers: &[PlateLayer],
    job: crate::cancel::Job,
    watch: &Watch,
) -> Option<Vec<LayerScan>> {
    let order: Vec<usize> = (0..layers.len())
        .filter(|&i| !layers[i].is_empty())
        .collect();
    let initial = Carry::initial(cfg);
    let exits: Vec<Carry> = order
        .par_iter()
        .map(|&i| scan_layer(cfg, initial, &layers[i], false).carry())
        .collect();
    if watch.stopped(job) {
        return None;
    }
    let scans: Vec<LayerScan> = order
        .par_iter()
        .enumerate()
        .map(|(k, &i)| {
            let entry = if k == 0 {
                initial
            } else {
                Carry {
                    e: 0.0,
                    ..exits[k - 1]
                }
            };
            let mut w = scan_layer(cfg, entry, &layers[i], true);
            LayerScan {
                index: i,
                entry,
                exit: w.carry(),
                log: *w.log.take().expect("a logged scan"),
                extrusion_moves: w.extrusion_moves,
                travel_moves: w.travel_moves,
                arc_moves: w.arc_moves,
                retracts: w.retracts,
                z_hops: w.z_hops,
                bounds: w
                    .bounds_init
                    .then_some([w.min_x, w.max_x, w.min_y, w.max_y]),
            }
        })
        .collect();
    let settled = scans.iter().zip(&exits).all(|(s, x)| s.exit.same_but_e(x));
    settled.then_some(scans)
}

/// Whether `emit_gcode` scans `layers` in parallel instead of falling back
/// to one serial scan.
#[cfg(test)]
pub(crate) fn scans_in_parallel(
    layers: &[PlateLayer],
    profile: &PrinterProfile,
    arc_fit: bool,
    classic_estimator: bool,
) -> bool {
    let cfg = EmitCfg::new(
        profile,
        arc_fit,
        classic_estimator,
        0.0,
        &[],
        None,
        1.0,
        RetractEmit::default(),
        None,
    );
    scan_layers(&cfg, layers, crate::cancel::Job::default(), &Watch::idle()).is_some()
}

/// Whether the file has arcs, for the header's features line. A request that
/// names the firmware's arcs, as the app's always does, is told either way. One
/// that names nothing keeps the header it had, unless its firmware turned arcs off.
fn arc_note(named: bool, asked: bool, takes_arcs: bool, plane: bool) -> &'static str {
    match (asked, takes_arcs, plane) {
        (true, false, _) => "; arcs off (firmware takes no G2/G3)",
        _ if !named => "",
        (true, true, true) => "; arcs on",
        (true, true, false) => "; arcs off (belt axis is not Z)",
        (false, _, _) => "; arcs off",
    }
}

/// The fan values a request names, for the header's features line. One that
/// names none keeps the header it had.
fn fan_note(profile: &PrinterProfile) -> String {
    let mut note = String::new();
    if let Some(pct) = profile.fan_percent.map(|pct| pct.min(100)) {
        let _ = write!(note, "; fan {pct}%");
    }
    if let Some(pct) = profile.overhang_fan_percent.map(|pct| pct.min(100)) {
        let _ = write!(note, "; overhang fan {pct}%");
    }
    if let Some(pct) = profile.support_fan_percent.map(|pct| pct.min(100)) {
        let _ = write!(note, "; support fan {pct}%");
    }
    match profile.fan_off_layers {
        Some(1) => note.push_str("; fan off for 1 layer"),
        Some(n) => {
            let _ = write!(note, "; fan off for {n} layers");
        }
        None => {}
    }
    note
}

#[allow(clippy::too_many_arguments)]
fn write_preamble(
    out: &mut String,
    profile: &PrinterProfile,
    blend: &BlendMode,
    layer_height: f64,
    line_width: f64,
    features: &str,
    arc_note: &str,
    classic_estimator: bool,
    junction_deviation: f64,
    klipper: Option<&KlipperCfg>,
    belt: Option<&crate::belt::Belt>,
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
    let fan_note = fan_note(profile);
    let _ = writeln!(out, "; features: {features}{arc_note}{fan_note}");
    let _ = writeln!(out, "M140 S{bed:.0}");
    let _ = writeln!(out, "M104 S{nozzle:.0}");
    let _ = writeln!(out, "M190 S{bed:.0}");
    let _ = writeln!(out, "M109 S{nozzle:.0}");
    if classic_estimator {
        out.push_str("; estimator: classic (stop at each segment end)\n");
    } else if let Some(k) = klipper {
        let _ = writeln!(
            out,
            "; estimator: klipper square_corner_velocity={:.1} minimum_cruise_ratio={:.2} extruder_corner_velocity={:.1}",
            k.square_corner_velocity, k.min_cruise_ratio, k.extruder_corner_v
        );
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
    if let Some(belt) = belt {
        out.push_str(&belt.comment());
    }
}

#[derive(Clone, PartialEq)]
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
    kind: &'static str,
    feature_s: BTreeMap<&'static str, f64>,
    feature_mm: BTreeMap<&'static str, f64>,
    layer_seconds: Vec<f64>,
    layer_mark: f64,
    layer_open: bool,
    cancelled: bool,
    /// Stop to zero at every segment end. Reproduces the pre-lookahead benches.
    classic_estimator: bool,
    /// Klipper junction deviation, millimetres. Ignored by the classic estimator.
    junction_deviation: f64,
    pending: Vec<KinMove>,
    /// Replay the arcs planned on each run's layer. Off means fit inline.
    scripted: bool,
    /// The current run's planned arcs, shared with the formatter.
    replay: Option<Arc<Vec<Vec<Span>>>>,
    replay_i: usize,
    /// Skip string writes. The carry scan uses this so formatting can run per layer.
    quiet: bool,
    /// Set on a layer scanned on its own: every addition to a running total.
    log: Option<Box<ScanLog>>,
    /// Skip lookahead and feature totals. Layer tasks only need the G-code text;
    /// the quiet scan already accumulated print time.
    strings_only: bool,
    arc_fit: bool,
    max_accel: f64,
    max_volumetric_mm3_s: f64,
    filament_diameter: f64,
    offsets: Arc<[[f64; 2]]>,
    /// The object whose part frame `x` and `y` are in, and its offset.
    frame: u16,
    offset: [f64; 2],
    belt: Option<crate::belt::Belt>,
    /// Slice Z of the layer being written. A belt's gantry coordinate needs it.
    slice_z: f64,
    flow_scale: f64,
    retract_length: Option<f64>,
    retract_speed: f64,
    retract_feed: i32,
    /// The layer being written: its slowdown factor and the feed it never goes under.
    slow: f64,
    slow_floor: f64,
    klipper: Option<KlipperCfg>,
    fans: Fans,
}

struct KinMove {
    dist: f64,
    cruise: f64,
    accel: f64,
    entry_dir: [f64; 2],
    exit_dir: [f64; 2],
    kind: &'static str,
    /// The Klipper model reads the next three. The generic estimator leaves them 0.
    /// Signed Z travel of the move, so a hop's slope is a 3D direction.
    dz: f64,
    /// Filament millimetres per millimetre of path.
    e_per_mm: f64,
    /// The `M204` acceleration in force, before any axis limit cut `accel`.
    m204: f64,
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
            kind: "travel",
            feature_s: BTreeMap::new(),
            feature_mm: BTreeMap::new(),
            layer_seconds: Vec::new(),
            layer_mark: 0.0,
            layer_open: false,
            cancelled: false,
            classic_estimator: cfg.classic_estimator,
            junction_deviation: cfg.junction_deviation,
            pending: Vec::new(),
            scripted: false,
            replay: None,
            replay_i: 0,
            quiet: false,
            log: None,
            strings_only,
            arc_fit: cfg.arc_fit,
            max_accel: cfg.max_accel,
            max_volumetric_mm3_s: cfg.max_volumetric_mm3_s,
            filament_diameter: cfg.filament_diameter,
            offsets: Arc::clone(&cfg.offsets),
            frame: carry.frame,
            offset: cfg.offsets[carry.frame as usize],
            belt: cfg.belt,
            slice_z: 0.0,
            flow_scale: cfg.flow_scale,
            retract_length: cfg.retract_length,
            retract_speed: cfg.retract_speed,
            retract_feed: (cfg.retract_speed * 60.0).round() as i32,
            slow: 1.0,
            slow_floor: cfg.min_layer.map_or(0.0, |m| m.floor_mm_s),
            klipper: cfg.klipper,
            fans: cfg.fans,
        }
    }

    /// Belt position of this layer, or the slice Z when this is not a belt.
    fn written_z(&self, layer: &PlateLayer) -> f64 {
        match self.belt {
            Some(belt) => belt.position(layer.z, layer.belt_shift),
            None => layer.z,
        }
    }

    /// The belt is not machine Z, so plane moves are not G-code XY.
    fn permutes(&self) -> bool {
        matches!(
            self.belt.map(|b| b.axis),
            Some(crate::belt::BeltAxis::X | crate::belt::BeltAxis::Y)
        )
    }

    /// A nozzle-plane move. `x` and `y` are across-belt and along-rail.
    fn put_permuted(&mut self, x: f64, y: f64, f: i32, e: Option<f64>) {
        let axis = self.belt.expect("permuted move").axis;
        match (axis, e) {
            (crate::belt::BeltAxis::Y, Some(e)) => {
                self.put(format_args!("G1 X{x:.3} Z{y:.3} E{e:.5} F{f}\n"))
            }
            (crate::belt::BeltAxis::Y, None) => self.put(format_args!("G1 X{x:.3} Z{y:.3} F{f}\n")),
            (crate::belt::BeltAxis::X, Some(e)) => {
                self.put(format_args!("G1 Y{x:.3} Z{y:.3} E{e:.5} F{f}\n"))
            }
            (crate::belt::BeltAxis::X, None) => self.put(format_args!("G1 Y{x:.3} Z{y:.3} F{f}\n")),
            (crate::belt::BeltAxis::Z, _) => unreachable!("Z belt keeps machine XY"),
        }
    }

    /// `[x, y]` in bed coordinates. A zero offset is not added, so a `-0.0`
    /// keeps its sign and the text its bytes. On a belt `y` is the gantry.
    fn bed(&self, x: f64, y: f64) -> [f64; 2] {
        let [x, y] = if self.offset == [0.0, 0.0] {
            [x, y]
        } else {
            [x + self.offset[0], y + self.offset[1]]
        };
        match self.belt {
            Some(belt) => [x, belt.gantry(y, self.slice_z)],
            None => [x, y],
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
            frame: self.frame,
        }
    }

    /// Stand in object `frame`'s part frame. The position moves with it, so
    /// it stays the same point on the bed.
    fn enter_frame(&mut self, frame: u16) {
        if frame == self.frame {
            return;
        }
        let to = self.offsets[frame as usize];
        if to != self.offset {
            self.x = self.x + self.offset[0] - to[0];
            self.y = self.y + self.offset[1] - to[1];
        }
        self.frame = frame;
        self.offset = to;
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

    /// Header, runs, then flush. The flush used to run at the next layer's
    /// header, before that layer's Z time, which is the same moment.
    fn write_layer(&mut self, layer: &PlateLayer) {
        self.slow = layer.slow;
        if let Some(clear) = layer.clear_z {
            self.clear_to(layer, clear);
        }
        self.layer_header(layer);
        for run in &layer.runs {
            self.enter_frame(run.object);
            if let Some(label) = &run.label {
                self.put(format_args!(";OBJECT:{label}\n"));
            }
            if self.scripted {
                self.replay = Some(run.layer.script(self.arc_fit));
                self.replay_i = run.first_script();
            }
            let mut entry = run.entry;
            for path in &run.layer.paths[run.paths.clone()] {
                self.write_path(layer, path, entry);
                if !path.points.is_empty() {
                    entry = Entry::AsPlanned;
                }
            }
        }
        self.close_layer();
    }

    /// Leave a finished object for the next one on a plate printed one object
    /// at a time: retract, climb to `clear`, travel to the next object's first
    /// point up there, and let the layer header bring the nozzle down. Going
    /// down first would drive it through the object it just finished.
    fn clear_to(&mut self, layer: &PlateLayer, clear: f64) {
        let first = layer.runs.iter().find_map(|r| {
            r.layer.paths[r.paths.clone()]
                .iter()
                .find(|p| !p.points.is_empty())
                .map(|p| (r.object, p))
        });
        let Some((object, path)) = first else {
            return;
        };
        if !self.has_pos {
            return;
        }
        let retract = self.retract_length.unwrap_or(path.retract_mm);
        if retract > 0.0 && self.retracted == 0.0 {
            self.flush_motion();
            self.add_e(-retract);
            self.retracted = retract;
            self.retracts += 1;
            let e_now = self.e;
            let retract_feed = self.retract_feed;
            self.put(format_args!("G1 E{e_now:.5} F{retract_feed}\n"));
            self.add_time(self.extruder_move_s(retract));
        }
        self.set_z(clear.max(self.z));
        self.enter_frame(object);
        self.set_accel(cap_accel(path.travel_accel, self.max_accel));
        let to = path.points[0];
        self.travel_dry(to[0], to[1], path.travel_speed, path.travel_accel);
    }

    fn write_path(&mut self, layer: &PlateLayer, path: &Extrusion, entry: Entry) {
        self.set_advance(path.kind.as_str());
        // A held fan (a requested bridge boost) is emitted on every layer.
        // The next path does not hold it, so the layer fan comes back.
        // Without a hold, the layers the request turns the fan off for stay
        // off; a request that names none keeps the first layer off and the
        // second at half.
        let on_from = self.fans.off_layers.unwrap_or(2);
        if path.fan_hold || layer.own >= on_from {
            self.set_fan(self.fans.pwm(path));
        } else if layer.own == 1 && self.fans.off_layers.is_none() {
            self.set_fan(128);
        } else {
            self.set_fan(0);
        }
        let speed = planned_feed(layer, path);
        // A path already slower than the floor stays where it was planned.
        let speed = if self.slow < 1.0 {
            (speed * self.slow).max(self.slow_floor).min(speed)
        } else {
            speed
        };
        let flow = path_flow(layer, path, self.flow_scale);
        if !self.quiet {
            self.comment(&format!("TYPE:{}", path.kind.as_str().to_ascii_uppercase()));
        }
        if path.points.is_empty() {
            return;
        }
        let bead_h = bead_height(layer, path);
        self.kind = "travel";
        let travel_accel = cap_accel(path.travel_accel, self.max_accel);
        let print_accel = cap_accel(path.accel, self.max_accel);
        self.set_accel(travel_accel);
        let (hop, (retract_mm, min_travel), z_hop) = match entry {
            Entry::AsPlanned => {
                let mut hop = path.lead_in.clone();
                hop.push(path.points[0]);
                (hop, path.travel_retract(self.retract_length), path.z_hop)
            }
            Entry::Cross { z_hop } => {
                let mm = self.retract_length.unwrap_or(path.retract_mm);
                (vec![path.points[0]], (mm, 0.0), z_hop)
            }
        };
        self.travel_chain(
            &hop,
            path.travel_speed,
            retract_mm,
            min_travel,
            travel_accel,
            z_hop,
            layer.z,
        );
        self.kind = path.kind.as_str();
        self.set_accel(print_accel);
        let limited = limit_speed(speed, path.width, bead_h, flow, self.max_volumetric_mm3_s);
        let (fit, loose) = chain_fit(self.arc_fit, path);
        self.emit_chain(
            &path.points,
            limited,
            path.width,
            bead_h,
            flow,
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

    fn flush_motion(&mut self) {
        if self.pending.is_empty() {
            return;
        }
        let pending = std::mem::take(&mut self.pending);
        let times = match &self.klipper {
            Some(klipper) => plan_klipper(&pending, klipper),
            None => plan_lookahead(&pending, self.junction_deviation),
        };
        let saved = self.kind;
        for (mv, dt) in pending.iter().zip(times) {
            self.kind = mv.kind;
            self.add_time(dt);
        }
        self.kind = saved;
    }

    #[allow(clippy::too_many_arguments)]
    fn queue_kin(
        &mut self,
        dist: f64,
        cruise: f64,
        accel: f64,
        entry_dir: [f64; 2],
        exit_dir: [f64; 2],
        dz: f64,
        e_per_mm: f64,
    ) {
        if self.strings_only || dist < 1e-6 {
            return;
        }
        let mut cruise = cruise.max(1.0);
        let mut accel = accel.max(50.0);
        let mut m204 = 0.0;
        if let Some(k) = &self.klipper {
            // The M204 in force, as Klipper holds it, not the rounded request.
            m204 = self.accel.max(50.0);
            accel = m204;
            if k.max_velocity > 0.0 {
                cruise = cruise.min(k.max_velocity);
            }
            if dz.abs() > 1e-9 {
                let ratio = dist / dz.abs();
                if k.z_velocity > 0.0 {
                    cruise = cruise.min(k.z_velocity * ratio);
                }
                if k.z_accel > 0.0 {
                    accel = accel.min(k.z_accel * ratio);
                }
            }
        }
        self.pending.push(KinMove {
            dist,
            cruise,
            accel,
            entry_dir,
            exit_dir,
            kind: self.kind,
            dz,
            e_per_mm,
            m204,
        });
    }

    /// Seconds an extruder-only move of `mm` of filament takes at the retract feed.
    /// Klipper accelerates it at `max_extrude_only_accel`; the generic estimator does not.
    fn extruder_move_s(&self, mm: f64) -> f64 {
        match &self.klipper {
            Some(k) => move_time(
                mm,
                0.0,
                0.0,
                self.retract_speed.min(k.e_velocity),
                k.e_accel,
            ),
            None => mm / self.retract_speed,
        }
    }

    /// Seconds of a Z-only move of `dz` at the layer-change feed, 120 mm/s.
    /// Klipper holds it to its Z limits, which on a belt printer are the belt's.
    fn z_move_s(&self, dz: f64) -> f64 {
        let Some(k) = &self.klipper else {
            return dz / 120.0;
        };
        let mut v: f64 = 120.0;
        let mut a = self.accel;
        if k.max_velocity > 0.0 {
            v = v.min(k.max_velocity);
        }
        if k.z_velocity > 0.0 {
            v = v.min(k.z_velocity);
        }
        if k.z_accel > 0.0 {
            a = a.min(k.z_accel);
        }
        move_time(dz, 0.0, 0.0, v, a)
    }

    fn add_time(&mut self, dt: f64) {
        if self.strings_only || dt <= 0.0 {
            return;
        }
        self.time_s += dt;
        *self.feature_s.entry(self.kind).or_insert(0.0) += dt;
        if let Some(log) = &mut self.log {
            log.time(self.kind, dt);
        }
    }

    fn add_filament(&mut self, mm: f64) {
        if self.strings_only || mm <= 0.0 {
            return;
        }
        *self.feature_mm.entry(self.kind).or_insert(0.0) += mm;
        if let Some(log) = &mut self.log {
            log.filament(self.kind, mm);
        }
    }

    fn add_e(&mut self, de: f64) {
        self.e += de;
        if let Some(log) = &mut self.log {
            log.e.push(de);
        }
    }

    fn add_extruded(&mut self, mm: f64) {
        self.extrusion_length_mm += mm;
        if let Some(log) = &mut self.log {
            log.extruded.push(mm);
        }
    }

    fn add_travelled(&mut self, mm: f64) {
        self.travel_length_mm += mm;
        if let Some(log) = &mut self.log {
            log.travelled.push(mm);
        }
    }

    /// Add one layer's scan to this writer's totals in the order its scan
    /// added them, and take the machine state it left.
    fn take_scan(&mut self, scan: LayerScan) {
        let log = scan.log;
        for &de in &log.e {
            self.e += de;
        }
        let mut mark = self.time_s;
        for (r, &(start, kind)) in log.time_kinds.iter().enumerate() {
            let end = log.time_kinds.get(r + 1).map_or(log.time.len(), |k| k.0);
            let slot = self.feature_s.entry(kind).or_insert(0.0);
            for (j, &dt) in log.time[start..end].iter().enumerate() {
                if start + j == log.mark {
                    mark = self.time_s;
                }
                self.time_s += dt;
                *slot += dt;
            }
        }
        if log.mark >= log.time.len() {
            mark = self.time_s;
        }
        self.layer_seconds.push((self.time_s - mark).max(0.0));
        for (r, &(start, kind)) in log.filament_kinds.iter().enumerate() {
            let end = log
                .filament_kinds
                .get(r + 1)
                .map_or(log.filament.len(), |k| k.0);
            let slot = self.feature_mm.entry(kind).or_insert(0.0);
            for &mm in &log.filament[start..end] {
                *slot += mm;
            }
        }
        for &mm in &log.extruded {
            self.extrusion_length_mm += mm;
        }
        for &mm in &log.travelled {
            self.travel_length_mm += mm;
        }
        self.extrusion_moves += scan.extrusion_moves;
        self.travel_moves += scan.travel_moves;
        self.arc_moves += scan.arc_moves;
        self.retracts += scan.retracts;
        self.z_hops += scan.z_hops;
        if let Some([min_x, max_x, min_y, max_y]) = scan.bounds {
            if self.bounds_init {
                self.min_x = self.min_x.min(min_x);
                self.max_x = self.max_x.max(max_x);
                self.min_y = self.min_y.min(min_y);
                self.max_y = self.max_y.max(max_y);
            } else {
                (self.min_x, self.max_x, self.min_y, self.max_y) = (min_x, max_x, min_y, max_y);
                self.bounds_init = true;
            }
        }
        let c = scan.exit;
        (self.x, self.y, self.z, self.has_pos) = (c.x, c.y, c.z, c.has_pos);
        (self.frame, self.offset) = (c.frame, self.offsets[c.frame as usize]);
        (self.retracted, self.accel, self.fan) = (c.retracted, c.accel, c.fan);
        (self.pa_cur, self.la_cur) = (c.pa_cur, c.la_cur);
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
            // Klipper re-times step generation here, which empties its lookahead queue.
            if self.klipper.is_some() {
                self.flush_motion();
            }
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

    fn layer_header(&mut self, layer: &PlateLayer) {
        self.slice_z = layer.z;
        let z = self.written_z(layer);
        if self.slow < 1.0 {
            let gap = if layer.note.is_empty() { "" } else { " " };
            let slow = self.slow;
            self.put(format_args!(
                ";LAYER:{} Z:{:.3} H:{:.3} {}{gap}slow ×{slow:.2}\n",
                layer.index, z, layer.height, layer.note
            ));
        } else {
            self.put(format_args!(
                ";LAYER:{} Z:{:.3} H:{:.3} {}\n",
                layer.index, z, layer.height, layer.note
            ));
        }
        let dz = (z - self.z).abs();
        let f = (120.0_f64 * 60.0) as i32;
        if self.permutes() {
            match self.belt.expect("permuted layer").axis {
                crate::belt::BeltAxis::X => self.put(format_args!("G1 X{z:.3} F{f}\n")),
                crate::belt::BeltAxis::Y => self.put(format_args!("G1 Y{z:.3} F{f}\n")),
                crate::belt::BeltAxis::Z => unreachable!("Z belt is not permuted"),
            }
        } else {
            self.put(format_args!("G1 Z{z:.3} F{f}\n"));
        }
        self.close_layer();
        self.kind = "travel";
        if dz > 1e-6 {
            self.add_time(self.z_move_s(dz));
        }
        self.layer_mark = self.time_s;
        if let Some(log) = &mut self.log {
            log.mark = log.time.len();
        }
        self.layer_open = true;
        self.z = z;
        self.has_dir = false;
        for cue in &layer.actions {
            if let Some(note) = &cue.note {
                self.comment(note);
            }
            self.put(format_args!("{}\n", cue.line));
        }
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
            self.add_e(self.retracted);
            let feed = self.retracted;
            self.retracted = 0.0;
            let e_now = self.e;
            let retract_feed = self.retract_feed;
            self.put(format_args!("G1 E{e_now:.5} F{retract_feed}\n"));
            let prev = self.kind;
            self.kind = "travel";
            self.add_time(self.extruder_move_s(feed));
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
            self.add_e(-retract_mm);
            self.retracted = retract_mm;
            self.retracts += 1;
            let e_now = self.e;
            let retract_feed = self.retract_feed;
            self.put(format_args!("G1 E{e_now:.5} F{retract_feed}\n"));
            self.add_time(self.extruder_move_s(retract_mm));
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
        self.add_travelled(d);
        let cruise = speed.max(10.0);
        let dz_signed = z - self.z;
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
                dz_signed,
                0.0,
            );
        }
        let f = (speed.max(10.0) * 60.0).round() as i32;
        let [bx, by] = self.bed(x, y);
        if self.permutes() {
            self.put_permuted(bx, by, f, None);
        } else if dz > 5e-4 {
            self.put(format_args!("G1 X{bx:.3} Y{by:.3} Z{z:.3} F{f}\n"));
            self.z = z;
        } else {
            self.put(format_args!("G1 X{bx:.3} Y{by:.3} F{f}\n"));
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
                self.add_e(-retract_mm);
                self.retracted = retract_mm;
                self.retracts += 1;
                let e_now = self.e;
                let retract_feed = self.retract_feed;
                self.put(format_args!("G1 E{e_now:.5} F{retract_feed}\n"));
                self.add_time(self.extruder_move_s(retract_mm));
            }
            self.add_travelled(d);
            let cruise = speed.max(10.0);
            if self.classic_estimator {
                self.add_time(move_time(d, 0.0, 0.0, cruise, accel));
                self.has_dir = false;
            } else {
                let dir = [x - self.x, y - self.y];
                self.queue_kin(d, cruise, accel, dir, dir, 0.0, 0.0);
            }
        }
        let f = (speed.max(10.0) * 60.0).round() as i32;
        let [bx, by] = self.bed(x, y);
        if self.permutes() {
            self.put_permuted(bx, by, f, None);
        } else {
            self.put(format_args!("G1 X{bx:.3} Y{by:.3} F{f}\n"));
        }
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
        // Half a bead: the bead laid on the arc still covers the line it replaces.
        let sag = width * 0.5;
        let mut i = 0usize;
        while i + 1 < points.len() {
            let mut end = i + 1;
            if arc_fit && i + 3 < points.len() && span_planar(z_frac, flow_frac, i, i + 4) {
                let mut j = i + 3;
                while j < points.len()
                    && j - i <= max_span
                    && span_planar(z_frac, flow_frac, i, j + 1)
                {
                    if fit_arc(&points[i..=j], arc_tol, min_r, sag).is_some() {
                        end = j;
                        j += 1;
                    } else {
                        break;
                    }
                }
            }
            if end >= i + 3 && span_planar(z_frac, flow_frac, i, end + 1) {
                if let Some(arc) = fit_arc(&points[i..=end], arc_tol, min_r, sag) {
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
            let (h, seg_flow, z) = segment_bead(
                i, scarfed, layer_h, flow, z_frac, flow_frac, layer_z, nominal_h,
            );
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
        let mut arcs = spans.iter().peekable();
        while i + 1 < points.len() {
            if let Some(span) = arcs.next_if(|s| s.start_i as usize == i) {
                let h = if scarfed {
                    layer_h * z_frac[i].clamp(0.0, 1.0)
                } else {
                    layer_h
                };
                self.arc(&span.arc, speed, width, h, flow, filament_d, accel);
                i = span.end_i as usize;
                continue;
            }
            let p = points[i + 1];
            let (h, seg_flow, z) = segment_bead(
                i, scarfed, layer_h, flow, z_frac, flow_frac, layer_z, nominal_h,
            );
            self.extrude(p[0], p[1], speed, width, h, seg_flow, filament_d, accel, z);
            i += 1;
        }
    }

    fn set_z(&mut self, z: f64) {
        // Scarf and Z hop are off on a belt. A slice-frame Z here would move
        // the belt by a fraction of a layer, which is not a hop.
        if self.belt.is_some() {
            return;
        }
        if (z - self.z).abs() < 5e-4 {
            return;
        }
        let dz = (z - self.z).abs();
        let f = (120.0_f64 * 60.0) as i32;
        self.put(format_args!("G1 Z{z:.3} F{f}\n"));
        self.flush_motion();
        self.add_time(self.z_move_s(dz));
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
        self.add_e(de);
        self.add_filament(de);
        let f = (speed.max(5.0) * 60.0).round() as i32;
        // The gantry runs against slice Y, so a belt mirrors the arc.
        let (cw, j) = match self.belt {
            Some(_) => (!arc.cw, -arc.ij[1]),
            None => (arc.cw, arc.ij[1]),
        };
        let cmd = if cw { "G2" } else { "G3" };
        let e_now = self.e;
        let [x, y] = self.bed(arc.end[0], arc.end[1]);
        let i = arc.ij[0];
        self.put(format_args!(
            "{cmd} X{x:.3} Y{y:.3} I{i:.4} J{j:.4} E{e_now:.5} F{f}\n"
        ));
        if self.klipper.is_some() {
            self.queue_arc_chords(arc, speed, de);
            self.land(arc.end);
        } else {
            self.note_motion(
                arc.end,
                arc.dir,
                arc.exit_dir,
                speed,
                accel,
                arc.length,
                0.0,
            );
        }
        self.arc_moves += 1;
        self.extrusion_moves += 1;
        self.add_extruded(arc.length);
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
        self.add_e(de);
        self.add_filament(de);
        let f = (speed.max(5.0) * 60.0).round() as i32;
        let e_now = self.e;
        let [bx, by] = self.bed(x, y);
        if self.permutes() {
            self.put_permuted(bx, by, f, Some(e_now));
        } else if let Some(z) = z {
            if (z - self.z).abs() > 5e-4 {
                self.put(format_args!(
                    "G1 X{bx:.3} Y{by:.3} Z{z:.3} E{e_now:.5} F{f}\n"
                ));
                self.z = z;
            } else {
                self.put(format_args!("G1 X{bx:.3} Y{by:.3} E{e_now:.5} F{f}\n"));
            }
        } else {
            self.put(format_args!("G1 X{bx:.3} Y{by:.3} E{e_now:.5} F{f}\n"));
        }
        let dir = [x - self.x, y - self.y];
        self.note_motion([x, y], dir, dir, speed, accel, d, bead / fil);
        self.extrusion_moves += 1;
        self.add_extruded(d);
    }

    #[allow(clippy::too_many_arguments)]
    fn note_motion(
        &mut self,
        end: [f64; 2],
        entry_dir: [f64; 2],
        exit_dir: [f64; 2],
        speed: f64,
        accel: f64,
        dist: f64,
        e_per_mm: f64,
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
            self.queue_kin(dist, cruise, accel, entry_dir, exit_dir, 0.0, e_per_mm);
        }
        self.land(end);
    }

    /// The nozzle is at `end` once the move is queued.
    fn land(&mut self, end: [f64; 2]) {
        self.note_bounds(end[0], end[1]);
        self.x = end[0];
        self.y = end[1];
        self.has_pos = true;
    }

    /// Klipper's `gcode_arcs` runs an arc as straight chords about a millimetre long, and
    /// each corner between them is a junction. `de` is the arc's filament, shared evenly.
    fn queue_arc_chords(&mut self, arc: &ArcFit, speed: f64, de: f64) {
        let radius = hypot(arc.ij[0], arc.ij[1]).max(1e-9);
        let chords = (arc.length.floor() as usize).max(1);
        let start = [self.x, self.y];
        let center = [start[0] + arc.ij[0], start[1] + arc.ij[1]];
        let a0 = (start[1] - center[1]).atan2(start[0] - center[0]);
        let step = (arc.length / radius) / chords as f64 * if arc.cw { -1.0 } else { 1.0 };
        let cruise = speed.max(5.0);
        let mut from = start;
        for k in 1..=chords {
            let to = if k == chords {
                arc.end
            } else {
                let a = a0 + step * k as f64;
                [center[0] + radius * a.cos(), center[1] + radius * a.sin()]
            };
            let dir = [to[0] - from[0], to[1] - from[1]];
            let dist = hypot(dir[0], dir[1]);
            if dist > 1e-9 {
                self.queue_kin(
                    dist,
                    cruise,
                    self.accel,
                    dir,
                    dir,
                    0.0,
                    de / chords as f64 / dist,
                );
            }
            from = to;
        }
    }

    fn note_bounds(&mut self, x: f64, y: f64) {
        if self.strings_only {
            return;
        }
        let [x, y] = self.bed(x, y);
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
            let retract_feed = self.retract_feed;
            self.put(format_args!("G1 E{e_now:.5} F{retract_feed}\n"));
        }
        // On a belt this axis is the belt: carry the part on the way it went.
        let z = self.z + 10.0 * self.belt.map_or(1.0, |b| b.direction);
        if self.permutes() {
            match self.belt.expect("permuted lift").axis {
                crate::belt::BeltAxis::X => self.put(format_args!("G1 X{z:.3} F600\n")),
                crate::belt::BeltAxis::Y => self.put(format_args!("G1 Y{z:.3} F600\n")),
                crate::belt::BeltAxis::Z => unreachable!("Z belt is not permuted"),
            }
        } else {
            self.put(format_args!("G1 Z{z:.3} F600\n"));
        }
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
            layer_slow: Vec::new(),
            cancelled: self.cancelled,
        }
    }
}

fn hop_height(dist: f64, total: f64, ramp: f64, layer_z: f64, z_hop: f64) -> f64 {
    let up = (dist / ramp.max(1e-6)).clamp(0.0, 1.0);
    let down = ((total - dist) / ramp.max(1e-6)).clamp(0.0, 1.0);
    layer_z + z_hop * up.min(down)
}

fn feature_rows(
    seconds: &BTreeMap<&'static str, f64>,
    mm: &BTreeMap<&'static str, f64>,
) -> Vec<FeatureStat> {
    let mut kinds: Vec<&'static str> = seconds.keys().copied().collect();
    for key in mm.keys() {
        if !kinds.contains(key) {
            kinds.push(key);
        }
    }
    kinds.sort();
    kinds
        .into_iter()
        .map(|kind| FeatureStat {
            seconds: seconds.get(kind).copied().unwrap_or(0.0),
            filament_mm: mm.get(kind).copied().unwrap_or(0.0),
            kind: kind.to_string(),
        })
        .filter(|row| row.seconds > 1e-6 || row.filament_mm > 1e-6)
        .collect()
}

fn hypot(x: f64, y: f64) -> f64 {
    x.hypot(y)
}

/// The job's flow multiplier as the writer applies it. A value that isn't
/// finite is ignored.
fn flow_scale(flow: f64) -> f64 {
    if flow.is_finite() {
        flow
    } else {
        1.0
    }
}

/// The flow every segment of `path` takes before its per-point fraction:
/// the first layer's 6% extra, the job's multiplier, and the path's own.
/// `1.0` times the layer flow is the same float, so an unused multiplier
/// leaves every E value where it was.
fn path_flow(layer: &PlateLayer, path: &Extrusion, flow_scale: f64) -> f64 {
    let layer_flow = if layer.own == 0 { 1.06 } else { 1.0 };
    layer_flow * flow_scale * path.flow
}

/// The bead's height: the path's own when it sets one, else the layer's.
fn bead_height(layer: &PlateLayer, path: &Extrusion) -> f64 {
    if path.bead_height > 1e-6 {
        path.bead_height
    } else {
        layer.height
    }
}

/// Segment `i`'s bead height and flow, and the nozzle Z at its end when a
/// scarf moves it. A scarfed segment takes the mean of its two points.
#[allow(clippy::too_many_arguments)]
fn segment_bead(
    i: usize,
    scarfed: bool,
    layer_h: f64,
    flow: f64,
    z_frac: &[f64],
    flow_frac: &[f64],
    layer_z: f64,
    nominal_h: f64,
) -> (f64, f64, Option<f64>) {
    if !scarfed {
        return (layer_h, flow, None);
    }
    let z0 = z_frac[i].clamp(0.0, 1.0);
    let z1 = z_frac[i + 1].clamp(0.0, 1.0);
    let f0 = flow_frac[i].clamp(0.0, 2.0);
    let f1 = flow_frac[i + 1].clamp(0.0, 2.0);
    (
        nominal_h * 0.5 * (z0 + z1),
        flow * 0.5 * (f0 + f1),
        Some(nozzle_z(layer_z, nominal_h, z1)),
    )
}

/// One extruding segment as the nozzle lays it: what `extrude` writes an E
/// value for. Points are in the slice frame with the object's plate offset
/// added, so on a cartesian printer they are bed coordinates; a belt's
/// gantry transform is not applied. `z` is the nozzle height.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Bead {
    /// The plate layer's index.
    pub layer: usize,
    pub object: u16,
    pub kind: PathKind,
    pub from: [f64; 3],
    pub to: [f64; 3],
    pub width: f64,
    pub height: f64,
    /// Every multiplier the writer applies: first layer, job, path, and the
    /// per-point fraction.
    pub flow: f64,
}

impl Bead {
    /// The deposited volume in mm³: the writer's E for this segment times
    /// the filament's cross-section.
    pub fn volume_mm3(&self) -> f64 {
        let length = hypot(self.to[0] - self.from[0], self.to[1] - self.from[1]);
        length * self.width * self.height.max(0.0) * self.flow.max(0.0)
    }
}

/// Every segment the writer extrudes, in print order, with the same height
/// and flow it writes E from. `flow` and `offsets` are what `emit_gcode`
/// takes. Fuzzy skin and scarf seams are already in the paths. Arc fitting
/// is a G-code encoding: the beads follow the planned points, whose chords
/// lie within half a bead of the arcs the writer may send instead.
pub(crate) fn emitted_beads<'a>(
    layers: &'a [PlateLayer],
    offsets: &'a [[f64; 2]],
    flow: f64,
) -> impl Iterator<Item = Bead> + 'a {
    let scale = flow_scale(flow);
    layers.iter().flat_map(move |layer| {
        layer.runs.iter().flat_map(move |run| {
            let offset = offsets
                .get(run.object as usize)
                .copied()
                .unwrap_or([0.0, 0.0]);
            run.layer.paths[run.paths.clone()]
                .iter()
                .flat_map(move |path| path_beads(layer, run.object, path, offset, scale))
        })
    })
}

fn path_beads<'a>(
    layer: &'a PlateLayer,
    object: u16,
    path: &'a Extrusion,
    offset: [f64; 2],
    scale: f64,
) -> impl Iterator<Item = Bead> + 'a {
    let points = &path.points;
    let scarfed = path.z_frac.len() == points.len() && path.flow_frac.len() == points.len();
    let layer_h = bead_height(layer, path);
    let flow = path_flow(layer, path, scale);
    let mut z = if scarfed && !points.is_empty() {
        nozzle_z(layer.z, layer.height, path.z_frac[0])
    } else {
        layer.z
    };
    (1..points.len().max(1)).filter_map(move |j| {
        let i = j - 1;
        let (h, seg_flow, end_z) = segment_bead(
            i,
            scarfed,
            layer_h,
            flow,
            &path.z_frac,
            &path.flow_frac,
            layer.z,
            layer.height,
        );
        let [x0, y0] = points[i];
        let [x1, y1] = points[j];
        let z0 = z;
        z = end_z.unwrap_or(z);
        // `extrude` writes no E for a step this short.
        if hypot(x1 - x0, y1 - y0) < 1e-4 {
            return None;
        }
        Some(Bead {
            layer: layer.index,
            object,
            kind: path.kind,
            from: [x0 + offset[0], y0 + offset[1], z0],
            to: [x1 + offset[0], y1 + offset[1], z],
            width: path.width,
            height: h,
            flow: seg_flow,
        })
    })
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
/// `v² = min(cruise², jd * accel * sin(θ/2) / (1 - sin(θ/2)), 0.5 * d * accel * tan(θ/2))`.
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
    let cos_theta_d2 = (0.5 * (1.0 + junction_cos)).sqrt().max(1e-9);
    let denom = (1.0 - sin_theta_d2).max(1e-6);
    let r_jd = sin_theta_d2 / denom;
    let jd = junction_deviation.max(0.0);
    let mut v2 = (r_jd * jd * a.accel)
        .min(r_jd * jd * b.accel)
        .min(a.cruise * a.cruise)
        .min(b.cruise * b.cruise);
    // Klipper's centripetal cap: the circle through the junction touches
    // each move no further than its midpoint, `0.5 · d · accel · tan(θ/2)`.
    let tan_theta_d2 = sin_theta_d2 / cos_theta_d2;
    v2 = v2.min(0.5 * a.dist * a.accel * tan_theta_d2);
    v2 = v2.min(0.5 * b.dist * b.accel * tan_theta_d2);
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

/// What Klipper's toolhead needs to time a move, from the printer profile.
#[derive(Clone, Copy)]
struct KlipperCfg {
    square_corner_velocity: f64,
    /// `scv² (√2 − 1)`. Klipper's junction deviation is this over the `M204` acceleration, so a
    /// move's deviation times its own acceleration is this over the ratio of the two.
    corner_k: f64,
    min_cruise_ratio: f64,
    extruder_corner_v: f64,
    /// `0` leaves the feeds uncapped.
    max_velocity: f64,
    /// `0` adds no limit.
    z_velocity: f64,
    z_accel: f64,
    /// Extruder-only moves: `max_extrude_only_velocity` and `max_extrude_only_accel`.
    e_velocity: f64,
    e_accel: f64,
}

impl KlipperCfg {
    fn new(profile: &PrinterProfile) -> Self {
        let or = |v: f64, fallback: f64| {
            if v.is_finite() && v >= 0.0 {
                v
            } else {
                fallback
            }
        };
        let scv = or(profile.square_corner_velocity, 5.0);
        // Klipper's default extruder cross-section, 4 nozzle², over the filament's area.
        let ratio = 4.0 * profile.nozzle_diameter.powi(2)
            / (std::f64::consts::PI * (profile.filament_diameter * 0.5).powi(2));
        let max_velocity = or(profile.max_velocity, 0.0);
        Self {
            square_corner_velocity: scv,
            corner_k: scv * scv * (std::f64::consts::SQRT_2 - 1.0),
            min_cruise_ratio: or(profile.minimum_cruise_ratio, 0.5).min(0.999),
            extruder_corner_v: or(profile.extruder_corner_velocity, 1.0),
            max_velocity,
            z_velocity: or(profile.max_z_velocity, 0.0),
            z_accel: or(profile.max_z_accel, 0.0),
            e_velocity: if max_velocity > 0.0 {
                max_velocity * ratio
            } else {
                f64::INFINITY
            },
            e_accel: if profile.max_accel.is_finite() && profile.max_accel > 0.0 {
                profile.max_accel * ratio
            } else {
                f64::INFINITY
            },
        }
    }
}

/// Each move's seconds under Klipper's lookahead, for a chain that starts and ends at rest.
fn plan_klipper(moves: &[KinMove], k: &KlipperCfg) -> Vec<f64> {
    moves
        .iter()
        .zip(klipper_speeds(moves, k))
        .map(|(m, [start_v2, cruise_v2, end_v2])| {
            // `Move.set_junction`.
            let half_inv_accel = 0.5 / m.accel;
            let accel_d = (cruise_v2 - start_v2) * half_inv_accel;
            let decel_d = (cruise_v2 - end_v2) * half_inv_accel;
            let cruise_d = m.dist - accel_d - decel_d;
            let (start_v, cruise_v, end_v) = (start_v2.sqrt(), cruise_v2.sqrt(), end_v2.sqrt());
            accel_d / ((start_v + cruise_v) * 0.5)
                + cruise_d / cruise_v
                + decel_d / ((end_v + cruise_v) * 0.5)
        })
        .collect()
}

/// Klipper's lookahead (`LookAheadQueue.flush` in `klippy/toolhead.py`, with
/// `minimum_cruise_ratio`) over a chain of moves that starts and ends at rest.
/// Returns each move's squared start, cruise and end speeds.
fn klipper_speeds(moves: &[KinMove], k: &KlipperCfg) -> Vec<[f64; 3]> {
    let n = moves.len();
    let axes = |m: &KinMove| -> [f64; 4] {
        let planar = hypot(m.entry_dir[0], m.entry_dir[1]);
        let xy = (m.dist * m.dist - m.dz * m.dz).max(0.0).sqrt();
        let scale = if planar > 1e-12 {
            xy / (planar * m.dist)
        } else {
            0.0
        };
        [
            m.entry_dir[0] * scale,
            m.entry_dir[1] * scale,
            m.dz / m.dist,
            m.e_per_mm,
        ]
    };
    let mut cruise_v2 = Vec::with_capacity(n);
    let mut delta_v2 = Vec::with_capacity(n);
    let mut smooth_delta_v2 = Vec::with_capacity(n);
    let mut max_start_v2 = vec![0.0; n];
    let mut max_smoothed_v2 = vec![0.0; n];
    let mut prev_axes = [0.0; 4];
    for (i, m) in moves.iter().enumerate() {
        cruise_v2.push(m.cruise * m.cruise);
        delta_v2.push(2.0 * m.dist * m.accel);
        smooth_delta_v2.push((2.0 * m.dist * m.m204 * (1.0 - k.min_cruise_ratio)).min(delta_v2[i]));
        let a = axes(m);
        if i > 0 {
            let p = &moves[i - 1];
            let cos_theta = -(a[0] * prev_axes[0] + a[1] * prev_axes[1] + a[2] * prev_axes[2]);
            if cos_theta <= 0.999999 {
                let cos_theta = cos_theta.max(-0.999999);
                let sin_d2 = (0.5 * (1.0 - cos_theta)).max(0.0).sqrt();
                let cos_d2 = (0.5 * (1.0 + cos_theta)).max(0.0).sqrt();
                let one_minus_sin_d2 = 1.0 - sin_d2;
                if one_minus_sin_d2 > 0.0 && cos_d2 > 0.0 {
                    let r_jd = sin_d2 / one_minus_sin_d2;
                    let tan_d2 = sin_d2 / cos_d2;
                    let diff_r = a[3] - prev_axes[3];
                    let extruder_v2 = if diff_r != 0.0 {
                        (k.extruder_corner_v / diff_r.abs()).powi(2)
                    } else {
                        cruise_v2[i]
                    };
                    // `junction_deviation * accel` is `corner_k` for a move that no axis limit slowed.
                    let jd_accel = |m: &KinMove| k.corner_k / m.m204 * m.accel;
                    max_start_v2[i] = (r_jd * jd_accel(m))
                        .min(r_jd * jd_accel(p))
                        .min(0.5 * m.dist * tan_d2 * m.accel)
                        .min(0.5 * p.dist * tan_d2 * p.accel)
                        .min(extruder_v2)
                        .min(cruise_v2[i])
                        .min(cruise_v2[i - 1])
                        .min(max_start_v2[i - 1] + delta_v2[i - 1]);
                    max_smoothed_v2[i] =
                        max_start_v2[i].min(max_smoothed_v2[i - 1] + smooth_delta_v2[i - 1]);
                }
            }
        }
        prev_axes = a;
    }

    let mut speeds = vec![[0.0; 3]; n];
    let mut set_junction = |i: usize, start_v2: f64, cruise_v2: f64, end_v2: f64| {
        speeds[i] = [start_v2, cruise_v2, end_v2];
    };
    // Backward from the last move, which stops: each move's start, and the peak speed
    // that the smoothed (minimum cruise ratio) acceleration lets it reach.
    let mut delayed: Vec<(usize, f64, f64)> = Vec::new();
    let (mut next_end_v2, mut next_smoothed_v2, mut peak_cruise_v2) = (0.0_f64, 0.0_f64, 0.0_f64);
    for i in (0..n).rev() {
        let reachable_start_v2 = next_end_v2 + delta_v2[i];
        let start_v2 = max_start_v2[i].min(reachable_start_v2);
        let reachable_smoothed_v2 = next_smoothed_v2 + smooth_delta_v2[i];
        let smoothed_v2 = max_smoothed_v2[i].min(reachable_smoothed_v2);
        if smoothed_v2 < reachable_smoothed_v2 {
            if smoothed_v2 + smooth_delta_v2[i] > next_smoothed_v2 || !delayed.is_empty() {
                peak_cruise_v2 = cruise_v2[i].min((smoothed_v2 + reachable_smoothed_v2) * 0.5);
                if !delayed.is_empty() {
                    let mut mc_v2 = peak_cruise_v2;
                    for &(j, ms_v2, me_v2) in delayed.iter().rev() {
                        mc_v2 = mc_v2.min(ms_v2);
                        set_junction(j, ms_v2.min(mc_v2), mc_v2, me_v2.min(mc_v2));
                    }
                    delayed.clear();
                }
            }
            let cruise = ((start_v2 + reachable_start_v2) * 0.5)
                .min(cruise_v2[i])
                .min(peak_cruise_v2);
            set_junction(i, start_v2.min(cruise), cruise, next_end_v2.min(cruise));
        } else {
            delayed.push((i, start_v2, next_end_v2));
        }
        next_end_v2 = start_v2;
        next_smoothed_v2 = smoothed_v2;
    }
    speeds
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
            path.width,
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
    width: f64,
) -> Vec<Span> {
    let arc_tol = if loose_arcs { 0.16 } else { 0.07 };
    let min_r = if loose_arcs { 0.35 } else { 0.8 };
    let max_span = if loose_arcs { 64 } else { 32 };
    let sag = width * 0.5;
    let mut spans = Vec::new();
    let mut i = 0usize;
    while i + 1 < points.len() {
        let mut end = i + 1;
        if arc_fit && i + 3 < points.len() && span_planar(z_frac, flow_frac, i, i + 4) {
            let mut j = i + 3;
            while j < points.len() && j - i <= max_span && span_planar(z_frac, flow_frac, i, j + 1)
            {
                if fit_arc(&points[i..=j], arc_tol, min_r, sag).is_some() {
                    end = j;
                    j += 1;
                } else {
                    break;
                }
            }
        }
        if end >= i + 3 && span_planar(z_frac, flow_frac, i, end + 1) {
            if let Some(arc) = fit_arc(&points[i..=end], arc_tol, min_r, sag) {
                spans.push(Span {
                    start_i: i as u32,
                    end_i: end as u32,
                    arc,
                });
                i = end;
                continue;
            }
        }
        i += 1;
    }
    spans
}

/// One arc of a path, from point `start_i` to point `end_i`. The segments
/// between arcs print as lines, so a layer keeps only its arcs.
#[derive(Clone)]
struct Span {
    start_i: u32,
    end_i: u32,
    arc: ArcFit,
}

/// An arc through `pts`: every point within `tol` of it, and every straight
/// stretch between two points bowed off it by at most `chord_sag`.
fn fit_arc(pts: &[[f64; 2]], tol: f64, min_r: f64, chord_sag: f64) -> Option<ArcFit> {
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
    // Between two points the path is a straight line, which sits inside the
    // arc by the chord's sagitta. Both ends on the circle say nothing about it:
    // two tight corners at the ends of a long side fit one circle. A facet of
    // a tessellated circle bows a little, and the arc is the circle it came from.
    for w in pts.windows(2) {
        let half = hypot(w[1][0] - w[0][0], w[1][1] - w[0][1]) * 0.5;
        if half >= r || r - (r * r - half * half).sqrt() > chord_sag {
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

    #[test]
    fn the_arc_note_names_why_arcs_are_off() {
        // (named, asked, takes_arcs, plane)
        let firmware = "; arcs off (firmware takes no G2/G3)";
        assert_eq!(arc_note(false, true, false, true), firmware);
        assert_eq!(arc_note(true, true, false, false), firmware);
        assert_eq!(arc_note(false, true, true, true), "");
        assert_eq!(arc_note(false, false, false, true), "");
        assert_eq!(arc_note(false, true, true, false), "");
        assert_eq!(arc_note(true, true, true, true), "; arcs on");
        assert_eq!(
            arc_note(true, true, true, false),
            "; arcs off (belt axis is not Z)"
        );
        assert_eq!(arc_note(true, false, false, true), "; arcs off");
        assert_eq!(arc_note(true, false, true, true), "; arcs off");
    }

    fn kin(dist: f64, cruise: f64, accel: f64, dir: [f64; 2]) -> KinMove {
        KinMove {
            dist,
            cruise,
            accel,
            entry_dir: dir,
            exit_dir: dir,
            kind: "wall",
            dz: 0.0,
            e_per_mm: 0.0,
            m204: accel,
        }
    }

    fn chain_time(moves: &[KinMove], jd: f64) -> f64 {
        plan_lookahead(moves, jd).iter().sum()
    }

    fn klipper_with(edit: impl FnOnce(&mut PrinterProfile)) -> KlipperCfg {
        let mut profile = PrinterProfile {
            firmware: Some(Firmware::Klipper),
            ..PrinterProfile::default()
        };
        edit(&mut profile);
        KlipperCfg::new(&profile)
    }

    /// A move at accel 3500 and feed 100, `e_per_mm` of filament per millimetre.
    fn km(dist: f64, dir: [f64; 2], e_per_mm: f64) -> KinMove {
        KinMove {
            e_per_mm,
            ..kin(dist, 100.0, 3500.0, dir)
        }
    }

    #[test]
    fn a_right_angle_corner_is_taken_at_the_square_corner_velocity() {
        let corner = [km(50.0, [1.0, 0.0], 0.0), km(50.0, [0.0, 1.0], 0.0)];
        for scv in [5.0, 8.0] {
            let k = klipper_with(|p| p.square_corner_velocity = scv);
            let speeds = klipper_speeds(&corner, &k);
            assert!(
                (speeds[1][0].sqrt() - scv).abs() < 1e-9,
                "scv {scv}: junction {}",
                speeds[1][0].sqrt()
            );
            assert_eq!(speeds[0][0], 0.0, "the chain starts at rest");
            assert_eq!(speeds[1][2], 0.0, "and ends at rest");
        }
    }

    #[test]
    fn a_short_staircase_peaks_at_half_the_acceleration() {
        // Four 1 mm moves turning 90° each time. A move between two 5 mm/s corners
        // could reach v² = (25 + 25 + 2·3500·1) / 2 = 3525; the minimum cruise ratio
        // of 0.5 smooths it to (25 + 25 + 2·1750·1) / 2 = 1775.
        let stairs: Vec<_> = (0..4)
            .map(|i| km(1.0, if i % 2 == 0 { [1.0, 0.0] } else { [0.0, 1.0] }, 0.0))
            .collect();
        let half = klipper_speeds(&stairs, &klipper_with(|_| {}));
        assert!((half[1][1] - 1775.0).abs() < 1e-6, "peak v² {}", half[1][1]);
        assert!((half[2][1] - 1775.0).abs() < 1e-6, "peak v² {}", half[2][1]);
        let full = klipper_speeds(&stairs, &klipper_with(|p| p.minimum_cruise_ratio = 0.0));
        assert!((full[1][1] - 3525.0).abs() < 1e-6, "peak v² {}", full[1][1]);
        let t = |k: &KlipperCfg| plan_klipper(&stairs, k).iter().sum::<f64>();
        assert!(
            t(&klipper_with(|_| {})) > t(&klipper_with(|p| p.minimum_cruise_ratio = 0.0)),
            "a lower peak takes longer"
        );
    }

    #[test]
    fn an_extrusion_meeting_a_travel_is_held_to_the_extruder_corner_velocity() {
        // 0.04 mm of filament per mm: the junction may be 1.0 / 0.04 = 25 mm/s,
        // though the line is straight and both feeds are 100.
        let line = [km(50.0, [1.0, 0.0], 0.04), km(50.0, [1.0, 0.0], 0.0)];
        let speeds = klipper_speeds(&line, &klipper_with(|_| {}));
        assert!(
            (speeds[1][0] - 625.0).abs() < 1e-9,
            "junction {} mm/s",
            speeds[1][0].sqrt()
        );
        let free = klipper_speeds(
            &line,
            &klipper_with(|p| p.extruder_corner_velocity = 1000.0),
        );
        assert!(
            (free[1][0] - 10_000.0).abs() < 1e-9,
            "a loose limit leaves the feed alone"
        );
        let same = [km(50.0, [1.0, 0.0], 0.04), km(50.0, [1.0, 0.0], 0.04)];
        let kept = klipper_speeds(&same, &klipper_with(|_| {}));
        assert!(
            (kept[1][0] - 10_000.0).abs() < 1e-9,
            "equal extrusion is not a corner"
        );
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
    fn a_gentle_bend_between_short_moves_keeps_cruise() {
        let bend = 5f64.to_radians();
        let moves = [
            kin(0.3, 40.0, 650.0, [1.0, 0.0]),
            kin(0.3, 40.0, 650.0, [bend.cos(), bend.sin()]),
        ];
        let v = klipper_junction(&moves[0], &moves[1], 0.02);
        assert!((v - 40.0).abs() < 1e-9, "junction {v}");
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
        let arc = fit_arc(&pts, 0.05, 0.8, 0.225).expect("quarter circle");
        let dot = arc.dir[0] * arc.exit_dir[0] + arc.dir[1] * arc.exit_dir[1];
        let n0 = hypot(arc.dir[0], arc.dir[1]);
        let n1 = hypot(arc.exit_dir[0], arc.exit_dir[1]);
        let cos = dot / (n0 * n1);
        assert!(
            cos.abs() < 0.2,
            "start and end tangents of a quarter circle, cos {cos}"
        );
    }

    #[test]
    fn a_straight_side_between_two_rounded_corners_is_not_an_arc() {
        // Every point is on one circle, but the 80° side between the second
        // and third is a straight line 2.3 mm inside it.
        let pts: Vec<[f64; 2]> = [0.0_f64, 5.0, 85.0, 90.0]
            .iter()
            .map(|deg| [deg.to_radians().cos() * 10.0, deg.to_radians().sin() * 10.0])
            .collect();
        assert!(fit_arc(&pts, 0.07, 0.8, 0.225).is_none());
    }
}
