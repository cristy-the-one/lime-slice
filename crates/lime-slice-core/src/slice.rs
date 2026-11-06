use std::sync::Arc;
use std::time::Instant;


mod assemble;
mod belt;
mod brims;
mod kept;
mod layer;
mod layer_preview;
mod pareto;
mod parts;
mod patch;
mod pipeline;
mod plan;
mod plate;
mod preview_paths;
mod regions;
mod reply;
mod resolve;
mod settings;
mod skin;
mod supports;
mod tours;
mod wire;
mod zones;

#[cfg(test)]
mod edit_cost;
#[cfg(test)]
mod tests;

pub(crate) use self::assemble::*;
use self::belt::*;
pub use self::brims::*;
pub use self::pareto::*;
pub(crate) use self::parts::*;
use self::pipeline::*;
pub use self::plan::*;
use self::preview_paths::*;
use self::regions::*;
pub use self::reply::*;
pub use self::settings::*;

pub use kept::keep_support_bases;
pub(crate) use patch::WholePreview;
pub use wire::{
    Collision, EditOutcomeView, HeightRangeSpec, ModifierVolumeSpec,
    PaintDiskSpec, SiteSpec, SupportEditSpec, VolumeKind,
};

use crate::cancel::Job;
use crate::load::load_slice_mesh_tol;
use crate::mesh::Mesh;
use crate::meshes::{self, PayloadError};
use crate::modifiers::Overrides;
use crate::progress::{Stage, Status, Watch};
use crate::strategy::{
    BlendMode, Gyroid3d, PrinterProfile, ScarfSeam, SeamPlacement, ZHopMode,
};
use crate::support::SupportStyle;
pub use crate::toolpath::SurfacePattern;

pub fn slice_request(req: &SliceRequest, job: Job) -> Result<SliceResponse, String> {
    slice_request_watched(req, job, &Watch::idle())
}

pub fn slice_request_watched(
    req: &SliceRequest,
    job: Job,
    watch: &Watch,
) -> Result<SliceResponse, String> {
    slice_request_inner(req, job, watch, false)
}

fn slice_request_inner(
    req: &SliceRequest,
    job: Job,
    watch: &Watch,
    capture_beads: bool,
) -> Result<SliceResponse, String> {
    watch.begin(Stage::Load, 1);
    if watch.stopped(job) {
        return Err("cancelled".into());
    }
    if !req.flow.is_finite() || !(0.5..=1.5).contains(&req.flow) {
        return Err(format!("flow {} must be from 0.5 to 1.5", req.flow));
    }
    let profile = req.printer.clone().unwrap_or_default();
    let order = plate_order(req)?;
    let overrides = wire::parse_overrides(req, [profile.bed_x, profile.bed_y])?;
    if let Some(ironing) = &req.ironing {
        ironing.check(SliceSettings::from_request(req).line_width)?;
    }
    if let Some(fuzzy) = &req.fuzzy_skin {
        fuzzy.check()?;
    }
    let listed = req.objects.is_some();
    let requests = if listed {
        wire::object_requests(req)?
    } else {
        Vec::new()
    };
    let load_sample = crate::inner_prof::Sample::start();
    let loaded: Vec<(Mesh, SliceSettings)> = if listed {
        requests
            .iter()
            .enumerate()
            .map(|(i, one)| {
                load_object(one, &overrides, job).map_err(|e| format!("objects[{i}]: {e}"))
            })
            .collect::<Result<_, _>>()?
    } else {
        vec![load_object(req, &overrides, job)?]
    };
    load_sample.load(loaded.iter().map(|(m, _)| m.triangle_count() as u64).sum());
    watch.tick();
    let ids = req.objects.iter().flatten().map(|o| o.id.as_str());
    let sources: Vec<Source<'_>> = if listed {
        loaded
            .iter()
            .zip(&requests)
            .zip(ids)
            .map(|(((mesh, settings), one), id)| Source {
                id: Some(id),
                mesh,
                blend: &one.blend,
                settings: settings.clone(),
            })
            .collect()
    } else {
        vec![Source {
            id: None,
            mesh: &loaded[0].0,
            blend: &req.blend,
            settings: loaded[0].1.clone(),
        }]
    };
    let settings = SliceSettings {
        job,
        capture_beads,
        ..SliceSettings::from_request(req)
    };
    slice_plate(
        &sources,
        &req.blend,
        &profile,
        &settings,
        req.belt.as_ref(),
        order,
        &mut None,
        watch,
    )
}

