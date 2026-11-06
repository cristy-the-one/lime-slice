use super::brims::skirt_paths;
use super::elapsed_ms;
use super::layer::object_layer;
use super::parts::{
    CombLayer, Contours, ObjectLayer, PartPaths, PartTour, PartTravels, TourLayer, Travel,
};
use super::regions::keep_side;
use super::resolve::{interior_remainings, resolve, InteriorSpan};
use super::settings::bridge_tune;
use super::zones::{grow_lightning, layer_footprints, layer_strategy};
use crate::lightning::{Branches, Hollow};
use crate::modifiers::Overrides;
use crate::poly::{boolean_diff, boolean_intersect, loop_bounds, offset_loops, Loop};
use crate::strategy::{pure, ResolvedStrategy};
use crate::toolpath::{
    apply_overhang, apply_scarf, apply_z_hop, comb_layer, order_supports, plan_ironing, Extrusion,
    PartLayout, ScarfParams,
};
use crate::{
    BlendMode, Ironing, PathKind, ScarfSeam, SliceSettings, Stage, StrategyId, Watch, ZHopMode,
};
use rayon::iter::{
    IndexedParallelIterator, IntoParallelIterator, IntoParallelRefIterator, ParallelIterator,
};
use sha2::{Digest, Sha256};
use std::sync::atomic::{AtomicBool, Ordering as AtomicOrdering};
use std::sync::Arc;
use std::time::Instant;

/// Every layer's walls, infill, and skin, with overhangs split, and the
/// ironing over each roof. A layer of `kept`, planned under the same `base`,
/// is taken as it is when its own inputs are the same.
pub(super) fn part_paths(
    cut: &Contours,
    blend: &BlendMode,
    settings: &SliceSettings,
    nozzle_diameter: f64,
    base: [u8; 32],
    kept: Option<&PartPaths>,
    watch: &Watch,
) -> Result<PartPaths, String> {
    let (bands, contours) = (&cut.bands, &cut.contours);
    let (min, max) = cut.bounds;
    watch.begin(Stage::Part, bands.len().max(1) as u32);
    if watch.stopped(settings.job) {
        return Err("cancelled".into());
    }
    let prep_started = Instant::now();
    let (remain_low, remain_high) = interior_remainings(blend, settings, bands, &cut.skins);
    let lightning = grow_lightning(cut, blend, settings);
    let prep_ms = elapsed_ms(prep_started);
    let toolpath_started = Instant::now();
    let kept = kept.filter(|k| k.base == base);
    let planned: Vec<([u8; 32], Arc<ObjectLayer>, bool)> = bands
        .par_iter()
        .enumerate()
        .map(|(i, band)| {
            let ironing = settings.ironing.filter(|_| cut.roofs[i] == 0.0);
            let inputs = cut_inputs(
                cut,
                i,
                settings,
                ironing.is_some(),
                (remain_low[i], remain_high[i]),
                lightning
                    .as_ref()
                    .map(|l| (&l.layers[i], &l.hollow_below[i])),
                layer_inputs(
                    &settings.overrides,
                    band.z,
                    &contours[i],
                    ironing,
                    &settings.reinforcement,
                ),
            );
            if let Some(kept) = kept.filter(|k| k.inputs.get(i) == Some(&inputs)) {
                watch.tick();
                return (inputs, Arc::clone(&kept.layers[i]), true);
            }
            if watch.stopped(settings.job) {
                let layer = ObjectLayer {
                    paths: Vec::new(),
                    note: String::new(),
                    shown_speed: None,
                    wall_ms: 0.0,
                    infill_ms: 0.0,
                };
                return (inputs, Arc::new(layer), false);
            }
            let mut layer = object_layer(
                band.index,
                band.z,
                band.height,
                &contours[i],
                blend,
                settings,
                [&cut.skins[0][i], &cut.skins[1][i]],
                cut.roofs[i],
                min,
                max,
                nozzle_diameter,
                remain_low[i],
                remain_high[i],
                lightning.as_ref().map(|l| (l, i)),
            );
            if settings.overhang_control && i > 0 {
                apply_overhang(
                    &mut layer.paths,
                    &contours[i - 1],
                    band.height,
                    settings.line_width,
                    bridge_tune(settings),
                    settings.hanging_rows,
                );
            }
            if let Some(ironing) = ironing {
                layer
                    .paths
                    .extend(iron_layer(cut, i, blend, settings, &ironing));
            }
            watch.tick();
            (inputs, Arc::new(layer), false)
        })
        .collect();
    let toolpath_ms = elapsed_ms(toolpath_started);
    if watch.stopped(settings.job) {
        return Err("cancelled".into());
    }
    watch.fill();
    let fresh = || planned.iter().filter(|p| !p.2).map(|p| &p.1);
    Ok(PartPaths {
        wall_cpu_ms: fresh().map(|l| l.wall_ms).sum(),
        infill_cpu_ms: fresh().map(|l| l.infill_ms).sum(),
        reused: planned.iter().filter(|p| p.2).count() as u32,
        inputs: planned.iter().map(|p| p.0).collect(),
        layers: planned.into_iter().map(|p| p.1).collect(),
        base,
        toolpath_ms,
        prep_ms,
    })
}

