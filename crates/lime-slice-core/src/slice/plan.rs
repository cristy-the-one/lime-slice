use super::assemble::{assemble, Assembled};
use super::belt::tilt_preview;
use super::parts::{edit, Contours, Edits, Part, PartPaths, PartTour, PartTravels, SupportPlan};
use super::preview_paths::preview_of;
use super::supports::plan_supports;
use super::tours::{comb_part, part_paths, tour_part};
use super::{elapsed_ms, kept, patch, plate};
use crate::adaptive::{plan_bands, HeightOpts, LayerBand};
use crate::gcode::{Entry, LayerPaths, PlateLayer, PrintLayer, Run};
use crate::index::ZIndex;
use crate::poly::{simplify_loops, Loop};
use crate::support::edit::EditOutcome;
use crate::support::{FloorPlane, Supports};
use crate::{
    BlendMode, CoverageGap, InAir, Mesh, PreviewLayer, PrinterProfile, SliceSettings, Stage, Watch,
};
use rayon::iter::{IntoParallelIterator, IntoParallelRefIterator, ParallelIterator};
use std::sync::Arc;
use std::time::Instant;

/// Everything `plan` derives from the mesh. `layers` is what the G-code writer
/// consumes; the rest is kept for the audit and the response.
pub(crate) struct Plan {
    pub layers: Vec<PrintLayer>,
    /// How many leading paths of each layer are its skirt and supports.
    pub heads: Vec<usize>,
    pub cut: Arc<Contours>,
    pub supports: Arc<Supports>,
    pub coverage: Vec<CoverageGap>,
    pub in_air: Option<InAir>,
    /// What each requested support edit did, in request order.
    pub outcomes: Vec<EditOutcome>,
    pub reuse: Reuse,
    pub spent: Spent,
    pub layers_reused: u32,
    /// Set when the plan came from the kept stages.
    pub kept: Option<KeptPlan>,
}

/// What a plan from the kept stages adds to its plate's preview token.
pub(crate) struct KeptPlan {
    /// Names the plan.
    pub(super) key: [u8; 32],
    /// The cut's key. A preview patches only one drawn from the same cuts.
    pub(super) contours: [u8; 32],
}

/// The stages a plan took from the kept slices instead of computing them.
#[derive(Clone, Copy, Default)]
pub(crate) struct Reuse {
    pub contours: bool,
    pub toolpaths: bool,
    pub order: bool,
    pub comb: bool,
    /// The supports as grown, before painting.
    pub supports: bool,
    pub support_paths: bool,
    /// Leading edits whose result was already applied.
    pub edits: u32,
    /// Layers a part stage computed again took from a kept plan.
    pub toolpath_layers: u32,
    pub order_layers: u32,
    pub comb_layers: u32,
}

impl Reuse {
    /// The reused stages, as `StageTimes.reused` names them.
    pub(super) fn names(&self) -> Vec<&'static str> {
        [
            (self.contours, "contours"),
            (self.toolpaths, "toolpaths"),
            (self.order, "order"),
            (self.comb, "comb"),
            (self.supports, "supports"),
            (self.support_paths, "supportPaths"),
        ]
        .into_iter()
        .filter_map(|(on, name)| on.then_some(name))
        .collect()
    }

    /// The stages both plans reused.
    pub(super) fn both(self, other: Reuse) -> Reuse {
        Reuse {
            contours: self.contours && other.contours,
            toolpaths: self.toolpaths && other.toolpaths,
            order: self.order && other.order,
            comb: self.comb && other.comb,
            supports: self.supports && other.supports,
            support_paths: self.support_paths && other.support_paths,
            edits: self.edits.min(other.edits),
            toolpath_layers: self.toolpath_layers.min(other.toolpath_layers),
            order_layers: self.order_layers.min(other.order_layers),
            comb_layers: self.comb_layers.min(other.comb_layers),
        }
    }
}

