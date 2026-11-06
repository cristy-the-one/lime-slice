use super::assemble::support_z_gap;
use super::brims::{belt_lines, belt_trunks, merge_spans, subtract_spans, BeltBrim};
use super::elapsed_ms;
use super::parts::{Contours, SupportPlan};
use super::regions::{split_edge, split_extrusions, split_rects, support_half_rects, RegionSplit};
use super::resolve::{resolve, shaft_scales};
use super::zones::layer_strategy;
use crate::poly::{boolean_union, clip_to_rect, Loop};
use crate::strategy::{
    pure, support_density, support_interface_density, support_speed, ResolvedStrategy,
};
use crate::support::tree::Foot;
use crate::support::{Disk, FloorPlane, SupportLayer, SupportOpts, Supports};
use crate::toolpath::{
    plan_brim_lines, plan_support, plan_support_brim, plan_tree_support, Extrusion,
};
use crate::{
    BlendMode, PathKind, SliceSettings, Stage, StrategyId, SupportSource, SupportStyle, Watch,
};
use rayon::iter::{IntoParallelRefIterator, ParallelIterator};
use std::sync::Arc;
use std::time::Instant;

/// Supports for the part of `cut`, grown among `solid` when other objects
/// stand near, else among the part alone.
pub(super) fn plan_supports(
    cut: &Contours,
    blend: &BlendMode,
    settings: &SliceSettings,
    solid: Option<Arc<Vec<Vec<Loop>>>>,
    floor: Option<FloorPlane>,
    watch: &Watch,
) -> Result<SupportPlan, String> {
    let support_started = Instant::now();
    let mut opts = SupportOpts {
        angle_deg: settings.support_angle,
        z_gap: support_z_gap(settings),
        style: settings.support_style,
        branch_angle_deg: settings.branch_angle,
        tip_diameter: settings.tip_diameter,
        trunk_diameter: settings.trunk_diameter.max(settings.tip_diameter + 0.6),
        density: support_seed_weight(blend),
        load_factor: support_load_factor(blend),
        max_tip_spacing: support_tip_spacing(blend),
        job: settings.job,
        ..SupportOpts::default()
    };
    opts.floor = floor;
    opts.avoidance = settings.support_avoidance && settings.support_style == SupportStyle::Tree;
    opts.strict_stacking =
        settings.support_strict_stacking && settings.support_style == SupportStyle::Tree;
    opts.source = settings.support_source;
    if settings.support_paint_join {
        opts.paint_join_mm = crate::support::PAINT_JOIN_MM;
    }
    if let Some(xy) = settings.support_xy_gap_mm {
        opts.xy_gap = xy;
    }
    if let Some(layers) = settings.support_interface_layers {
        opts.interface_layers = layers;
    }
    watch.begin(Stage::Supports, cut.bands.len().max(1) as u32);
    if watch.stopped(settings.job) {
        return Err("cancelled".into());
    }
    if !settings.supports {
        let in_air = cut.in_air(opts.angle_deg, &[], 0.0);
        if watch.stopped(settings.job) {
            return Err("cancelled".into());
        }
        watch.fill();
        return Ok(SupportPlan {
            supports: Arc::new(Supports::none(cut.bands.len(), &opts)),
            coverage: Vec::new(),
            in_air: Some(in_air),
            shaft: vec![0.0; cut.bands.len()],
            paths: (0..cut.bands.len()).map(|_| Arc::new(Vec::new())).collect(),
            solid: None,
            support_ms: elapsed_ms(support_started),
            toolpath_ms: 0.0,
        });
    }
    let among = solid.as_deref().map_or(&cut.contours, |s| s);
    let supports = Supports::build_with(
        &cut.bands,
        &cut.contours,
        among,
        &settings.support_paint,
        &opts,
        watch,
    );
    let Some(supports) = supports.filter(|_| !watch.stopped(settings.job)) else {
        return Err("cancelled".into());
    };
    let coverage = supports.coverage(&cut.bands, among);
    let support_ms = elapsed_ms(support_started);
    let shaft = shaft_scales(&supports.layers, settings.support_height_mult);
    let toolpath_started = Instant::now();
    let all: Vec<usize> = (0..cut.bands.len()).collect();
    let paths = paint(
        cut, &supports, &shaft, &all, blend, settings, watch, false, floor,
    )
    .into_iter()
    .map(Arc::new)
    .collect();
    let toolpath_ms = elapsed_ms(toolpath_started);
    // Painted only leaves the rest of the part to print over air, so say so.
    let in_air = (opts.source == SupportSource::Paint)
        .then(|| cut.in_air(opts.angle_deg, &settings.support_paint, opts.paint_join_mm));
    if watch.stopped(settings.job) {
        return Err("cancelled".into());
    }
    watch.fill();
    Ok(SupportPlan {
        supports: Arc::new(supports),
        coverage,
        in_air,
        shaft,
        paths,
        solid,
        support_ms,
        toolpath_ms,
    })
}