/// The inputs of the layer at `z` with `contours` that differ from layer to
/// layer, hashed: the range over it, the volumes that can reach it, and its
/// ironing, which only a roof has. Every other input of a layer's toolpaths
/// is the same for all layers of a plan.
pub(super) fn layer_inputs(
    overrides: &Overrides,
    z: f64,
    contours: &[Loop],
    ironing: Option<Ironing>,
    reinforcement: &[crate::reinforcement::Region],
) -> [u8; 32] {
    let range = overrides.range_at(z);
    let prints = layer_footprints(overrides, z, contours);
    // The text with an empty reinforcement list is the one a slice without
    // the field hashed. A layer the columns miss keeps that text, so it can
    // be reused. A layer they meet appends the sections.
    let mut text = format!("{range:?}|{prints:?}|{ironing:?}");
    if !reinforcement.is_empty() {
        if let Some((lo, hi)) = loop_bounds(contours) {
            let stamp = reinforcement
                .iter()
                .filter_map(|region| {
                    let sections = region.sections(z);
                    let meets = loop_bounds(&sections).is_some_and(|(a, b)| {
                        a[0] <= hi[0] && b[0] >= lo[0] && a[1] <= hi[1] && b[1] >= lo[1]
                    });
                    meets.then(|| format!("{}:{:.6}:{sections:?}", region.index, region.density))
                })
                .collect::<Vec<_>>();
            if !stamp.is_empty() {
                text.push('|');
                text.push_str(&stamp.join(";"));
            }
        }
    }
    Sha256::digest(text).into()
}