/// Wall-clock and CPU time of the stages a plan computed. A reused stage
/// adds nothing.
#[derive(Clone, Copy, Default)]
pub(crate) struct Spent {
    pub contour_ms: f64,
    pub index_ms: f64,
    pub cut_cpu_ms: f64,
    pub simplify_cpu_ms: f64,
    pub roof_ms: f64,
    pub support_ms: f64,
    pub toolpath_ms: f64,
    pub order_ms: f64,
    pub comb_ms: f64,
    pub wall_cpu_ms: f64,
    pub infill_cpu_ms: f64,
    pub prep_ms: f64,
    pub edit_apply_ms: f64,
    pub edit_refresh_ms: f64,
}

impl Spent {
    pub(super) fn add(&mut self, other: &Spent) {
        self.contour_ms += other.contour_ms;
        self.index_ms += other.index_ms;
        self.cut_cpu_ms += other.cut_cpu_ms;
        self.simplify_cpu_ms += other.simplify_cpu_ms;
        self.roof_ms += other.roof_ms;
        self.support_ms += other.support_ms;
        self.toolpath_ms += other.toolpath_ms;
        self.order_ms += other.order_ms;
        self.comb_ms += other.comb_ms;
        self.wall_cpu_ms += other.wall_cpu_ms;
        self.infill_cpu_ms += other.infill_cpu_ms;
        self.prep_ms += other.prep_ms;
        self.edit_apply_ms += other.edit_apply_ms;
        self.edit_refresh_ms += other.edit_refresh_ms;
    }

    pub(super) fn cut(&mut self, cut: &Contours) {
        let c = &cut.clocks;
        self.contour_ms += c.contour_ms;
        self.index_ms += c.index_ms;
        self.cut_cpu_ms += c.cut_cpu_ms;
        self.simplify_cpu_ms += c.simplify_cpu_ms;
        self.roof_ms += c.roof_ms;
    }

    pub(super) fn toolpaths(&mut self, part: &PartPaths) {
        self.toolpath_ms += part.toolpath_ms;
        self.wall_cpu_ms += part.wall_cpu_ms;
        self.infill_cpu_ms += part.infill_cpu_ms;
        self.prep_ms += part.prep_ms;
    }

    pub(super) fn supports(&mut self, plan: &SupportPlan) {
        self.support_ms += plan.support_ms;
        self.toolpath_ms += plan.toolpath_ms;
    }
}

/// A sixteenth of the nozzle: 0.025 mm for a 0.4 mm nozzle. Two outlines
/// closer than twice this could touch after simplifying, and a gap that
/// narrow is far below anything the nozzle prints. The raw cut of a dense
/// mesh carries a vertex every few microns, and every boolean after it pays
/// for them.
pub fn outline_tolerance_mm(nozzle_diameter: f64) -> f64 {
    let nozzle = if nozzle_diameter.is_finite() && nozzle_diameter > 0.0 {
        nozzle_diameter
    } else {
        0.4
    };
    nozzle / 16.0
}

pub(super) fn outline_tolerance(settings: &SliceSettings, nozzle_diameter: f64) -> f64 {
    if !settings.simplify {
        0.0
    } else if settings.simplify_error_mm > 0.0 {
        settings.simplify_error_mm
    } else {
        outline_tolerance_mm(nozzle_diameter)
    }
}

/// Slice the part, plan its supports, apply the settings' edits, and join
/// them. An interactive slice with kept stages on starts from what memory
/// already holds.
pub(crate) fn plan(
    mesh: &Mesh,
    blend: &BlendMode,
    settings: &SliceSettings,
    nozzle_diameter: f64,
) -> Result<Plan, String> {
    plan_sharing(
        mesh,
        blend,
        settings,
        plan_bands(mesh, &height_opts(settings))?,
        nozzle_diameter,
        &mut None,
        &Watch::idle(),
    )
}

/// How the layer settings ask for bands.
pub(super) fn height_opts(settings: &SliceSettings) -> HeightOpts {
    HeightOpts {
        nominal: settings.layer_height,
        adaptive: settings.adaptive,
        min_h: settings.adaptive_min,
        max_h: if settings.adaptive {
            settings.adaptive_max.max(settings.adaptive_min)
        } else {
            settings.layer_height
        },
    }
}

