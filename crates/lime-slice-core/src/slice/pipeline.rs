use super::belt::{belt_opened, belt_output, prepare_belt, BeltJob, PlateObject};
use super::layer_preview::{compare_estimates, feature_estimates, preview, velocity_cap};
use super::pareto::{score_of, structural_mm3};
use super::parts::Contours;
use super::plan::{
    cut_object, height_opts, kept_keys, outline_tolerance, plan_object, plan_sharing, Early,
    KeptPlan, Plan, Reuse, Spent,
};
use super::preview_paths::seam_metrics;
use super::reply::{mesh_warnings, slice_to_part, sliced_beads, MeshInfo, Sanity, StageTimes};
use super::settings::apply_layer_actions;
use super::wire::ObjectView;
use super::{elapsed_ms, kept, patch, plate, resolved, wire, PlateOrder, Source};
use crate::adaptive::{plan_plate_bands, LayerBand};
use crate::gcode::{emit_gcode, emit_later, PlateLayer};
use crate::support::paint;
use crate::support::skeleton::{skeleton, tilt_gaps, Tilt as SkeletonTilt};
use crate::{
    BeltCopies, BlendMode, CompareEstimate, EditOutcomeView, GcodeText, Mesh, PrintEstimate,
    PrinterProfile, SliceResponse, SliceSettings, SlicedBeads, StrategyId, SupportEdit, Watch,
};
use sha2::{Digest, Sha256};
use std::borrow::Cow;
use std::sync::Arc;
use std::time::Instant;

/// What every step after input staging shares: the settings and profile as
/// the plate sees them, each object in its part frame, and the belt job.
struct Staged<'a> {
    settings: SliceSettings,
    profile: PrinterProfile,
    features: String,
    layer_height: f64,
    line_width: f64,
    /// True when the request listed `objects`.
    listed: bool,
    objects: Vec<PlateObject<'a>>,
    belt_job: Option<BeltJob>,
    /// Each object's part-frame bounds (the lab ones on a belt).
    bounds: Vec<([f64; 3], [f64; 3])>,
}

/// One object's cut: the contours, whether they were reused, and their keys.
type CutEntry = (Arc<Contours>, bool, Option<kept::Keys>);

/// The plate's layers: the shared bands, the joined layers, and how each
/// object's band numbers map onto the plate's.
struct Joined {
    bands: Vec<plate::PlateBand>,
    planned: Arc<Vec<PlateLayer>>,
    plate_index: Vec<Vec<usize>>,
    kept_plate: Option<KeptPlate>,
}

/// The layers emit writes, and the audits that read them.
struct Finished {
    emit_held: Arc<Vec<PlateLayer>>,
    stamped: Option<Vec<PlateLayer>>,
    part_hold: Option<crate::audit::PartHold>,
    beads: Option<Arc<SlicedBeads>>,
}

impl Finished {
    fn emit_layers(&self) -> &[PlateLayer] {
        self.stamped.as_deref().unwrap_or(self.emit_held.as_slice())
    }
}

/// What the reply is built from, once the G-code is written.
struct Outcome {
    plans: Vec<Plan>,
    joined: Joined,
    finished: Finished,
    gcode: crate::gcode::GcodeStats,
    gcode_text: Option<GcodeText>,
    stages: StageTimes,
    core_ms: f64,
    views: Vec<ObjectView>,
    baseline_ms: f64,
    baseline_label: String,
    compare: Vec<CompareEstimate>,
}