/// One object's mesh as the request sends it, and its settings with its
/// edits, pose, and the plate's overrides.
fn load_object(
    req: &SliceRequest,
    overrides: &Overrides,
    job: Job,
) -> Result<(Mesh, SliceSettings), String> {
    let held;
    let decoded;
    let bytes: &[u8] = match (&req.mesh_ref, req.data_b64.is_empty()) {
        (Some(id), true) => {
            held = meshes::find(id)
                .ok_or_else(|| PayloadError::UnknownMesh(vec![id.clone()]).to_string())?;
            &held
        }
        (Some(_), false) => return Err("send dataB64 or meshRef, not both".into()),
        (None, _) => {
            decoded = meshes::decode_b64(&req.data_b64)?;
            &decoded
        }
    };
    let mesh = load_slice_mesh_tol(
        &req.filename,
        bytes,
        req.pose.is_some(),
        req.step_tolerance_mm,
    )?;
    wire::parse_support_source(req.support_source.as_deref())?;
    let settings = SliceSettings {
        job,
        support_edits: wire::parse_support_edits(&req.support_edits)?,
        support_paint: wire::parse_support_paint(&req.support_paint)?,
        seam_paint: wire::parse_seam_paint(&req.seam_paint)?,
        reinforcement: crate::reinforcement::parse(&req.reinforcement)?,
        overrides: overrides.clone(),
        ..SliceSettings::from_request(req)
    };
    Ok((mesh, settings))
}

/// An object of a plate before its part frame is taken: the mesh as loaded,
/// and its settings with `pose` still set.
struct Source<'a> {
    /// `None` when the request omitted `objects`.
    id: Option<&'a str>,
    mesh: &'a Mesh,
    blend: &'a BlendMode,
    settings: SliceSettings,
}

/// Plan `req` into the kept stages and note its preview as the one the
/// client holds, so the next request of the same part reuses every stage and
/// gets a patch. For a reply the client got from elsewhere, such as the disk.
/// Does nothing when no stages are kept or `req` draws no preview.
pub(crate) fn warm_kept(req: SliceRequest, job: Job) {
    if !kept::on() || !req.include_preview {
        return;
    }
    let req = SliceRequest {
        baseline: false,
        compare: false,
        include_gcode: false,
        include_skeleton: false,
        part_hold: false,
        preview_base: None,
        ..req
    };
    let _ = slice_request_watched(&req, job, &Watch::idle());
}

pub fn slice_with_baseline(
    mesh: &Mesh,
    blend: &BlendMode,
    profile: &PrinterProfile,
    layer_height: f64,
    line_width: f64,
) -> Result<SliceResponse, String> {
    slice_configured(
        mesh,
        blend,
        profile,
        &SliceSettings {
            layer_height,
            line_width,
            ..SliceSettings::default()
        },
    )
}

pub fn slice_configured(
    mesh: &Mesh,
    blend: &BlendMode,
    profile: &PrinterProfile,
    settings: &SliceSettings,
) -> Result<SliceResponse, String> {
    slice_sharing(mesh, blend, profile, settings, &mut None, &Watch::idle())
}

/// `slice_configured`, publishing into `watch` and leaving it `done`,
/// `cancelled`, or `error` when this returns.
pub fn slice_configured_watched(
    mesh: &Mesh,
    blend: &BlendMode,
    profile: &PrinterProfile,
    settings: &SliceSettings,
    watch: &Watch,
) -> Result<SliceResponse, String> {
    let result = slice_sharing(mesh, blend, profile, settings, &mut None, watch);
    watch.finish(Status::of(&result));
    result
}

/// `slice_configured`, sharing the cut through `cut` as `plan_sharing` does.
fn slice_sharing(
    mesh: &Mesh,
    blend: &BlendMode,
    profile: &PrinterProfile,
    settings: &SliceSettings,
    cut: &mut Option<Arc<Contours>>,
    watch: &Watch,
) -> Result<SliceResponse, String> {
    let source = Source {
        id: None,
        mesh,
        blend,
        settings: settings.clone(),
    };
    slice_plate(
        &[source],
        blend,
        profile,
        settings,
        None,
        PlateOrder::AllAtOnce,
        cut,
        watch,
    )
}