/// `plan` on `bands`, cutting the mesh only when `shared` holds no cut of it
/// yet, and leaving this plan's cut there. The side plans of one request
/// (baseline, compare, Pareto) cut the same mesh with the same layer
/// settings, and the cut does not depend on the blend.
#[allow(clippy::too_many_arguments)]
pub(super) fn plan_sharing(
    mesh: &Mesh,
    blend: &BlendMode,
    settings: &SliceSettings,
    bands: Vec<LayerBand>,
    nozzle_diameter: f64,
    shared: &mut Option<Arc<Contours>>,
    watch: &Watch,
) -> Result<Plan, String> {
    let keys = kept_keys(mesh, &bands, blend, settings, nozzle_diameter, None);
    let (cut, reused) = cut_object(
        mesh,
        bands,
        settings,
        nozzle_diameter,
        keys.as_ref(),
        shared,
        watch,
    )?;
    plan_object(
        cut,
        reused,
        keys,
        blend,
        settings,
        nozzle_diameter,
        &[],
        None,
        None,
        watch,
    )
}

/// The stage keys of an interactive slice while stages are kept.
/// `floor` is mixed into the support keys only when it is set, so a
/// cartesian slice keeps the key bytes it had.
pub(super) fn kept_keys(
    mesh: &Mesh,
    bands: &[LayerBand],
    blend: &BlendMode,
    settings: &SliceSettings,
    nozzle_diameter: f64,
    floor: Option<FloorPlane>,
) -> Option<kept::Keys> {
    (kept::on() && settings.include_preview)
        .then(|| kept::keys(mesh, bands, blend, settings, nozzle_diameter, floor))
}

/// The mesh cut on `bands`: kept under `keys`, else the cut in `shared`,
/// else cut now. `shared` holds it afterwards. The flag says it was not cut
/// by this call.
#[allow(clippy::too_many_arguments)]
pub(super) fn cut_object(
    mesh: &Mesh,
    bands: Vec<LayerBand>,
    settings: &SliceSettings,
    nozzle_diameter: f64,
    keys: Option<&kept::Keys>,
    shared: &mut Option<Arc<Contours>>,
    watch: &Watch,
) -> Result<(Arc<Contours>, bool), String> {
    let mut reused = false;
    let cut = match (keys, shared.as_ref()) {
        (Some(keys), _) => kept::stage(&keys.contours, &mut reused, || {
            cut_mesh(mesh, bands, settings, nozzle_diameter, watch)
        })?,
        (None, Some(cut)) => {
            reused = true;
            Arc::clone(cut)
        }
        (None, None) => Arc::new(cut_mesh(mesh, bands, settings, nozzle_diameter, watch)?),
    };
    if reused {
        watch.complete(Stage::Cut);
    }
    *shared = Some(Arc::clone(&cut));
    Ok((cut, reused))
}

/// What drawing one object's toolpaths early needs: they are drawn the way
/// the reply draws its preview, with no travels, since nothing is ordered yet.
/// The longest early preview a slice publishes. A browser string tops out
/// near 536M characters, and the early preview is only a head start.
pub(super) const EARLY_PREVIEW_BYTES: usize = 64 << 20;

pub(super) struct Early {
    pub(super) profile: PrinterProfile,
    pub(super) blend: BlendMode,
    pub(super) tilt: Option<patch::BeltTilt>,
    pub(super) watch: Watch,
}

impl Early {
    /// Draw `paths` on a thread of its own, so the tour does not wait, and
    /// hand the drawing to the watch.
    pub(super) fn send(&self, cut: Arc<Contours>, paths: Arc<PartPaths>) {
        let (profile, blend, tilt, watch) = (
            self.profile.clone(),
            self.blend.clone(),
            self.tilt.clone(),
            self.watch.clone(),
        );
        let _ = std::thread::Builder::new()
            .name("slice-early-preview".into())
            .spawn(move || {
                let layers = early_preview(&cut, &paths, &profile, &blend, tilt.as_ref());
                if let Ok(text) = serde_json::to_string(&serde_json::json!({ "layers": layers })) {
                    // A client reads it as one string; past this, the reply's own parts come instead.
                    if text.len() <= EARLY_PREVIEW_BYTES {
                        watch.set_early(text);
                    }
                }
            });
    }
}

