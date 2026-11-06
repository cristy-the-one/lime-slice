use super::brims::skirt_paths;
use super::elapsed_ms;
use super::parts::{CombLayer, Contours, Part, SupportPlan};
use super::settings::bridge_tune;
use super::tours::{hop_travels, scarf_params};
use crate::gcode::{LayerPaths, PrintLayer};
use crate::poly::{in_solid, Loop};
use crate::toolpath::{
    apply_scarf, comb_layer, order_supports, rest_on_interface, retract_off_supports, BridgeTune,
    Extrusion,
};
use crate::{BlendMode, SliceSettings, Stage, Watch};
use rayon::iter::{IndexedParallelIterator, IntoParallelIterator, ParallelIterator};
use std::sync::Arc;
use std::time::Instant;

/// One layer as `assemble` joined it, with the inputs that decided it. A
/// layer whose part, skirt, support paths, and way in are the same joins to
/// the same paths.
#[derive(Clone)]
pub(crate) struct JoinedLayer {
    /// No contour and no support: the layer prints nothing.
    pub(super) empty: bool,
    /// The part's layer, toured and combed. `None` only on a layer never
    /// joined because the slice stopped.
    pub(super) part: Option<Arc<CombLayer>>,
    pub(super) skirt: Vec<Extrusion>,
    pub(super) under: Arc<Vec<Extrusion>>,
    /// The support interface the part's hanging spans may rest on.
    pub(super) below: Vec<Vec<Loop>>,
    /// Where the nozzle stood when the layer began.
    pub(super) from: Option<[f64; 2]>,
    /// Where it stood when the layer ended.
    pub(super) end: Option<[f64; 2]>,
    /// How many leading paths of `layer` are the skirt and supports.
    pub(super) head: usize,
    pub(super) layer: PrintLayer,
}

impl JoinedLayer {
    pub(super) fn joins_like(
        &self,
        empty: bool,
        part: &Arc<CombLayer>,
        skirt: &[Extrusion],
        under: &Arc<Vec<Extrusion>>,
        below: &[Vec<Loop>],
        from: Option<[f64; 2]>,
    ) -> bool {
        let bits = |p: Option<[f64; 2]>| p.map(|p| p.map(f64::to_bits));
        self.empty == empty
            && self.part.as_ref().is_some_and(|p| Arc::ptr_eq(p, part))
            && bits(self.from) == bits(from)
            && self.skirt == skirt
            && (Arc::ptr_eq(&self.under, under) || self.under == *under)
            && self.below == below
    }

    /// The layer with the object's speed cap `cap` on its part's paths and
    /// note. A layer the cap leaves alone stays shared, arcs and all.
    pub(super) fn capped(self, cap: Option<f64>) -> PrintLayer {
        let mut layer = self.layer;
        let (Some(cap), Some(part), false) = (cap, &self.part, self.empty) else {
            return layer;
        };
        let note = part.tour.source.note_under(cap);
        let slower = |p: &Extrusion| p.cap_feed.is_some_and(|c| c.speed(cap) != p.speed);
        if note != layer.note || layer.paths.iter().any(slower) {
            layer.edit(|l| {
                l.note = note;
                for path in &mut l.paths {
                    if let Some(c) = path.cap_feed {
                        path.speed = c.speed(cap);
                    }
                }
            });
        }
        layer
    }
}

/// A layer during `assemble`: taken from the last join, or with its skirt
/// and supports ordered and the join still to finish.
pub(super) enum Slot {
    Kept(JoinedLayer),
    Fresh(JoinedLayer, Vec<Extrusion>),
}

/// The print as the G-code writer takes it, and what joining it cost.
pub(super) struct Assembled {
    pub(super) joined: Vec<JoinedLayer>,
    /// Layers taken from `kept` instead of joined again.
    pub(super) reused: u32,
    pub(super) order_ms: f64,
    pub(super) comb_ms: f64,
}