/// How a plate joins its objects. All-at-once is the omitted default.
/// Sequential carries the clearance already resolved, never zero.
#[derive(Clone, Copy)]
enum PlateOrder {
    AllAtOnce,
    Sequential { clearance_mm: f64, gantry_mm: f64 },
}

/// Reach of a typical toolhead around its nozzle: heater block, fan duct and
/// carriage. A plate printed one object at a time keeps each object this far
/// from every earlier one unless the request says how far its head reaches.
const SEQUENTIAL_TOOLHEAD_MM: f64 = 35.0;
/// Height of a typical gantry above the nozzle tip. Only the last object of a
/// plate printed one object at a time may be taller.
const SEQUENTIAL_GANTRY_MM: f64 = 20.0;

/// `printOrder` and `sequentialClearanceMm`. A bad value is an error before
/// any mesh is planned. Omitted order is all-at-once.
fn plate_order(req: &SliceRequest) -> Result<PlateOrder, String> {
    let sequential = match req.print_order.as_deref() {
        None | Some("all-at-once") => false,
        Some("sequential") => true,
        Some(other) => {
            return Err(format!(
                "printOrder \"{other}\" is not a print order; send \"all-at-once\" or \"sequential\""
            ))
        }
    };
    if let Some(n) = req.sequential_clearance_mm {
        if !sequential {
            return Err(
                "sequentialClearanceMm is sent only with printOrder \"sequential\"".into(),
            );
        }
        if !n.is_finite() || !(0.0..=100.0).contains(&n) {
            return Err(format!("sequentialClearanceMm {n} must be from 0 to 100"));
        }
    }
    if let Some(n) = req.sequential_gantry_mm {
        if !sequential {
            return Err("sequentialGantryMm is sent only with printOrder \"sequential\"".into());
        }
        if !n.is_finite() || !(0.0..=500.0).contains(&n) {
            return Err(format!("sequentialGantryMm {n} must be from 0 to 500"));
        }
    }
    if !sequential {
        return Ok(PlateOrder::AllAtOnce);
    }
    // The belt advances once per layer. Starting the next object again at its
    // first layer would run the belt backwards into the head.
    if req.belt.is_some() {
        return Err("printOrder \"sequential\" is not available on a belt printer".into());
    }
    let set = |n: Option<f64>, auto: f64| match n {
        Some(n) if n > 1e-9 => n,
        _ => auto,
    };
    Ok(PlateOrder::Sequential {
        clearance_mm: set(req.sequential_clearance_mm, SEQUENTIAL_TOOLHEAD_MM),
        gantry_mm: set(req.sequential_gantry_mm, SEQUENTIAL_GANTRY_MM),
    })
}

/// The settings the stages read: lengths clamped, and every later feature
/// off under `classic`.
fn resolved(settings: &SliceSettings) -> SliceSettings {
    let mut settings = SliceSettings {
        layer_height: settings.layer_height.clamp(0.05, 0.6),
        line_width: settings.line_width.clamp(0.15, 1.2),
        ..settings.clone()
    };
    if settings.classic {
        settings.variable_width = false;
        settings.arc_fit = false;
        settings.travel_opt = false;
        settings.overhang_control = false;
        settings.infill_combine = false;
        settings.combing = false;
        settings.feature_speeds = false;
        settings.seam = SeamPlacement::Blend;
        settings.ironing = None;
        settings.fuzzy_skin = None;
        settings.scarf_seam = ScarfSeam::Off;
        settings.gyroid_3d = Gyroid3d::Off;
        settings.z_hop = ZHopMode::Off;
        settings.support_style = SupportStyle::Grid;
        settings.support_height_mult = 1.0;
        settings.support_avoidance = false;
        settings.support_strict_stacking = false;
        settings.support_paint_join = false;
        settings.support_slow_fragile = false;
        settings.support_gentle_speed_mm_s = None;
        settings.support_gentle_accel_mm_s2 = None;
        settings.support_z_gap_mm = None;
        settings.support_xy_gap_mm = None;
        settings.support_interface_layers = None;
        settings.support_tree_brim_mm = None;
        settings.support_anchor_mm = None;
        settings.bridge_flow_ratio = None;
        settings.bridge_speed_mm_s = None;
        settings.bridge_fan_percent = None;
    }
    settings
}

fn elapsed_ms(started: Instant) -> f64 {
    started.elapsed().as_secs_f64() * 1000.0
}