/// The part's paths as the preview draws them, layer by layer, before the
/// tour: no travels, and no seconds yet.
pub(super) fn early_preview(
    cut: &Contours,
    paths: &PartPaths,
    profile: &PrinterProfile,
    blend: &BlendMode,
    tilt: Option<&patch::BeltTilt>,
) -> Vec<PreviewLayer> {
    let planned: Vec<PlateLayer> = cut
        .bands
        .iter()
        .zip(&paths.layers)
        .map(|(band, layer)| {
            let n = layer.paths.len();
            let runs = (n > 0)
                .then(|| Run {
                    object: 0,
                    layer: PrintLayer::new(LayerPaths {
                        index: band.index,
                        z: band.z,
                        height: band.height,
                        paths: layer.paths.clone(),
                        note: String::new(),
                    }),
                    paths: 0..n,
                    entry: Entry::Cross { z_hop: 0.0 },
                    label: None,
                })
                .into_iter()
                .collect();
            PlateLayer {
                index: band.index,
                own: band.index,
                clear_z: None,
                z: band.z,
                height: band.height,
                note: String::new(),
                runs,
                belt_shift: 0.0,
                slow: 1.0,
                actions: Vec::new(),
            }
        })
        .collect();
    let mut layers = preview_of(&planned, profile, &[blend], &[], &[]);
    for layer in &mut layers {
        layer.paths.retain(|p| p.kind != "travel");
    }
    if let Some(tilt) = tilt {
        tilt_preview(&mut layers, &planned, tilt);
    }
    layers
}

/// Every stage after the cut, from the kept stages when there are `keys`.
/// Supports grow among the `neighbours` that come near them.
#[allow(clippy::too_many_arguments)]
pub(super) fn plan_object(
    cut: Arc<Contours>,
    reused: bool,
    keys: Option<kept::Keys>,
    blend: &BlendMode,
    settings: &SliceSettings,
    nozzle_diameter: f64,
    neighbours: &[plate::Neighbour],
    floor: Option<FloorPlane>,
    early: Option<&Early>,
    watch: &Watch,
) -> Result<Plan, String> {
    let reuse = Reuse {
        contours: reused,
        ..Reuse::default()
    };
    match keys {
        Some(keys) => plan_kept(
            keys,
            cut,
            reuse,
            blend,
            settings,
            nozzle_diameter,
            neighbours,
            floor,
            early,
            watch,
        ),
        None => plan_cut(
            cut,
            reuse,
            blend,
            settings,
            nozzle_diameter,
            neighbours,
            floor,
            watch,
        ),
    }
}

/// `plan` from the mesh already cut into per-band contours.
#[cfg(test)]
pub(super) fn plan_contours(
    bands: Vec<LayerBand>,
    contours: Vec<Vec<Loop>>,
    bounds: ([f64; 3], [f64; 3]),
    blend: &BlendMode,
    settings: &SliceSettings,
    nozzle_diameter: f64,
) -> Result<Plan, String> {
    let cut = Arc::new(Contours::new(bands, contours, bounds, settings));
    plan_cut(
        cut,
        Reuse::default(),
        blend,
        settings,
        nozzle_diameter,
        &[],
        None,
        &Watch::idle(),
    )
}