/// Every input of layer `i`'s toolpaths that comes from the cut, hashed with
/// `inputs`, the ones `layer_inputs` hashes: its band, its outline, the ones
/// below and above it when overhangs or ironing read them, its skins, its
/// distance below a roof, its interior runs, and its lightning branches with
/// the hollow under them. Two plans whose toolpath keys leave the mesh out, as
/// the layer keys do, plan the same paths on a layer with the same hash, so an
/// edit to the mesh replans only the layers it reaches.
#[allow(clippy::too_many_arguments)]
pub(super) fn cut_inputs(
    cut: &Contours,
    i: usize,
    settings: &SliceSettings,
    ironed: bool,
    remain: (InteriorSpan, InteriorSpan),
    lightning: Option<(&Branches, &Hollow)>,
    inputs: [u8; 32],
) -> [u8; 32] {
    fn points(hash: &mut Sha256, loops: &[Loop]) {
        hash.update((loops.len() as u64).to_le_bytes());
        for l in loops {
            hash.update((l.len() as u64).to_le_bytes());
            for p in l {
                hash.update(p[0].to_bits().to_le_bytes());
                hash.update(p[1].to_bits().to_le_bytes());
            }
        }
    }
    let mut hash = Sha256::new();
    hash.update(inputs);
    let band = &cut.bands[i];
    hash.update((band.index as u64).to_le_bytes());
    hash.update(band.z.to_bits().to_le_bytes());
    hash.update(band.height.to_bits().to_le_bytes());
    points(&mut hash, &cut.contours[i]);
    let near = |k: Option<usize>| k.and_then(|k| cut.contours.get(k));
    if settings.overhang_control {
        hash.update(b"|below|");
        points(&mut hash, near(i.checked_sub(1)).map_or(&[], Vec::as_slice));
    }
    if ironed {
        hash.update(b"|above|");
        points(&mut hash, near(Some(i + 1)).map_or(&[], Vec::as_slice));
    }
    for skins in &cut.skins {
        points(&mut hash, &skins[i].bottom);
        points(&mut hash, &skins[i].top);
    }
    hash.update(cut.roofs[i].to_bits().to_le_bytes());
    hash.update(format!("{remain:?}"));
    if let Some((branches, hollow)) = lightning {
        hash.update(b"|lightning|");
        for [a, b] in branches.iter() {
            for c in [a[0], a[1], b[0], b[1]] {
                hash.update(c.to_bits().to_le_bytes());
            }
        }
        hash.update(b"|hollow|");
        points(&mut hash, hollow);
    }
    hash.finalize().into()
}

/// Ironing over layer `i`'s top surface: what the layer above leaves open,
/// within the outline inset by half a line width. Ranges and volumes do not
/// change it.
pub(super) fn iron_layer(
    cut: &Contours,
    i: usize,
    blend: &BlendMode,
    settings: &SliceSettings,
    ironing: &Ironing,
) -> Vec<Extrusion> {
    let contours = &cut.contours[i];
    let open = match cut.contours.get(i + 1) {
        Some(above) if !above.is_empty() => boolean_diff(contours, above),
        _ => contours.clone(),
    };
    let area = boolean_intersect(&open, &offset_loops(contours, -settings.line_width * 0.5));
    if area.is_empty() {
        return Vec::new();
    }
    let iron =
        |strategy: &ResolvedStrategy| plan_ironing(&area, strategy, settings.line_width, ironing);
    match blend {
        BlendMode::ByRegion { axis, at_mm } => {
            let tough = iron(&resolve(pure(StrategyId::Toughness), settings));
            let speed = iron(&resolve(pure(StrategyId::Speed), settings));
            let mut paths = keep_side(tough, *axis, *at_mm, true);
            paths.extend(keep_side(speed, *axis, *at_mm, false));
            paths
        }
        other => iron(&layer_strategy(other, cut.bands[i].z, settings)),
    }
}