/// Support paths for each layer `which` names, in its order.
#[allow(clippy::too_many_arguments)]
pub(super) fn paint(
    cut: &Contours,
    supports: &Supports,
    shaft: &[f64],
    which: &[usize],
    blend: &BlendMode,
    settings: &SliceSettings,
    watch: &Watch,
    count: bool,
    floor: Option<FloorPlane>,
) -> Vec<Vec<Extrusion>> {
    let (min, max) = cut.bounds;
    let layers = &supports.layers;
    // A belt foot spreads as wide as a trunk, as a trunk on the bed does.
    let spread = 0.5 * settings.trunk_diameter.max(settings.tip_diameter + 0.6) * 0.95;
    let (brims, anchors) = match floor {
        Some(floor) => belt_lines(cut, supports, floor, settings, spread),
        None => (Vec::new(), Vec::new()),
    };
    which
        .par_iter()
        .map(|&i| {
            let band = &cut.bands[i];
            let Some(layer) = layers.get(i).filter(|_| !watch.stopped(settings.job)) else {
                return Vec::new();
            };
            let feet = supports.belt_feet(&cut.bands, i, spread);
            let paths = support_paths(
                band.z,
                band.height,
                &cut.contours[i],
                layer,
                shaft.get(i).copied().unwrap_or(0.0),
                blend,
                settings,
                min,
                max,
                i,
                floor,
                &feet,
                brims.get(i).and_then(Option::as_ref),
                anchors.get(i).and_then(Option::as_ref),
            );
            if count {
                watch.tick();
            }
            paths
        })
        .collect()
}

/// Paths printed from one layer's support regions and branches.
#[allow(clippy::too_many_arguments)]
pub(super) fn support_paths(
    z: f64,
    height: f64,
    contours: &[Loop],
    layer: &SupportLayer,
    shaft_scale: f64,
    blend: &BlendMode,
    settings: &SliceSettings,
    min: [f64; 3],
    max: [f64; 3],
    layer_index: usize,
    floor: Option<FloorPlane>,
    feet: &[Foot],
    belt_brim: Option<&BeltBrim>,
    belt_anchor: Option<&BeltBrim>,
) -> Vec<Extrusion> {
    let line_width = settings.line_width;
    let (disks, foot) = belt_trunks(&layer.disks, feet, floor, z, contours, settings);
    // A grid column on the belt falls along gravity, which moves it in slice
    // Y from layer to layer. Its lines fall with it, through a point fixed
    // in the lab, so each layer's lines stand on the lines below.
    let through = floor.map(|floor| [0.0, -z * floor.tan_a()]);
    // Only supports standing on layer 0 are on the bed. A belt has no flat
    // bed there (`skirt` is off); its brim comes from `belt_brim`.
    let brim_mm = if layer_index == 0 && settings.skirt {
        settings.support_tree_brim_mm.unwrap_or(0.0)
    } else {
        0.0
    };
    let mut paths = Vec::new();
    match blend {
        BlendMode::ByRegion { axis, at_mm } => {
            let split = split_rects(*axis, *at_mm, min, max, contours);
            let tough = resolve(pure(StrategyId::Toughness), settings);
            let speed = resolve(pure(StrategyId::Speed), settings);
            emit_supports(
                &mut paths,
                &layer.sparse,
                &layer.interface,
                &disks,
                &foot,
                shaft_scale,
                height,
                &tough,
                &speed,
                Some(split),
                line_width,
                through,
            );
        }
        other => {
            let resolved = layer_strategy(other, z, settings);
            emit_supports(
                &mut paths,
                &layer.sparse,
                &layer.interface,
                &disks,
                &foot,
                shaft_scale,
                height,
                &resolved,
                &resolved,
                None,
                line_width,
                through,
            );
        }
    }
    if let Some(anchor) = belt_anchor {
        // The anchor crosses the support beads on its line, which ties the
        // feet to it; a bead that runs along the anchor is left to itself.
        let along: Vec<[f64; 2]> = paths
            .iter()
            .flat_map(|p| p.points.windows(2))
            .filter(|w| w.iter().all(|q| (q[1] - anchor.y).abs() < line_width))
            .map(|w| [w[0][0].min(w[1][0]), w[0][0].max(w[1][0])])
            .collect();
        let spans = subtract_spans(&anchor.spans, &merge_spans(along));
        let strategy = match blend {
            BlendMode::ByRegion { .. } => resolve(pure(StrategyId::Toughness), settings),
            other => layer_strategy(other, z, settings),
        };
        // The anchor goes down first, so the layer's feet print onto a line
        // already stuck to the belt.
        let lines = plan_brim_lines(&spans, anchor.y, &strategy, line_width);
        paths.splice(0..0, lines);
    }
    if brim_mm > 1e-6 || belt_brim.is_some() {
        let strategy = match blend {
            BlendMode::ByRegion { .. } => resolve(pure(StrategyId::Toughness), settings),
            other => layer_strategy(other, z, settings),
        };
        if brim_mm > 1e-6 {
            let region = boolean_union(&layer.sparse, &layer.interface);
            let gap = settings
                .support_xy_gap_mm
                .unwrap_or_else(|| SupportOpts::default().xy_gap);
            paths.extend(plan_support_brim(
                &region, &disks, contours, &strategy, line_width, brim_mm, gap,
            ));
        }
        if let Some(brim) = belt_brim {
            paths.extend(plan_brim_lines(&brim.spans, brim.y, &strategy, line_width));
        }
    }
    if let Some(gentle) = settings.gentle() {
        print_gently(&mut paths, gentle);
    }
    paths
}