/// Every stage after the cut, with nothing kept. `reuse.contours` says the
/// cut was computed elsewhere, so its clocks are not this plan's.
#[allow(clippy::too_many_arguments)]
pub(super) fn plan_cut(
    cut: Arc<Contours>,
    reuse: Reuse,
    blend: &BlendMode,
    settings: &SliceSettings,
    nozzle_diameter: f64,
    neighbours: &[plate::Neighbour],
    floor: Option<FloorPlane>,
    watch: &Watch,
) -> Result<Plan, String> {
    let mut spent = Spent::default();
    if !reuse.contours {
        spent.cut(&cut);
    }
    let paths = part_paths(&cut, blend, settings, nozzle_diameter, [0; 32], None, watch)?;
    spent.toolpaths(&paths);
    let tour = tour_part(&cut, &paths, blend, settings, [0; 32], None, watch)?;
    spent.order_ms += tour.order_ms;
    let travels = comb_part(&cut, &tour, settings, [0; 32], None, watch)?;
    spent.comb_ms += travels.comb_ms;
    let mut supports = plate::settle(
        &cut,
        neighbours,
        |ground| {
            let plan = plan_supports(&cut, blend, settings, ground.map(|g| g.solid), floor, watch)?;
            spent.supports(&plan);
            Ok(plan)
        },
        |plan| plan,
    )?;
    if watch.stopped(settings.job) {
        return Err("cancelled".into());
    }
    let edits = edit(
        &mut supports,
        &cut,
        &settings.support_edits,
        blend,
        settings,
    );
    if watch.stopped(settings.job) {
        return Err("cancelled".into());
    }
    let part = Part {
        paths: &paths,
        tour: &tour,
        travels: &travels,
    };
    let assembled = assemble(&cut, part, &supports, blend, settings, &[], watch)?;
    let cap = settings.object_tweak.speed;
    Ok(finish(cut, &supports, edits, assembled, reuse, spent, cap))
}

/// `plan` from the kept stages. Each stage is reused when its key matches.
/// Edits extend the last edited state when they start with its edits, and
/// otherwise replay from the base, which is how undoing an edit works.
#[allow(clippy::too_many_arguments)]
pub(super) fn plan_kept(
    keys: kept::Keys,
    cut: Arc<Contours>,
    mut reuse: Reuse,
    blend: &BlendMode,
    settings: &SliceSettings,
    nozzle_diameter: f64,
    neighbours: &[plate::Neighbour],
    floor: Option<FloorPlane>,
    early: Option<&Early>,
    watch: &Watch,
) -> Result<Plan, String> {
    let mut spent = Spent::default();
    if !reuse.contours {
        spent.cut(&cut);
    }
    if watch.stopped(settings.job) {
        return Err("cancelled".into());
    }
    let base = &keys.layers;
    let paths = kept::stage(&keys.toolpaths, &mut reuse.toolpaths, || {
        let kept = kept::newest::<PartPaths>(|p| p.base == base.toolpaths);
        part_paths(
            &cut,
            blend,
            settings,
            nozzle_diameter,
            base.toolpaths,
            kept.as_deref(),
            watch,
        )
    })?;
    if reuse.toolpaths {
        watch.complete(Stage::Part);
    } else {
        spent.toolpaths(&paths);
        reuse.toolpath_layers = paths.reused;
        if let Some(early) = early {
            early.send(Arc::clone(&cut), Arc::clone(&paths));
        }
    }
    if watch.stopped(settings.job) {
        return Err("cancelled".into());
    }
    let tour = kept::stage(&keys.order, &mut reuse.order, || {
        let kept = kept::newest::<PartTour>(|t| t.base == base.order);
        tour_part(
            &cut,
            &paths,
            blend,
            settings,
            base.order,
            kept.as_deref(),
            watch,
        )
    })?;
    if reuse.order {
        watch.complete(Stage::Travel);
    } else {
        spent.order_ms += tour.order_ms;
        reuse.order_layers = tour.reused;
    }
    if watch.stopped(settings.job) {
        return Err("cancelled".into());
    }
    let travels = kept::stage(&keys.comb, &mut reuse.comb, || {
        let kept = kept::newest::<PartTravels>(|t| t.base == base.comb);
        comb_part(&cut, &tour, settings, base.comb, kept.as_deref(), watch)
    })?;
    if !reuse.comb {
        spent.comb_ms += travels.comb_ms;
        reuse.comb_layers = travels.reused;
    }
    if watch.stopped(settings.job) {
        return Err("cancelled".into());
    }

    let want = &settings.support_edits;
    let (keys, base, edited) = plate::settle(
        &cut,
        neighbours,
        |ground| {
            let keys = ground
                .as_ref()
                .map_or_else(|| keys.clone(), |g| keys.grounded(&g.key));
            let (base, edited) = kept_supports(
                &keys,
                &cut,
                blend,
                settings,
                ground.map(|g| g.solid),
                floor,
                &mut reuse,
                &mut spent,
                watch,
            )?;
            kept::keep_supports(&keys, Arc::clone(&base), edited.clone());
            Ok((keys, base, edited))
        },
        |(_, base, _)| base,
    )?;
    if watch.stopped(settings.job) {
        return Err("cancelled".into());
    }
    let mut edits = Edits::default();
    let fresh = (!want.is_empty()).then(|| {
        let (mut plan, mut outcomes) = match edited.as_deref() {
            Some(e) if want.starts_with(&e.edits) => {
                reuse.edits = e.edits.len() as u32;
                (e.plan.clone(), e.outcomes.clone())
            }
            _ => ((*base).clone(), Vec::new()),
        };
        edits = edit(
            &mut plan,
            &cut,
            &want[reuse.edits as usize..],
            blend,
            settings,
        );
        outcomes.append(&mut edits.outcomes);
        edits.outcomes = outcomes;
        Arc::new(kept::Edited {
            edits: want.clone(),
            plan,
            outcomes: edits.outcomes.clone(),
        })
    });
    if watch.stopped(settings.job) {
        return Err("cancelled".into());
    }
    let supports = fresh.as_deref().map_or(&*base, |e| &e.plan);
    let prior = kept::prior(&keys);
    let part = Part {
        paths: &paths,
        tour: &tour,
        travels: &travels,
    };
    let assembled = assemble(
        &cut,
        part,
        supports,
        blend,
        settings,
        prior.as_ref().map_or(&[], |p| p.as_slice()),
        watch,
    )?;
    kept::keep_joined(&keys, Arc::new(assembled.joined.clone()));
    kept::keep_supports(&keys, Arc::clone(&base), fresh.clone().or(edited));
    let kept = KeptPlan {
        key: keys.whole,
        contours: keys.contours,
    };
    let cap = settings.object_tweak.speed;
    let mut plan = finish(cut, supports, edits, assembled, reuse, spent, cap);
    plan.kept = Some(kept);
    Ok(plan)
}