/// Orders each layer of the part as one tour, starting where the part's
/// tour on the layer below ended. The tour never sees the supports, so
/// editing them leaves it alone. A layer of `kept`, toured under the same
/// `base`, is taken as it is when it toured the same paths from the same
/// point.
///
/// The first layer's tour starts where a skirt around the part alone would
/// end. That is where the skirt really ends when no support stands on the
/// first layer, so a print without supports orders as it always did.
#[allow(clippy::too_many_arguments)]
pub(super) fn tour_part(
    cut: &Contours,
    part: &PartPaths,
    blend: &BlendMode,
    settings: &SliceSettings,
    base: [u8; 32],
    kept: Option<&PartTour>,
    watch: &Watch,
) -> Result<PartTour, String> {
    let (bands, contours) = (&cut.bands, &cut.contours);
    let order_started = Instant::now();
    watch.begin(Stage::Travel, bands.len().max(1) as u32);
    if watch.stopped(settings.job) {
        return Err("cancelled".into());
    }
    let kept = kept.filter(|k| k.base == base);
    let same_paths = |i: usize| {
        kept.and_then(|k| k.layers.get(i))
            .filter(|k| Arc::ptr_eq(&k.source, &part.layers[i]))
    };
    let bits = |p: Option<[f64; 2]>| p.map(|p| p.map(f64::to_bits));
    let mut reused = 0;
    let layers: Vec<Arc<TourLayer>> = if settings.travel_opt {
        // Every layer from the first with new paths up may start somewhere
        // new, so each is laid out up front, in parallel, and the serial pass
        // only tours. Layers below it start where they did before.
        let first = (0..bands.len())
            .find(|&i| same_paths(i).is_none())
            .unwrap_or(bands.len());
        // A layer with kept paths is toured again only when it starts somewhere
        // new, which an edit below it seldom causes: it is laid out then.
        let layout_sample = crate::inner_prof::Sample::start();
        let mut laid: Vec<Option<PartLayout>> = part
            .layers
            .par_iter()
            .enumerate()
            .map(|(i, l)| {
                (i >= first && same_paths(i).is_none())
                    .then(|| PartLayout::new(l.paths.clone(), &contours[i]))
            })
            .collect();
        layout_sample.tour_layout(laid.iter().flatten().count() as u64);
        let held: Vec<Option<Option<[f64; 2]>>> = (0..bands.len())
            .map(|i| same_paths(i).map(|k| k.end))
            .collect();
        let mut end = bands.first().filter(|b| b.index == 0).and_then(|b| {
            let mut skirt = skirt_paths(&contours[0], None, b.z, blend, settings);
            order_supports(&mut skirt, None, None, scarf_params(settings, 0).as_ref())
        });
        let guess_sample = crate::inner_prof::Sample::start();
        let below = match first {
            0 => Some(end),
            i => same_paths(i - 1).map(|k| k.end),
        };
        let mut guessed = if SERIAL_TOUR.load(AtomicOrdering::Relaxed) {
            Vec::new()
        } else {
            guess_tours(&laid, &held, first, below, |i| {
                (!watch.stopped(settings.job)).then(|| scarf_params(settings, bands[i].index))
            })
        };
        guess_sample.tour_guess(guessed.iter().flatten().count() as u64);
        let mut toured = 0;
        let serial_sample = crate::inner_prof::Sample::start();
        let mut layers = Vec::with_capacity(bands.len());
        for (i, source) in part.layers.iter().enumerate() {
            if watch.stopped(settings.job) {
                return Err("cancelled".into());
            }
            let layer = match same_paths(i).filter(|k| bits(k.from) == bits(end)) {
                Some(k) => {
                    reused += 1;
                    Arc::clone(k)
                }
                None => {
                    let guess = guessed
                        .get_mut(i)
                        .and_then(Option::take)
                        .filter(|g| bits(g.from) == bits(end));
                    let (paths, to) = match guess {
                        Some(g) => (g.paths, g.end),
                        None => {
                            toured += 1;
                            let layout = laid[i].take().unwrap_or_else(|| {
                                PartLayout::new(source.paths.clone(), &contours[i])
                            });
                            let scarf = scarf_params(settings, bands[i].index);
                            layout.tour(end, scarf.as_ref())
                        }
                    };
                    Arc::new(TourLayer {
                        source: Arc::clone(source),
                        from: end,
                        paths,
                        end: to,
                    })
                }
            };
            end = layer.end;
            layers.push(layer);
            watch.tick();
        }
        serial_sample.tour_serial(toured);
        layers
    } else {
        let toured: Vec<(Arc<TourLayer>, bool)> = part
            .layers
            .par_iter()
            .enumerate()
            .map(|(i, source)| {
                if let Some(k) = same_paths(i) {
                    watch.tick();
                    return (Arc::clone(k), true);
                }
                let mut paths = Vec::new();
                if !watch.stopped(settings.job) {
                    paths = source.paths.clone();
                    if let Some(params) = scarf_params(settings, bands[i].index) {
                        apply_scarf(&mut paths, &params);
                    }
                    crate::toolpath::apply_fuzzy_skin(&mut paths);
                }
                watch.tick();
                let layer = TourLayer {
                    source: Arc::clone(source),
                    from: None,
                    paths,
                    end: None,
                };
                (Arc::new(layer), false)
            })
            .collect();
        if watch.stopped(settings.job) {
            return Err("cancelled".into());
        }
        reused = toured.iter().filter(|t| t.1).count() as u32;
        toured.into_iter().map(|t| t.0).collect()
    };
    watch.fill();
    Ok(PartTour {
        layers,
        base,
        reused,
        order_ms: elapsed_ms(order_started),
    })
}