/// Plan each object alone in its own part frame, join the plans layer by
/// layer, write the G-code with each object's offset, and build the reply.
/// A request without `objects` is a plate of one, sliced exactly as before.
#[allow(clippy::too_many_arguments)]
pub(super) fn slice_plate(
    sources: &[Source<'_>],
    requested: &BlendMode,
    profile: &PrinterProfile,
    settings: &SliceSettings,
    belt_spec: Option<&crate::belt::BeltSpec>,
    order: PlateOrder,
    cut: &mut Option<Arc<Contours>>,
    watch: &Watch,
) -> Result<SliceResponse, String> {
    check_limits(profile, settings)?;
    let mut st = stage_inputs(sources, profile, settings, belt_spec, order)?;
    let started = Instant::now();
    if kept::on() {
        kept::fit(st.objects.len());
    }
    let watches = object_watches(&st.objects, watch);
    let (cuts, bands_ms) = cut_objects(&st, cut, &watches)?;
    let offsets: Vec<[f64; 2]> = st.objects.iter().map(PlateObject::to_bed).collect();
    let plans = plan_objects(&st, &cuts, &offsets, &watches, watch)?;
    let join_started = Instant::now();
    let joined = join_plans(&st, &plans, order);
    let finished = finish_layers(&mut st, &joined, &offsets);
    let join_ms = elapsed_ms(join_started);
    let emit_started = Instant::now();
    let (gcode, gcode_text) = emit_plate(&st, requested, &finished, &offsets, watch);
    let emit_ms = elapsed_ms(emit_started);
    if gcode.cancelled || watch.stopped(st.settings.job) {
        return Err("cancelled".into());
    }
    let core_ms = elapsed_ms(started);
    let stages = stage_times(&plans, bands_ms, join_ms, emit_ms);
    let views = object_views(&st, &plans, &joined);
    let (baseline_ms, baseline_label) =
        baseline_estimate(&st, &plans, &joined, &offsets, cut, watch)?;
    let compare = if st.settings.compare && st.objects.len() == 1 {
        compare_estimates(
            &st.objects[0].mesh,
            &st.objects[0].settings,
            &st.profile,
            cut,
            &watch.silent(),
        )?
    } else {
        Vec::new()
    };
    let outcome = Outcome {
        plans,
        joined,
        finished,
        gcode,
        gcode_text,
        stages,
        core_ms,
        views,
        baseline_ms,
        baseline_label,
        compare,
    };
    Ok(build_reply(st, requested, outcome))
}

/// Refuse a flow, retraction, layer-time, or fan value outside its range.
fn check_limits(profile: &PrinterProfile, settings: &SliceSettings) -> Result<(), String> {
    if !settings.flow.is_finite() || !(0.5..=1.5).contains(&settings.flow) {
        return Err(format!("flow {} must be from 0.5 to 1.5", settings.flow));
    }
    if let Some(n) = settings.retract_length {
        if !n.is_finite() || !(0.0..=5.0).contains(&n) {
            return Err(format!("retractLength {n} must be from 0 to 5"));
        }
    }
    if let Some(n) = settings.retract_speed {
        if !n.is_finite() || !(5.0..=80.0).contains(&n) {
            return Err(format!("retractSpeed {n} must be from 5 to 80"));
        }
    }
    if let Some(n) = settings.min_layer_time_s {
        if !n.is_finite() || !(0.0..=600.0).contains(&n) {
            return Err(format!("minLayerTimeS {n} must be from 0 to 600"));
        }
    }
    if let Some(n) = settings.min_layer_speed_mm_s {
        if !n.is_finite() || !(1.0..=300.0).contains(&n) {
            return Err(format!("minLayerSpeedMmS {n} must be from 1 to 300"));
        }
    }
    for (name, pct) in [
        ("fanPercent", profile.fan_percent),
        ("overhangFanPercent", profile.overhang_fan_percent),
        ("supportFanPercent", profile.support_fan_percent),
    ] {
        if let Some(pct) = pct.filter(|pct| *pct > 100) {
            return Err(format!("printer.{name} {pct} must be from 0 to 100"));
        }
    }
    Ok(())
}

/// Put every object in its part frame, lay a belt plate flat, and check the
/// sequential-order clearances.
fn stage_inputs<'a>(
    sources: &[Source<'a>],
    profile: &PrinterProfile,
    settings: &SliceSettings,
    belt_spec: Option<&crate::belt::BeltSpec>,
    order: PlateOrder,
) -> Result<Staged<'a>, String> {
    let listed = sources.iter().any(|s| s.id.is_some());
    let mut settings = resolved(settings);
    let (layer_height, line_width) = (settings.layer_height, settings.line_width);
    let mut features = settings.feature_note();
    let mut profile = profile.clone();
    if settings.classic {
        profile.max_volumetric_mm3_s = f64::INFINITY;
        profile.pressure_advance = 0.0;
        profile.linear_advance = 0.0;
    }
    let mut objects = part_frames(sources, &profile);
    for (i, object) in objects.iter().enumerate() {
        let tweak = object.settings.object_tweak;
        if let Err(err) = wire::tweak(tweak.infill, tweak.walls, tweak.speed) {
            return Err(if listed {
                format!("objects[{i}].settings: {err}")
            } else {
                err
            });
        }
    }
    let seam_disks: usize = objects.iter().map(|o| o.settings.seam_paint.len()).sum();
    if seam_disks > 0 {
        features.push_str(&format!("; seam paint {seam_disks} disks"));
    }
    // A belt lays the placed meshes flat, then the planar pipeline runs in
    // that frame. Bed XY is baked in first so two objects keep their relative
    // place, which a shift along the belt turns into a different nozzle plane.
    // The whole plate is then settled so the belt and the rail start at 0.
    let belt_job = match belt_spec {
        Some(spec) => Some(prepare_belt(&mut objects, &mut settings, spec)?),
        None => None,
    };
    // Lengths are measured on the mesh the planner cuts: after the pose and,
    // on a belt, after the lay-flat. An empty list does not walk the mesh.
    for object in &mut objects {
        if !object.settings.reinforcement.is_empty() {
            crate::reinforcement::resolve(&mut object.settings.reinforcement, &object.mesh);
        }
    }
    let bounds: Vec<([f64; 3], [f64; 3])> = if let Some(job) = &belt_job {
        job.lab_bounds.clone()
    } else {
        objects
            .iter()
            .map(|o| o.mesh.bounds().ok_or("empty mesh"))
            .collect::<Result<_, _>>()?
    };
    if let PlateOrder::Sequential {
        clearance_mm,
        gantry_mm,
    } = order
    {
        let mut boxes = Vec::with_capacity(objects.len());
        for (k, object) in objects.iter().enumerate() {
            let (min, max) = object.mesh.bounds().ok_or("empty mesh")?;
            let [dx, dy] = object.to_bed();
            let id = object.id.unwrap_or("part");
            let tall = max[2] - min[2];
            if k + 1 < objects.len() && tall > gantry_mm + 1e-9 {
                return Err(format!(
                    "printOrder \"sequential\": \"{id}\" is {tall:.1} mm tall, above the {gantry_mm} mm gantry; only the last object may be taller"
                ));
            }
            boxes.push((id, [min[0] + dx, min[1] + dy], [max[0] + dx, max[1] + dy]));
        }
        plate::sequential_clearance(&boxes, clearance_mm)?;
    }
    Ok(Staged {
        settings,
        profile,
        features,
        layer_height,
        line_width,
        listed,
        objects,
        belt_job,
        bounds,
    })
}