/// The supports kept under `keys` and their last edited state: painted
/// already, or grown and painted again under `settings`, or grown now among
/// `solid`.
#[allow(clippy::too_many_arguments)]
pub(super) fn kept_supports(
    keys: &kept::Keys,
    cut: &Contours,
    blend: &BlendMode,
    settings: &SliceSettings,
    solid: Option<Arc<Vec<Vec<Loop>>>>,
    floor: Option<FloorPlane>,
    reuse: &mut Reuse,
    spent: &mut Spent,
    watch: &Watch,
) -> Result<(Arc<SupportPlan>, Option<Arc<kept::Edited>>), String> {
    let want = &settings.support_edits;
    reuse.supports = false;
    reuse.support_paths = false;
    match kept::supports(keys) {
        Some(found) if found.painted => {
            reuse.supports = true;
            reuse.support_paths = true;
            watch.complete(Stage::Supports);
            Ok((found.base, found.edited))
        }
        Some(found) => {
            reuse.supports = true;
            let layers = cut.bands.len().max(1) as u32;
            watch.begin(Stage::Supports, layers);
            if watch.stopped(settings.job) {
                return Err("cancelled".into());
            }
            let base = Arc::new(found.base.repaint(cut, blend, settings, watch));
            spent.supports(&base);
            if watch.stopped(settings.job) {
                return Err("cancelled".into());
            }
            let edited = found
                .edited
                .filter(|e| !want.is_empty() && want.starts_with(&e.edits))
                .map(|e| {
                    let plan = e.plan.repaint(cut, blend, settings, watch);
                    spent.supports(&plan);
                    Arc::new(kept::Edited {
                        edits: e.edits.clone(),
                        plan,
                        outcomes: e.outcomes.clone(),
                    })
                });
            if watch.stopped(settings.job) {
                return Err("cancelled".into());
            }
            watch.fill();
            Ok((base, edited))
        }
        None => {
            let base = Arc::new(plan_supports(cut, blend, settings, solid, floor, watch)?);
            spent.supports(&base);
            Ok((base, None))
        }
    }
}