/// Every support path at the gentle feed and acceleration, the interface at
/// the interface feed when that is slower. The same for every support style:
/// a grid line, a tree tip, a trunk, a foot, and a brim alike. Never faster
/// than the path already was.
pub(super) fn print_gently(paths: &mut [Extrusion], gentle: Gentle) {
    for path in paths.iter_mut() {
        let speed = match path.kind {
            PathKind::SupportInterface => gentle.speed.min(GENTLE_INTERFACE_MM_S),
            PathKind::Support => gentle.speed,
            _ => continue,
        };
        path.speed = path.speed.min(speed);
        path.accel = path.accel.min(gentle.accel);
    }
}

/// How supports print when they print gently.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Gentle {
    pub speed: f64,
    pub accel: f64,
}

/// Support feed under "Print supports gently" when the request names none.
/// Half the Speed strategy's 80 mm/s support feed, and the Toughness
/// strategy's outer wall feed.
pub(crate) const GENTLE_SUPPORT_MM_S: f64 = 40.0;
/// Support acceleration under "Print supports gently" when the request
/// names none. A 40 mm/s line is at speed within 0.4 mm, so it costs almost
/// no time over the feed alone, while the head pushes a standing support
/// with under 60 % of the Speed strategy's 3500 mm/s².
pub(crate) const GENTLE_SUPPORT_ACCEL: f64 = 2000.0;
/// Support interface under "Print supports gently".
pub(super) const GENTLE_INTERFACE_MM_S: f64 = 30.0;

#[allow(clippy::too_many_arguments)]
pub(super) fn support_seed_weight(blend: &BlendMode) -> f64 {
    match blend {
        BlendMode::Single { strategy } => match strategy {
            StrategyId::Toughness => 1.0,
            StrategyId::Speed => 0.15,
        },
        BlendMode::Weight { toughness } => toughness.clamp(0.0, 1.0),
        BlendMode::ByLayer { .. } => 0.45,
        BlendMode::ByRegion { .. } => 0.55,
    }
}

/// 0 is speed, 1 is toughness. Mixed blends sit between them.
pub(super) fn support_toughness(blend: &BlendMode) -> f64 {
    match blend {
        BlendMode::Single { strategy } => match strategy {
            StrategyId::Toughness => 1.0,
            StrategyId::Speed => 0.0,
        },
        BlendMode::Weight { toughness } => toughness.clamp(0.0, 1.0),
        BlendMode::ByLayer { .. } => 0.45,
        BlendMode::ByRegion { .. } => 0.55,
    }
}