/// Test hook: tour every layer in the serial pass, with no guesses.
pub(super) static SERIAL_TOUR: AtomicBool = AtomicBool::new(false);

#[cfg(test)]
pub(crate) fn set_serial_tour_for_test(on: bool) {
    SERIAL_TOUR.store(on, AtomicOrdering::Relaxed);
}

/// A layer toured ahead of the serial pass, from where the layer below was
/// guessed to end.
pub(super) struct Guess {
    pub(super) from: Option<[f64; 2]>,
    pub(super) paths: Vec<Extrusion>,
    pub(super) end: Option<[f64; 2]>,
}

/// Each laid-out layer from `first` up toured in parallel from a guess of
/// where the tour below it ends. `below` is where the tour into `first`
/// starts, when it is known. `held` is where each kept layer ended, which is
/// where it ends again from the same start.
///
/// Most layers end in the same place whatever point they start from, so the
/// guess is where the layer below ends when toured from no point at all. A
/// layer with no paths ends where it starts, so it passes the guess on. The
/// serial pass keeps a guessed layer only when its real start equals the
/// guess bit for bit, and tours the rest itself: a kept guess is the tour the
/// same code makes from the same point, so the output is the serial tour's.
///
/// `scarf` gives a layer's scarf, or `None` once the slice is cancelled.
pub(super) fn guess_tours(
    laid: &[Option<PartLayout>],
    held: &[Option<Option<[f64; 2]>>],
    first: usize,
    below: Option<Option<[f64; 2]>>,
    scarf: impl Fn(usize) -> Option<Option<ScarfParams>> + Sync,
) -> Vec<Option<Guess>> {
    if laid.len() < first + 2 || rayon::current_num_threads() < 2 {
        return Vec::new();
    }
    let free_ends: Vec<Option<Option<[f64; 2]>>> = laid
        .par_iter()
        .enumerate()
        .map(|(i, l)| match l.as_ref().filter(|_| i + 1 < laid.len()) {
            Some(l) => Some(l.clone().tour(None, scarf(i)?.as_ref()).1),
            None => held.get(i).copied().flatten(),
        })
        .collect();
    let mut starts: Vec<Option<Option<[f64; 2]>>> = vec![None; laid.len()];
    starts[first] = below;
    for i in first + 1..laid.len() {
        starts[i] = match free_ends[i - 1] {
            Some(None) => starts[i - 1],
            end => end,
        };
    }
    let guess = |i: usize, from: Option<[f64; 2]>| {
        let l = laid[i].as_ref()?;
        let (paths, end) = l.clone().tour(from, scarf(i)?.as_ref());
        Some(Guess { from, paths, end })
    };
    let mut guesses: Vec<Option<Guess>> = starts
        .into_par_iter()
        .enumerate()
        .map(|(i, from)| guess(i, from?))
        .collect();
    // A layer whose guess started from the wrong point is toured again from
    // where the guess below it ends, while each round at least halves them.
    let bits = |p: Option<[f64; 2]>| p.map(|p| p.map(f64::to_bits));
    let mut last = laid.len() - first;
    for _ in 0..GUESS_ROUNDS {
        let stale: Vec<(usize, Option<[f64; 2]>)> = (first + 1..laid.len())
            .filter_map(|i| {
                let below = guesses[i - 1].as_ref()?.end;
                let held = guesses[i].as_ref().map(|g| g.from);
                (held.map(bits) != Some(bits(below))).then_some((i, below))
            })
            .collect();
        if stale.len() < GUESS_ROUND_MIN || 2 * stale.len() > last {
            break;
        }
        last = stale.len();
        let again: Vec<(usize, Option<Guess>)> = stale
            .into_par_iter()
            .map(|(i, from)| (i, guess(i, from)))
            .collect();
        for (i, g) in again {
            guesses[i] = g;
        }
    }
    guesses
}