/// Joins the part and its supports layer by layer: the skirt and supports
/// first as one tour from where the nozzle stands, then the part's own tour.
/// Only the travels the supports lead into are combed and hopped here. A
/// layer of `kept`, the last join of the same part, is reused when its
/// inputs are the same.
pub(super) fn assemble(
    cut: &Contours,
    part: Part<'_>,
    supports: &SupportPlan,
    blend: &BlendMode,
    settings: &SliceSettings,
    kept: &[JoinedLayer],
    watch: &Watch,
) -> Result<Assembled, String> {
    let (bands, contours) = (&cut.bands, &cut.contours);
    watch.begin(Stage::Assemble, bands.len().max(1) as u32);
    if watch.stopped(settings.job) {
        return Err("cancelled".into());
    }
    // A layer that prints part ends where the part's tour ends, so the next
    // layer's way in is known before any support is ordered. Only a run of
    // layers without part chains one support tour to the next.
    let runs: Vec<std::ops::Range<usize>> = {
        let mut starts: Vec<usize> = (0..bands.len())
            .filter(|&i| i == 0 || part.prints(i - 1))
            .collect();
        starts.push(bands.len());
        starts.windows(2).map(|w| w[0]..w[1]).collect()
    };
    let order_started = Instant::now();
    let slots: Vec<Slot> = runs
        .into_par_iter()
        .flat_map_iter(|run| {
            let mut from = run
                .start
                .checked_sub(1)
                .and_then(|i| part.tour.layers[i].end);
            run.map(move |i| {
                if watch.stopped(settings.job) {
                    return empty_slot();
                }
                let slot = join_supports(cut, part, supports, blend, settings, kept, i, from);
                from = match &slot {
                    Slot::Kept(k) => k.end,
                    Slot::Fresh(j, _) => j.end,
                };
                watch.tick();
                slot
            })
        })
        .collect();
    if watch.stopped(settings.job) {
        return Err("cancelled".into());
    }
    let order_ms = elapsed_ms(order_started);
    let comb_started = Instant::now();
    let reused = slots
        .iter()
        .filter(|slot| matches!(slot, Slot::Kept(..)))
        .count() as u32;
    let joined: Vec<JoinedLayer> = slots
        .into_par_iter()
        .enumerate()
        .map(|(i, slot)| {
            if watch.stopped(settings.job) {
                return match slot {
                    Slot::Kept(kept) => kept,
                    Slot::Fresh(joined, _) => joined,
                };
            }
            let (mut joined, mut paths) = match slot {
                Slot::Kept(k) => return k,
                Slot::Fresh(joined, head) => (joined, head),
            };
            joined.head = paths.len();
            // The skirt and supports, and the travel into the part's first path.
            let lead = paths.len() + 1;
            if !joined.empty {
                let start = paths.len();
                paths.extend(part.combed(i));
                rest_on_support(&mut paths[start..], &joined.below, bridge_tune(settings));
            }
            let lead = lead.min(paths.len());
            if settings.travel_opt {
                comb_layer(
                    &mut paths[..lead],
                    &contours[i],
                    settings.combing,
                    settings.line_width * 0.8,
                    joined.from,
                );
                if settings.support_slow_fragile {
                    if let Some(layer) = supports.supports.layers.get(i) {
                        retract_off_supports(
                            &mut paths[..lead],
                            joined.from,
                            &layer.interface,
                            &layer.disks,
                            settings.line_width,
                        );
                    }
                }
            }
            let after_top = part.travels.layers[i].after_top;
            hop_travels(&mut paths[..lead], &contours[i], after_top, settings);
            joined.layer.set_paths(paths);
            joined
        })
        .collect();
    if watch.stopped(settings.job) {
        return Err("cancelled".into());
    }
    watch.fill();
    Ok(Assembled {
        reused,
        order_ms,
        comb_ms: elapsed_ms(comb_started),
        joined,
    })
}

/// A layer that was not joined because the slice had already stopped.
/// Discarded with the rest of the plan; never stored.
pub(super) fn empty_slot() -> Slot {
    Slot::Kept(JoinedLayer {
        empty: true,
        part: None,
        skirt: Vec::new(),
        under: Arc::new(Vec::new()),
        below: Vec::new(),
        from: None,
        end: None,
        head: 0,
        layer: PrintLayer::new(LayerPaths {
            index: 0,
            z: 0.0,
            height: 0.0,
            paths: Vec::new(),
            note: String::new(),
        }),
    })
}