/// Interface may bridge this far to the tip that carries it.
/// Speed is 10.8 mm; toughness keeps a 3.5 mm contact grid.
pub(super) fn support_tip_spacing(blend: &BlendMode) -> f64 {
    let t = support_toughness(blend);
    (10.8 - 7.3 * t).clamp(3.2, 12.0)
}

/// Tip-units one tip-sized cross-section may carry.
/// Speed is 5.2; toughness is 1.5, so trunks stay more numerous.
pub(super) fn support_load_factor(blend: &BlendMode) -> f64 {
    let t = support_toughness(blend);
    (5.2 - 3.7 * t).clamp(1.05, 8.0)
}

#[allow(clippy::too_many_arguments)]
pub(super) fn emit_supports(
    paths: &mut Vec<Extrusion>,
    support: &[Loop],
    interface: &[Loop],
    disks: &[Disk],
    feet: &[Loop],
    shaft_scale: f64,
    layer_height: f64,
    low: &ResolvedStrategy,
    high: &ResolvedStrategy,
    split: Option<RegionSplit>,
    line_width: f64,
    through: Option<[f64; 2]>,
) {
    if support.is_empty() && interface.is_empty() && disks.is_empty() && feet.is_empty() {
        return;
    }
    let paint = |paths: &mut Vec<Extrusion>,
                 region_s: &[Loop],
                 region_i: &[Loop],
                 disks: &[Disk],
                 feet: &[Loop],
                 strategy: &ResolvedStrategy| {
        if shaft_scale > 0.0 {
            let mut sparse = if disks.is_empty() && feet.is_empty() {
                plan_support(
                    region_s,
                    strategy,
                    line_width,
                    support_density(strategy),
                    false,
                    through,
                )
            } else {
                plan_tree_support(disks, feet, strategy, line_width)
            };
            if shaft_scale > 1.01 {
                for path in &mut sparse {
                    path.bead_height = layer_height * shaft_scale;
                }
            }
            paths.extend(sparse);
        }
        paths.extend(plan_support(
            region_i,
            strategy,
            line_width,
            support_interface_density(strategy),
            true,
            None,
        ));
    };
    if let Some((low_rect, high_rect)) = split {
        // Part rects stop 2 mm outside this layer's outline. Trunks stand in
        // the air beside that outline. Plan every branch once, then cut the
        // beads on the plane, so a trunk that leans across the cut is not
        // drawn twice and a trunk outside the outline is not dropped.
        if (!disks.is_empty() || !feet.is_empty()) && shaft_scale > 0.0 {
            let mut trunks = plan_tree_support(disks, feet, low, line_width);
            if shaft_scale > 1.01 {
                for path in &mut trunks {
                    path.bead_height = layer_height * shaft_scale;
                }
            }
            if let Some((axis, at)) = split_edge(low_rect, high_rect) {
                let (low_paths, high_paths) = split_extrusions(trunks, axis, at);
                retarget_supports(paths, low_paths, low);
                retarget_supports(paths, high_paths, high);
            } else {
                paths.extend(trunks);
            }
        }
        let (low_cover, high_cover) =
            support_half_rects(support, interface, disks, low_rect, high_rect);
        for (rect, strategy) in [(low_cover, low), (high_cover, high)] {
            let Some(rect) = rect else {
                continue;
            };
            if disks.is_empty() && feet.is_empty() {
                paint(
                    paths,
                    &clip_to_rect(support, rect.0, rect.1),
                    &clip_to_rect(interface, rect.0, rect.1),
                    &[],
                    &[],
                    strategy,
                );
            } else {
                paths.extend(plan_support(
                    &clip_to_rect(interface, rect.0, rect.1),
                    strategy,
                    line_width,
                    support_interface_density(strategy),
                    true,
                    None,
                ));
            }
        }
    } else {
        paint(paths, support, interface, disks, feet, low);
    }
}

pub(super) fn retarget_supports(
    paths: &mut Vec<Extrusion>,
    side: Vec<Extrusion>,
    strategy: &ResolvedStrategy,
) {
    for mut path in side {
        path.strategy = strategy.id;
        path.speed = support_speed(strategy, false);
        path.travel_speed = strategy.travel_speed;
        path.accel = strategy.accel;
        path.retract_mm = strategy.retract_mm;
        path.retract_min_travel = strategy.retract_min_travel;
        path.fan = strategy.fan;
        path.travel_accel = if strategy.feature_speeds {
            strategy.travel_accel
        } else {
            strategy.accel
        };
        paths.push(path);
    }
}