/// Rounds of guesses after the first, and the fewest wrong starts a round
/// is worth.
pub(super) const GUESS_ROUNDS: usize = 8;
pub(super) const GUESS_ROUND_MIN: usize = 16;

/// Combs and hops the travels between the part's paths on each layer. The
/// travel into a layer's first path depends on what prints before it, so
/// `assemble` decides that one. A layer of `kept`, combed under the same
/// `base`, is taken as it is when it combed the same tour after the same
/// kind of layer.
pub(super) fn comb_part(
    cut: &Contours,
    tour: &PartTour,
    settings: &SliceSettings,
    base: [u8; 32],
    kept: Option<&PartTravels>,
    watch: &Watch,
) -> Result<PartTravels, String> {
    let comb_started = Instant::now();
    let contours = &cut.contours;
    let kept = kept.filter(|k| k.base == base);
    let tops: Vec<bool> = tour.layers.iter().map(|l| has_top(&l.paths)).collect();
    let combed: Vec<(Arc<CombLayer>, bool)> = tour
        .layers
        .par_iter()
        .enumerate()
        .map(|(i, layer)| {
            let after_top = i > 0 && tops[i - 1];
            let same = kept
                .and_then(|k| k.layers.get(i))
                .filter(|k| Arc::ptr_eq(&k.tour, layer) && k.after_top == after_top);
            if let Some(k) = same {
                return (Arc::clone(k), true);
            }
            let mut travels = Vec::new();
            if !watch.stopped(settings.job) {
                let mut paths = layer.paths.clone();
                if settings.travel_opt {
                    comb_layer(
                        &mut paths,
                        &contours[i],
                        settings.combing,
                        settings.line_width * 0.8,
                        None,
                    );
                }
                hop_travels(&mut paths, &contours[i], after_top, settings);
                travels = paths.into_iter().map(Travel::of).collect();
            }
            let layer = CombLayer {
                tour: Arc::clone(layer),
                after_top,
                travels,
            };
            (Arc::new(layer), false)
        })
        .collect();
    if watch.stopped(settings.job) {
        return Err("cancelled".into());
    }
    Ok(PartTravels {
        reused: combed.iter().filter(|c| c.1).count() as u32,
        layers: combed.into_iter().map(|c| c.0).collect(),
        base,
        comb_ms: elapsed_ms(comb_started),
    })
}

pub(super) fn has_top(paths: &[Extrusion]) -> bool {
    paths.iter().any(|p| p.kind == PathKind::Top)
}

/// Z-hop on the travels between `paths`, which start a layer.
pub(super) fn hop_travels(
    paths: &mut [Extrusion],
    solid: &[Loop],
    after_top: bool,
    settings: &SliceSettings,
) {
    if settings.z_hop == ZHopMode::Off || settings.z_hop_height <= 1e-6 || paths.len() < 2 {
        return;
    }
    let infill = offset_loops(solid, -settings.line_width * 2.2);
    apply_z_hop(
        paths,
        solid,
        &infill,
        settings.z_hop,
        settings.z_hop_height,
        settings.z_hop_min_travel,
        after_top,
    );
}

pub(super) fn scarf_params(settings: &SliceSettings, layer_index: usize) -> Option<ScarfParams> {
    (settings.scarf_seam != ScarfSeam::Off).then_some(ScarfParams {
        mode: settings.scarf_seam,
        length: settings.scarf_length,
        steps: settings.scarf_steps,
        start_height: settings.scarf_start_height,
        start_flow: settings.scarf_start_flow,
        layer_index,
    })
}