/// Every stage runs in the part frame with no pose left in the settings,
/// so no kept key sees where a part sits on the bed. Emit adds the offset.
fn part_frames<'a>(sources: &[Source<'a>], profile: &PrinterProfile) -> Vec<PlateObject<'a>> {
    let centre = [profile.bed_x * 0.5, profile.bed_y * 0.5];
    sources
        .iter()
        .map(|s| {
            let mut settings = resolved(&s.settings);
            let (mesh, offset) = match settings.pose.take() {
                Some(pose) => {
                    let (frame, offset) = pose.part_frame(centre);
                    for disk in &mut settings.support_paint {
                        *disk = disk.posed(&frame.rotation, frame.pivot, frame.translation);
                    }
                    for disk in &mut settings.seam_paint {
                        *disk = disk.posed(&frame.rotation, frame.pivot, frame.translation);
                    }
                    for region in &mut settings.reinforcement {
                        region.pose(&frame.rotation, frame.pivot, frame.translation);
                    }
                    (Cow::Owned(frame.apply(s.mesh)), Some(offset))
                }
                None => (Cow::Borrowed(s.mesh), None),
            };
            let blend = s.blend.in_part_frame(offset.unwrap_or([0.0, 0.0]));
            if !settings.overrides.is_empty() {
                if let Some((min, max)) = mesh.bounds() {
                    settings.overrides =
                        settings
                            .overrides
                            .for_part(offset.unwrap_or([0.0, 0.0]), min, max);
                }
            }
            PlateObject {
                id: s.id,
                mesh,
                offset,
                blend,
                settings,
            }
        })
        .collect()
}