/// The plan, with the object's speed cap `cap` applied and the clocks of
/// what was joined and edited added.
pub(super) fn finish(
    cut: Arc<Contours>,
    supports: &SupportPlan,
    edits: Edits,
    assembled: Assembled,
    reuse: Reuse,
    mut spent: Spent,
    cap: Option<f64>,
) -> Plan {
    spent.order_ms += assembled.order_ms;
    spent.comb_ms += assembled.comb_ms;
    spent.edit_apply_ms += edits.apply_ms;
    spent.edit_refresh_ms += edits.refresh_ms;
    let heads = assembled.joined.iter().map(|j| j.head).collect();
    Plan {
        layers: assembled
            .joined
            .into_par_iter()
            .map(|j| j.capped(cap))
            .collect(),
        heads,
        layers_reused: assembled.reused,
        kept: None,
        cut,
        supports: Arc::clone(&supports.supports),
        coverage: supports.coverage.clone(),
        in_air: supports.in_air,
        outcomes: edits.outcomes,
        reuse,
        spent,
    }
}

/// The mesh cut into per-band contours, and the roof distances the part's
/// shells read off them.
pub(super) fn cut_mesh(
    mesh: &Mesh,
    bands: Vec<LayerBand>,
    settings: &SliceSettings,
    nozzle_diameter: f64,
    watch: &Watch,
) -> Result<Contours, String> {
    let bounds = mesh.bounds().ok_or("empty mesh")?;
    let index_started = Instant::now();
    let index = ZIndex::build(mesh);
    let index_ms = elapsed_ms(index_started);
    let tolerance = outline_tolerance(settings, nozzle_diameter);
    let contour_started = Instant::now();
    watch.begin(Stage::Cut, bands.len().max(1) as u32);
    if watch.stopped(settings.job) {
        return Err("cancelled".into());
    }
    let cut: Vec<(Vec<Loop>, f64, f64, usize, usize, f64)> = bands
        .par_iter()
        .map(|band| {
            if watch.stopped(settings.job) {
                return (Vec::new(), 0.0, 0.0, 0, 0, 0.0);
            }
            let cut_started = Instant::now();
            let (raw, stats) = index.slice_with_stats(band.cut_z());
            let cut_ms = elapsed_ms(cut_started);
            let simplify_started = Instant::now();
            let loops = simplify_loops(raw, tolerance);
            watch.tick();
            (
                loops,
                cut_ms,
                elapsed_ms(simplify_started),
                usize::from(stats.bridged > 0),
                stats.dropped,
                stats.bridged_mm,
            )
        })
        .collect();
    let contour_ms = elapsed_ms(contour_started);
    let cut_cpu_ms = cut.iter().map(|row| row.1).sum();
    let simplify_cpu_ms = cut.iter().map(|row| row.2).sum();
    let repaired_layers = cut.iter().map(|row| row.3).sum();
    let dropped_chains = cut.iter().map(|row| row.4).sum();
    let bridged_mm: f64 = cut.iter().map(|row| row.5).sum();
    let contours = cut.into_iter().map(|row| row.0).collect();
    if watch.stopped(settings.job) {
        return Err("cancelled".into());
    }
    watch.fill();
    let mut cut = Contours::new(bands, contours, bounds, settings);
    cut.clocks.contour_ms = contour_ms;
    cut.clocks.index_ms = index_ms;
    cut.clocks.cut_cpu_ms = cut_cpu_ms;
    cut.clocks.simplify_cpu_ms = simplify_cpu_ms;
    cut.repaired_layers = repaired_layers;
    cut.bridged_mm = bridged_mm;
    cut.dropped_chains = dropped_chains;
    Ok(cut)
}