/// Layer `i`'s skirt and supports, ordered from `from`, or the kept layer
/// when nothing it was joined from changed.
#[allow(clippy::too_many_arguments)]
pub(super) fn join_supports(
    cut: &Contours,
    part: Part<'_>,
    supports: &SupportPlan,
    blend: &BlendMode,
    settings: &SliceSettings,
    kept: &[JoinedLayer],
    i: usize,
    from: Option<[f64; 2]>,
) -> Slot {
    let band = &cut.bands[i];
    let contour = &cut.contours[i];
    let support = supports.supports.layers.get(i);
    let unsupported =
        support.is_none_or(|s| s.sparse.is_empty() && s.interface.is_empty() && s.disks.is_empty());
    let under = &supports.paths[i];
    // A belt brim can lie on a layer with no support of its own.
    let empty = contour.is_empty() && unsupported && under.is_empty();
    let skirt = if band.index == 0 && !empty {
        skirt_paths(contour, support, band.z, blend, settings)
    } else {
        Vec::new()
    };
    let own = &part.travels.layers[i];
    let below = if settings.overhang_control && settings.hanging_rows {
        interface_below(cut, supports, settings, i)
    } else {
        Vec::new()
    };
    if let Some(k) = kept
        .get(i)
        .filter(|k| k.joins_like(empty, own, &skirt, under, &below, from))
    {
        return Slot::Kept(k.clone());
    }
    let mut head = Vec::new();
    let mut end = from;
    if !empty {
        head.extend(skirt.iter().cloned());
        head.extend(under.iter().cloned());
        let scarf = scarf_params(settings, band.index);
        if settings.travel_opt {
            let to = (part.prints(i))
                .then(|| {
                    own.tour
                        .paths
                        .iter()
                        .find_map(|p| p.points.first().copied())
                })
                .flatten();
            end = order_supports(&mut head, from, to, scarf.as_ref());
        } else if let Some(params) = scarf {
            apply_scarf(&mut head, &params);
        }
        if part.prints(i) {
            end = own.tour.end;
        }
    }
    let note = if empty {
        "empty".into()
    } else {
        part.paths.layers[i].note.clone()
    };
    let layer = LayerPaths {
        index: band.index,
        z: band.z,
        height: band.height,
        paths: Vec::new(),
        note,
    };
    let joined = JoinedLayer {
        empty,
        part: Some(Arc::clone(own)),
        skirt,
        under: Arc::clone(under),
        below,
        from,
        end,
        head: 0,
        layer: PrintLayer::new(layer),
    };
    Slot::Fresh(joined, head)
}

/// The Z gap between a support's interface and the part it holds.
pub(super) fn support_z_gap(settings: &SliceSettings) -> f64 {
    settings
        .support_z_gap_mm
        .unwrap_or_else(|| settings.layer_height.max(0.12))
}

/// The support interface under layer `i` that its hanging spans rest on:
/// that of each layer down through the Z gap, one interface layer deep.
pub(super) fn interface_below(
    cut: &Contours,
    supports: &SupportPlan,
    settings: &SliceSettings,
    i: usize,
) -> Vec<Vec<Loop>> {
    let bands = &cut.bands;
    let reach = bands[i].z - bands[i].height - support_z_gap(settings);
    let layers = &supports.supports.layers;
    (i.saturating_sub(4)..i)
        .rev()
        .take_while(|&k| bands[k].z >= reach - bands[k].height * 0.5)
        .filter_map(|k| layers.get(k))
        .filter(|layer| !layer.interface.is_empty())
        .map(|layer| layer.interface.clone())
        .collect()
}

/// Print the part's hanging spans that rest mostly on support interface
/// like bridges: the interface holds them up no better than air.
pub(super) fn rest_on_support(
    paths: &mut [Extrusion],
    below: &[Vec<Loop>],
    tune: Option<BridgeTune>,
) {
    if below.is_empty() {
        return;
    }
    for path in paths.iter_mut().filter(|p| p.on_overhang) {
        let (mut on, mut all) = (0.0, 0.0);
        for w in path.points.windows(2) {
            let len = ((w[1][0] - w[0][0]).powi(2) + (w[1][1] - w[0][1]).powi(2)).sqrt();
            let mid = [(w[0][0] + w[1][0]) * 0.5, (w[0][1] + w[1][1]) * 0.5];
            all += len;
            if below.iter().any(|loops| in_solid(loops, mid[0], mid[1])) {
                on += len;
            }
        }
        if all > 0.0 && on * 2.0 >= all {
            rest_on_interface(path, tune);
        }
    }
}