/// One progress bar for the plate: each object fills its share of the
/// per-object stages, weighed by its triangles.
fn object_watches(objects: &[PlateObject<'_>], watch: &Watch) -> Vec<Watch> {
    if objects.len() == 1 {
        vec![watch.clone()]
    } else {
        let tris: Vec<f64> = objects
            .iter()
            .map(|o| o.mesh.triangle_count() as f64)
            .collect();
        let all = tris.iter().sum::<f64>().max(1.0);
        let mut before = 0.0;
        tris.iter()
            .map(|&t| {
                let slot = watch.object(before, t / all);
                before += t / all;
                slot
            })
            .collect()
    }
}

/// Every cut first: an object's supports read the cuts of the others.
/// Returns the cuts and the time spent planning bands.
fn cut_objects(
    st: &Staged<'_>,
    cut: &mut Option<Arc<Contours>>,
    watches: &[Watch],
) -> Result<(Vec<CutEntry>, f64), String> {
    let objects = &st.objects;
    let meshes: Vec<&Mesh> = objects.iter().map(|o| o.mesh.as_ref()).collect();
    let floor = st.belt_job.as_ref().and_then(|job| job.floor);
    let mut cuts: Vec<CutEntry> = Vec::with_capacity(objects.len());
    let mut bands_ms = 0.0;
    for (k, o) in objects.iter().enumerate() {
        let bands_started = Instant::now();
        let bands = plan_plate_bands(&o.mesh, &meshes, &height_opts(&o.settings))?;
        let keys = kept_keys(
            &o.mesh,
            &bands,
            &o.blend,
            &o.settings,
            st.profile.nozzle_diameter,
            floor,
        );
        bands_ms += elapsed_ms(bands_started);
        let mut alone = None;
        let shared = if objects.len() == 1 {
            &mut *cut
        } else {
            &mut alone
        };
        let (cut, reused) = cut_object(
            &o.mesh,
            bands,
            &o.settings,
            st.profile.nozzle_diameter,
            keys.as_ref(),
            shared,
            &watches[k],
        )?;
        cuts.push((cut, reused, keys));
    }
    Ok((cuts, bands_ms))
}

/// Plan each object's supports and layers, one after another; each sees the
/// other parts' cuts and the trees of the objects planned before it.
fn plan_objects(
    st: &Staged<'_>,
    cuts: &[CutEntry],
    offsets: &[[f64; 2]],
    watches: &[Watch],
    watch: &Watch,
) -> Result<Vec<Plan>, String> {
    let objects = &st.objects;
    let (settings, profile, belt_job) = (&st.settings, &st.profile, &st.belt_job);
    let floor = belt_job.as_ref().and_then(|job| job.floor);
    let mut plans: Vec<Plan> = Vec::with_capacity(objects.len());
    for (a, (o, (cut, reused, keys))) in objects.iter().zip(cuts).enumerate() {
        let shift = |b: usize| [offsets[b][0] - offsets[a][0], offsets[b][1] - offsets[a][1]];
        // Every other part, and the trees of the objects planned before this
        // one, so two objects' trees never print in the same place.
        let parts = cuts
            .iter()
            .enumerate()
            .filter(|&(b, _)| b != a)
            .map(|(b, (cut, _, keys))| {
                plate::Neighbour::part(cut, keys.as_ref().map_or([0; 32], |k| k.contours), shift(b))
            });
        let trees = plans.iter().enumerate().map(|(b, plan)| {
            let key = plan.kept.as_ref().map_or([0; 32], |k| {
                let edits = &objects[b].settings.support_edits;
                Sha256::digest(format!("trees|{:?}|{edits:?}", k.key)).into()
            });
            plate::Neighbour::trees(
                &plan.cut,
                &plan.supports,
                objects[b].settings.line_width,
                key,
                shift(b),
            )
        });
        let neighbours: Vec<plate::Neighbour> = parts.chain(trees).collect();
        // One object's toolpaths can be drawn while its tour runs. A plate of
        // several waits for the reply.
        let early =
            (objects.len() == 1 && settings.include_preview && watch.wants_early()).then(|| {
                Early {
                    profile: profile.clone(),
                    blend: o.blend.clone(),
                    tilt: belt_job.as_ref().map(|job| patch::BeltTilt {
                        belt: job.belt,
                        offsets: job.tilt_offsets(),
                    }),
                    watch: watch.clone(),
                }
            });
        plans.push(plan_object(
            Arc::clone(cut),
            *reused,
            keys.clone(),
            &o.blend,
            &o.settings,
            profile.nozzle_diameter,
            &neighbours,
            floor,
            early.as_ref(),
            &watches[a],
        )?);
    }
    Ok(plans)
}

/// Join the object plans into the plate's layers, and note them as the
/// preview the client will hold when every object came from the kept stages.
fn join_plans(st: &Staged<'_>, plans: &[Plan], order: PlateOrder) -> Joined {
    let (objects, settings, profile) = (&st.objects, &st.settings, &st.profile);
    let band_lists: Vec<&[LayerBand]> = plans.iter().map(|p| p.cut.bands.as_slice()).collect();
    let bands = match order {
        PlateOrder::AllAtOnce => plate::plate_bands(&band_lists),
        PlateOrder::Sequential { .. } => plate::sequential_bands(&band_lists),
    };
    let sequential_stamp = matches!(order, PlateOrder::Sequential { .. }) && objects.len() > 1;
    let labelled = objects.len() > 1;
    let joinable: Vec<plate::Joinable<'_>> = plans
        .iter()
        .zip(objects)
        .map(|(p, o)| plate::Joinable {
            layers: &p.layers,
            heads: &p.heads,
            offset: o.to_bed(),
            label: o.id.filter(|_| labelled).map(Arc::from),
        })
        .collect();
    let planned = Arc::new(plate::join(&joinable, &bands, settings));
    // Each object's band, renumbered as the plate's layer it prints on.
    let mut plate_index: Vec<Vec<usize>> =
        plans.iter().map(|p| vec![0; p.cut.bands.len()]).collect();
    for (k, band) in bands.iter().enumerate() {
        for &(o, i) in &band.members {
            plate_index[o][i] = k;
        }
    }
    let belt_stamp = st
        .belt_job
        .as_ref()
        .map(|job| patch::BeltStamp::from_belt(&job.belt));
    let kept_plate = plans
        .iter()
        .map(|p| p.kept.as_ref())
        .collect::<Option<Vec<&KeptPlan>>>()
        .map(|kept| {
            let edits: Vec<&[SupportEdit]> = objects
                .iter()
                .map(|o| o.settings.support_edits.as_slice())
                .collect();
            let whole: Vec<[u8; 32]> = kept.iter().map(|k| k.key).collect();
            let contours: Vec<[u8; 32]> = kept.iter().map(|k| k.contours).collect();
            let prior = kept::plate_prior();
            kept::keep_plate(Arc::clone(&planned));
            KeptPlate {
                token: patch::token(
                    &whole,
                    profile,
                    &edits,
                    belt_stamp.as_ref(),
                    sequential_stamp,
                ),
                drawn: patch::drawn(&contours, profile),
                prior,
                belt: belt_stamp,
                sequential: sequential_stamp,
            }
        });
    Joined {
        bands,
        planned,
        plate_index,
        kept_plate,
    }
}

/// Settle the belt frame, expand belt copies, stamp the layer actions, and
/// run the audits that read the layers emit will write.
fn finish_layers(st: &mut Staged<'_>, joined: &Joined, offsets: &[[f64; 2]]) -> Finished {
    let planned = &joined.planned;
    // A frame lowered for floor supports starts with layers nothing reached.
    if let Some(job) = st.belt_job.as_mut().filter(|job| job.floor.is_some()) {
        job.belt.start = planned
            .iter()
            .find(|layer| !layer.is_empty())
            .map_or(0.0, |layer| layer.z - layer.height);
    }
    let (settings, profile, belt_job) = (&st.settings, &st.profile, &st.belt_job);
    // Copies are emit-only. Contour stages stay the single planned part.
    // The preview prior is the expanded plate, which is what the client draws.
    let emit_held = if let Some(job) = belt_job {
        let arc = Arc::new(belt_output((**planned).clone(), job));
        if joined.kept_plate.is_some() {
            kept::keep_plate(Arc::clone(&arc));
        }
        arc
    } else {
        Arc::clone(planned)
    };
    let stamped = if settings.layer_actions.is_empty() {
        None
    } else {
        Some(apply_layer_actions(
            emit_held.as_slice(),
            &settings.layer_actions,
            profile.firmware,
            belt_job.as_ref().map(|job| &job.belt),
        ))
    };
    let emit_layers: &[PlateLayer] = stamped.as_deref().unwrap_or(emit_held.as_slice());
    let part_hold = settings.part_hold.then(|| {
        let z_gap = settings
            .support_z_gap_mm
            .unwrap_or_else(|| st.layer_height.max(0.12));
        // A lone part's place along the belt is out of the laid mesh, so the
        // audit adds it back; a plate of several baked it in already.
        let frame = belt_job.as_ref().map(|job| {
            let to_bed = job.offsets.first().copied().flatten().unwrap_or([0.0, 0.0]);
            let baked = job.baked.first().copied().unwrap_or([0.0, 0.0]);
            (job.belt.frame, job.belt.start, to_bed[1] - baked[1])
        });
        crate::audit::plate_hold(
            emit_layers,
            offsets,
            &crate::audit::HoldRule::new(st.line_width, st.layer_height, z_gap, frame),
        )
    });
    let beads = settings.capture_beads.then(|| {
        let offset = offsets.first().copied().unwrap_or([0.0, 0.0]);
        Arc::new(sliced_beads(
            emit_layers,
            offsets,
            settings.flow,
            slice_to_part(belt_job.as_ref(), offset),
        ))
    });
    Finished {
        emit_held,
        stamped,
        part_hold,
        beads,
    }
}

/// Write the G-code, or only its estimates and text for later when the
/// request leaves the G-code out of the reply.
fn emit_plate(
    st: &Staged<'_>,
    requested: &BlendMode,
    finished: &Finished,
    offsets: &[[f64; 2]],
    watch: &Watch,
) -> (crate::gcode::GcodeStats, Option<GcodeText>) {
    let settings = &st.settings;
    let emit_layers = finished.emit_layers();
    let belt_emit = st.belt_job.as_ref().map(|job| &job.belt);
    if settings.include_gcode {
        let gcode = emit_gcode(
            emit_layers,
            &st.profile,
            requested,
            st.layer_height,
            st.line_width,
            &st.features,
            settings.arc_fit,
            settings.classic_estimator,
            settings.junction_deviation_mm,
            offsets,
            belt_emit,
            settings.flow,
            crate::gcode::RetractEmit {
                length_mm: settings.retract_length,
                speed_mm_s: settings.retract_speed,
            },
            settings.min_layer(),
            settings.job,
            watch,
        );
        (gcode, None)
    } else {
        let (gcode, text) = emit_later(
            emit_layers,
            &st.profile,
            requested,
            st.layer_height,
            st.line_width,
            &st.features,
            settings.arc_fit,
            settings.classic_estimator,
            settings.junction_deviation_mm,
            offsets,
            belt_emit,
            settings.flow,
            crate::gcode::RetractEmit {
                length_mm: settings.retract_length,
                speed_mm_s: settings.retract_speed,
            },
            settings.min_layer(),
            settings.job,
            watch,
        );
        (gcode, Some(text))
    }
}

/// The per-stage times of the whole plate (#584).
fn stage_times(plans: &[Plan], bands_ms: f64, join_ms: f64, emit_ms: f64) -> StageTimes {
    let mut spent = Spent::default();
    for p in plans {
        spent.add(&p.spent);
    }
    StageTimes {
        contour_ms: spent.contour_ms,
        support_ms: spent.support_ms,
        order_ms: spent.order_ms,
        toolpath_ms: spent.toolpath_ms,
        emit_ms,
        comb_ms: spent.comb_ms,
        index_ms: spent.index_ms,
        cut_cpu_ms: spent.cut_cpu_ms,
        simplify_cpu_ms: spent.simplify_cpu_ms,
        roof_ms: spent.roof_ms,
        wall_cpu_ms: spent.wall_cpu_ms,
        infill_cpu_ms: spent.infill_cpu_ms,
        bands_ms,
        prep_ms: spent.prep_ms,
        join_ms,
        reused: plans
            .iter()
            .map(|p| p.reuse)
            .reduce(Reuse::both)
            .unwrap_or_default()
            .names(),
        edits_reused: plans.iter().map(|p| p.reuse.edits).sum(),
        edit_apply_ms: spent.edit_apply_ms,
        edit_refresh_ms: spent.edit_refresh_ms,
        layers_reused: plans.iter().map(|p| p.layers_reused).sum(),
        toolpath_layers_reused: plans.iter().map(|p| p.reuse.toolpath_layers).sum(),
        order_layers_reused: plans.iter().map(|p| p.reuse.order_layers).sum(),
        comb_layers_reused: plans.iter().map(|p| p.reuse.comb_layers).sum(),
    }
}

/// Each object's coverage, skeleton, edit outcomes, and paint tally, with
/// its bands numbered as the plate's layers.
fn object_views(st: &Staged<'_>, plans: &[Plan], joined: &Joined) -> Vec<ObjectView> {
    let belt_job = &st.belt_job;
    // A belt reply numbers its layers after the leading ones that print nothing.
    let opened = belt_job
        .as_ref()
        .map_or(0, |job| belt_opened(&joined.planned, &job.belt));
    plans
        .iter()
        .zip(&st.objects)
        .zip(&st.bounds)
        .enumerate()
        .map(|(o, ((p, obj), &(min, max)))| {
            let indexed: Vec<LayerBand> = p
                .cut
                .bands
                .iter()
                .map(|b| LayerBand {
                    index: joined.plate_index[o][b.index],
                    ..*b
                })
                .collect();
            let tilt = belt_job.as_ref().map(|job| SkeletonTilt {
                belt: &job.belt,
                offset: job.baked[o],
                plate: &joined.planned,
            });
            ObjectView {
                id: obj.id.unwrap_or_default().to_owned(),
                min,
                max,
                triangles: obj.mesh.triangle_count(),
                offset: if let Some(job) = belt_job {
                    job.offsets[o].unwrap_or([0.0, 0.0])
                } else {
                    obj.to_bed()
                },
                coverage: tilt_gaps(&p.coverage, &indexed, tilt.as_ref()),
                in_air: p.in_air,
                skeleton: obj
                    .settings
                    .include_skeleton
                    .then(|| skeleton(&p.supports, &indexed, tilt.as_ref())),
                support_edits: p
                    .outcomes
                    .iter()
                    .map(|out| EditOutcomeView::of(out, &indexed, opened, tilt.as_ref()))
                    .collect(),
                support_paint: (!obj.settings.support_paint.is_empty()).then(|| {
                    paint::tally(
                        &obj.settings.support_paint,
                        &obj.mesh,
                        &p.cut.bands,
                        obj.settings.supports,
                    )
                }),
                reused: p.reuse.names(),
            }
        })
        .collect()
}

/// Time the single-strategy baseline the reply compares against. A plate of
/// several objects, or a request without `baseline`, skips it.
fn baseline_estimate(
    st: &Staged<'_>,
    plans: &[Plan],
    joined: &Joined,
    offsets: &[[f64; 2]],
    cut: &mut Option<Arc<Contours>>,
    watch: &Watch,
) -> Result<(f64, String), String> {
    let settings = &st.settings;
    if !(settings.baseline && st.objects.len() == 1) {
        return Ok((0.0, "skipped".into()));
    }
    let (profile, belt_job) = (&st.profile, &st.belt_job);
    let object = &st.objects[0];
    let baseline_mode = BlendMode::Single {
        strategy: StrategyId::Speed,
    };
    let baseline_started = Instant::now();
    let quiet = watch.silent();
    let baseline_plan = plan_sharing(
        &object.mesh,
        &baseline_mode,
        &object.settings.unkept(),
        plans[0].cut.bands.clone(),
        profile.nozzle_diameter,
        cut,
        &quiet,
    )?;
    let baseline_planned = plate::join(
        &[plate::Joinable {
            layers: &baseline_plan.layers,
            heads: &baseline_plan.heads,
            offset: object.to_bed(),
            label: None,
        }],
        &joined.bands,
        settings,
    );
    let baseline_owned;
    let baseline_layers: &[PlateLayer] = if let Some(job) = belt_job {
        baseline_owned = belt_output(baseline_planned, job);
        &baseline_owned
    } else {
        &baseline_planned
    };
    let baseline_belt = belt_job.as_ref().map(|job| &job.belt);
    let baseline_gcode = if settings.include_gcode {
        emit_gcode(
            baseline_layers,
            profile,
            &baseline_mode,
            st.layer_height,
            st.line_width,
            &st.features,
            settings.arc_fit,
            settings.classic_estimator,
            settings.junction_deviation_mm,
            offsets,
            baseline_belt,
            settings.flow,
            crate::gcode::RetractEmit {
                length_mm: settings.retract_length,
                speed_mm_s: settings.retract_speed,
            },
            settings.min_layer(),
            settings.job,
            &quiet,
        )
    } else {
        crate::gcode::emit_estimates(
            baseline_layers,
            profile,
            &baseline_mode,
            st.layer_height,
            st.line_width,
            &st.features,
            settings.arc_fit,
            settings.classic_estimator,
            settings.junction_deviation_mm,
            offsets,
            baseline_belt,
            settings.flow,
            crate::gcode::RetractEmit {
                length_mm: settings.retract_length,
                speed_mm_s: settings.retract_speed,
            },
            settings.min_layer(),
            settings.job,
            &quiet,
        )
    };
    if baseline_gcode.cancelled || watch.stopped(settings.job) {
        return Err("cancelled".into());
    }
    Ok((
        elapsed_ms(baseline_started),
        "single-strategy speed (same mesh, layer height, and line width)".into(),
    ))
}

/// Each object's footprint on the bed, where the G-code should fall.
fn on_bed_boxes(st: &Staged<'_>) -> Vec<([f64; 2], [f64; 2])> {
    st.objects
        .iter()
        .zip(&st.bounds)
        .enumerate()
        .map(|(i, (o, (min, max)))| {
            let [dx, dy] = if let Some(job) = &st.belt_job {
                job.offsets[i].unwrap_or([0.0, 0.0])
            } else {
                o.to_bed()
            };
            ([min[0] + dx, min[1] + dy], [max[0] + dx, max[1] + dy])
        })
        .collect()
}

/// What looks wrong with the G-code: no layers, no extrusion, or moves
/// outside the mesh.
fn sanity_notes(
    st: &Staged<'_>,
    gcode: &crate::gcode::GcodeStats,
    min_bed: [f64; 2],
    max_bed: [f64; 2],
) -> Vec<String> {
    let margin = 4.0;
    let mut notes = Vec::new();
    if gcode.layer_count == 0 {
        notes.push("no layers were produced".into());
    }
    if gcode.extrusion_moves == 0 {
        notes.push("no extrusion moves".into());
    }
    if gcode.final_e <= 0.0 {
        notes.push("final E is not positive".into());
    }
    // Gantry XY is the nozzle plane, not the lab box, so this check is cartesian only.
    if st.belt_job.is_none() {
        if gcode.min_x < min_bed[0] - margin || gcode.max_x > max_bed[0] + margin {
            notes.push(format!(
                "X bounds {:.2}..{:.2} outside mesh {:.2}..{:.2} ± {margin}",
                gcode.min_x, gcode.max_x, min_bed[0], max_bed[0]
            ));
        }
        if gcode.min_y < min_bed[1] - margin || gcode.max_y > max_bed[1] + margin {
            notes.push(format!(
                "Y bounds {:.2}..{:.2} outside mesh {:.2}..{:.2} ± {margin}",
                gcode.min_y, gcode.max_y, min_bed[1], max_bed[1]
            ));
        }
    }
    if st.settings.include_gcode && !gcode.text.contains(";LAYER:") {
        notes.push("g-code is missing layer markers".into());
    }
    notes
}

/// The mesh summary: one object's own, or the plate's union.
fn mesh_info(
    st: &Staged<'_>,
    min_bed: [f64; 2],
    max_bed: [f64; 2],
    repaired_layers: usize,
    dropped_chains: usize,
) -> MeshInfo {
    let (objects, bounds) = (&st.objects, &st.bounds);
    if st.listed {
        MeshInfo {
            triangles: objects.iter().map(|o| o.mesh.triangle_count()).sum(),
            outline_tolerance_mm: outline_tolerance(&st.settings, st.profile.nozzle_diameter),
            repaired_layers,
            dropped_chains,
            min: [
                min_bed[0],
                min_bed[1],
                bounds.iter().map(|b| b.0[2]).fold(f64::INFINITY, f64::min),
            ],
            max: [
                max_bed[0],
                max_bed[1],
                bounds
                    .iter()
                    .map(|b| b.1[2])
                    .fold(f64::NEG_INFINITY, f64::max),
            ],
        }
    } else {
        MeshInfo {
            triangles: objects[0].mesh.triangle_count(),
            outline_tolerance_mm: outline_tolerance(&st.settings, st.profile.nozzle_diameter),
            min: bounds[0].0,
            max: bounds[0].1,
            repaired_layers,
            dropped_chains,
        }
    }
}

/// Fold the finished plate into the reply: sanity notes, the preview, the
/// mesh summary, collisions, and the estimate.
fn build_reply(st: Staged<'_>, requested: &BlendMode, outcome: Outcome) -> SliceResponse {
    let Outcome {
        plans,
        joined,
        finished,
        gcode,
        gcode_text,
        stages,
        core_ms,
        views,
        baseline_ms,
        baseline_label,
        compare,
    } = outcome;
    let Staged {
        settings,
        profile,
        listed,
        objects,
        belt_job,
        ..
    } = &st;
    let emit_layers = finished.emit_layers();
    let on_bed = on_bed_boxes(&st);
    let min_bed = on_bed
        .iter()
        .map(|b| b.0)
        .reduce(|a, b| [a[0].min(b[0]), a[1].min(b[1])])
        .unwrap_or([0.0, 0.0]);
    let max_bed = on_bed
        .iter()
        .map(|b| b.1)
        .reduce(|a, b| [a[0].max(b[0]), a[1].max(b[1])])
        .unwrap_or([0.0, 0.0]);
    let notes = sanity_notes(&st, &gcode, min_bed, max_bed);

    let blends: Vec<&BlendMode> = objects.iter().map(|o| &o.blend).collect();
    let preview_sample = crate::inner_prof::Sample::start();
    let (layers, preview_token, preview_patch) = if !settings.include_preview {
        (Vec::new(), None, None)
    } else {
        let belt_tilt = belt_job.as_ref().map(|job| patch::BeltTilt {
            belt: job.belt,
            offsets: job.tilt_offsets(),
        });
        preview(
            &finished.emit_held,
            joined.kept_plate,
            profile,
            &blends,
            settings.preview_base.as_deref(),
            &gcode.layer_seconds,
            &gcode.layer_slow,
            belt_tilt.as_ref(),
        )
    };
    preview_sample.preview(layers.len() as u64);
    let repaired_layers = plans.iter().map(|plan| plan.cut.repaired_layers).sum();
    let bridged_mm: f64 = plans.iter().map(|plan| plan.cut.bridged_mm).sum();
    let dropped_chains = plans.iter().map(|plan| plan.cut.dropped_chains).sum();
    let mesh = mesh_info(&st, min_bed, max_bed, repaired_layers, dropped_chains);
    let collisions = listed.then(|| {
        let boxes: Vec<(&str, [f64; 2], [f64; 2])> = if belt_job.is_some() {
            // The plan is in the nozzle plane. The lab boxes are the overlap.
            objects
                .iter()
                .zip(&on_bed)
                .map(|(o, b)| (o.id.unwrap_or_default(), b.0, b.1))
                .collect()
        } else {
            objects
                .iter()
                .zip(&on_bed)
                .zip(&plans)
                .map(|((o, b), plan)| {
                    let [dx, dy] = o.to_bed();
                    let (lo, hi) = plate::first_layer_reach(plan, b.0, b.1, [dx, dy]);
                    (o.id.unwrap_or_default(), lo, hi)
                })
                .collect()
        };
        plate::collisions(&boxes)
    });
    let (offset, coverage, in_air, support_edits, support_paint, skeleton, objects_view) =
        if *listed {
            (None, Vec::new(), None, Vec::new(), None, None, views)
        } else {
            let view = views.into_iter().next().expect("one object");
            (
                if let Some(job) = belt_job {
                    job.offsets[0]
                } else {
                    objects[0].offset
                },
                view.coverage,
                view.in_air,
                view.support_edits,
                view.support_paint,
                view.skeleton,
                Vec::new(),
            )
        };
    let velocity_cap = velocity_cap(&gcode, profile);
    SliceResponse {
        core_ms,
        baseline_ms,
        baseline_label,
        mesh,
        offset,
        stages,
        sanity: Sanity {
            ok: notes.is_empty(),
            layers: gcode.layer_count,
            extrusion_moves: gcode.extrusion_moves,
            travel_moves: gcode.travel_moves,
            final_e: gcode.final_e,
            extrusion_length_mm: gcode.extrusion_length_mm,
            travel_length_mm: gcode.travel_length_mm,
            min_x: gcode.min_x,
            max_x: gcode.max_x,
            min_y: gcode.min_y,
            max_y: gcode.max_y,
            notes,
            retracts: gcode.retracts,
            z_hops: gcode.z_hops,
        },
        coverage,
        in_air,
        gcode: gcode.text,
        gcode_text,
        layers,
        blend: requested.describe(),
        estimate: {
            let (scarfed_loops, mean_scarf_mm, max_seam_z_step_mm) = seam_metrics(emit_layers);
            PrintEstimate {
                seconds: gcode.print_time_s,
                filament_mm: gcode.filament_mm,
                filament_g: gcode.filament_g,
                arc_moves: gcode.arc_moves,
                travel_mm: gcode.travel_length_mm,
                retracts: gcode.retracts,
                z_hops: gcode.z_hops,
                scarfed_loops,
                mean_scarf_mm,
                max_seam_z_step_mm,
                by_feature: feature_estimates(&gcode.by_feature, profile),
                velocity_cap,
            }
        },
        score: score_of(
            gcode.print_time_s,
            gcode.filament_g,
            structural_mm3(emit_layers),
        ),
        compare,
        support_edits,
        support_paint,
        skeleton,
        belt_copies: belt_job
            .as_ref()
            .filter(|job| job.belt.copies > 1)
            .map(|job| BeltCopies {
                count: job.belt.copies,
                shift_mm: job.belt.direction * job.belt.stride(job.extent),
            }),
        preview_token,
        preview_patch,
        objects: objects_view,
        collisions,
        warnings: mesh_warnings(repaired_layers, bridged_mm, dropped_chains),
        part_hold: finished.part_hold,
        beads: finished.beads,
    }
}

/// A plate preview's name and what it was drawn from, when every object came
/// from the kept stages, and the preview the client was given before.
pub(super) struct KeptPlate {
    pub(super) token: String,
    pub(super) drawn: [u8; 32],
    pub(super) prior: Option<(Arc<Vec<PlateLayer>>, Arc<patch::Shown>)>,
    pub(super) belt: Option<patch::BeltStamp>,
    /// True only when two or more objects print one at a time.
    pub(super) sequential: bool,
}
