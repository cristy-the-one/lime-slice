//! Support edits and plate objects as the request carries them, and edit
//! outcomes and objects as the response reports them.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use super::{RigidPose, SliceRequest};
use crate::adaptive::LayerBand;
use crate::modifiers::{HeightRange, Overrides, Shape, Tweak, Volume};
use crate::support::edit::{EditOutcome, EditStatus, SupportEdit, TipSite};
use crate::support::paint::PaintTally;
use crate::support::paint::{PaintDisk, PaintKind, SeamDisk};
use crate::support::skeleton::SupportSkeleton;
use crate::support::{CoverageGap, InAir};

/// One object of a plate on the wire.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ObjectSpec {
    pub id: String,
    pub filename: String,
    /// The mesh bytes, unless `meshRef` names them.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub data_b64: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mesh_ref: Option<String>,
    /// Absent means the bytes are already in print space.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pose: Option<RigidPose>,
    /// STEP chord tolerance for this object. Absent uses the request's.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub step_tolerance_mm: Option<f64>,
    /// Request keys this object overrides. See `SETTING_SCOPES`.
    #[serde(default, skip_serializing_if = "Map::is_empty")]
    pub settings: Map<String, Value>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub support_edits: Vec<SupportEditSpec>,
    /// In this object's mesh frame, like its own `supportEdits`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub support_paint: Vec<PaintDiskSpec>,
    /// Seam disks in this object's mesh frame. Omitted when empty.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub seam_paint: Vec<SeamDiskSpec>,
}

/// Who may set a request key.
enum Scope {
    Object,
    /// A plate setting the plate leaves out at its default, so the plate's
    /// own keys cannot name it.
    Plate,
    NotYet,
}

/// Keys an object may set, and the override keys it may not set yet: ranges
/// and volumes are plate-wide and reach every object they meet. Every other
/// request key is a plate setting.
const SETTING_SCOPES: &[(&str, Scope)] = &[
    ("blend", Scope::Object),
    ("supports", Scope::Object),
    ("supportAngle", Scope::Object),
    ("supportStyle", Scope::Object),
    ("tipDiameter", Scope::Object),
    ("trunkDiameter", Scope::Object),
    ("branchAngle", Scope::Object),
    ("supportHeightMult", Scope::Object),
    ("scarfSeam", Scope::Object),
    ("scarfLength", Scope::Object),
    ("scarfSteps", Scope::Object),
    ("scarfStartHeight", Scope::Object),
    ("scarfStartFlow", Scope::Object),
    ("gyroid3d", Scope::Object),
    ("infillCombine", Scope::Object),
    ("variableWidth", Scope::Object),
    ("seam", Scope::Plate),
    ("ironing", Scope::Plate),
    ("fuzzySkin", Scope::Plate),
    ("flow", Scope::Plate),
    ("heightRanges", Scope::Plate),
    ("modifierVolumes", Scope::Plate),
    ("infill", Scope::NotYet),
    ("walls", Scope::NotYet),
    ("speed", Scope::NotYet),
];

const MAX_OBJECTS: usize = 256;

/// The request each object is sliced with: the plate's request with that
/// object's settings written over it, and its own mesh, pose, and edits.
/// Every refusal of a plate request is here, and each names its field.
pub(crate) fn object_requests(req: &SliceRequest) -> Result<Vec<SliceRequest>, String> {
    let Some(objects) = &req.objects else {
        return Err("no objects".into());
    };
    match req.print_order.as_deref() {
        None | Some("all-at-once") => {}
        Some("sequential") => {
            return Err(
                "printOrder \"sequential\" is not supported yet; omit it or send \"all-at-once\""
                    .into(),
            )
        }
        Some(other) => {
            return Err(format!(
                "printOrder \"{other}\" is not a print order; send \"all-at-once\""
            ))
        }
    }
    if objects.is_empty() {
        return Err("objects is empty; send at least one object".into());
    }
    if objects.len() > MAX_OBJECTS {
        return Err(format!(
            "objects has {} entries, at most {MAX_OBJECTS} are allowed",
            objects.len()
        ));
    }
    for (field, sent) in [
        ("filename", !req.filename.is_empty()),
        ("dataB64", !req.data_b64.is_empty()),
        ("meshRef", req.mesh_ref.is_some()),
        ("pose", req.pose.is_some()),
        ("supportEdits", !req.support_edits.is_empty()),
        ("supportPaint", !req.support_paint.is_empty()),
        ("seamPaint", !req.seam_paint.is_empty()),
    ] {
        if sent {
            return Err(format!(
                "{field} belongs on each object when objects is sent"
            ));
        }
    }
    if req.compare {
        return Err("compare is not supported with objects yet".into());
    }
    // `objects` is never serialized, so this is the plate's request alone.
    let plate = serde_json::to_value(req).map_err(|e| e.to_string())?;
    let mut seen = std::collections::HashSet::new();
    objects
        .iter()
        .enumerate()
        .map(|(i, spec)| {
            let id_ok = !spec.id.is_empty()
                && spec.id.len() <= 64
                && spec
                    .id
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b));
            if !id_ok {
                return Err(format!(
                    "objects[{i}].id \"{}\" must be 1 to 64 of A-Z a-z 0-9 . _ -",
                    spec.id
                ));
            }
            if !seen.insert(spec.id.as_str()) {
                return Err(format!("objects[{i}].id \"{}\" is used twice", spec.id));
            }
            let mut merged = plate.clone();
            for (key, value) in &spec.settings {
                match SETTING_SCOPES.iter().find(|(k, _)| k == key) {
                    Some((_, Scope::Object)) => merged[key] = value.clone(),
                    Some((_, Scope::Plate)) => {
                        return Err(format!("objects[{i}].settings.{key} is a plate setting"))
                    }
                    Some((_, Scope::NotYet)) => {
                        return Err(format!("objects[{i}].settings.{key} is not supported yet"))
                    }
                    None if plate.get(key).is_some() => {
                        return Err(format!("objects[{i}].settings.{key} is a plate setting"))
                    }
                    None => return Err(format!("objects[{i}].settings.{key} is not a setting")),
                }
            }
            let mut one: SliceRequest = serde_json::from_value(merged)
                .map_err(|e| format!("objects[{i}].settings: {e}"))?;
            one.filename = spec.filename.clone();
            one.data_b64 = spec.data_b64.clone();
            one.mesh_ref = spec.mesh_ref.clone();
            one.pose = spec.pose;
            one.support_edits = spec.support_edits.clone();
            one.support_paint = spec.support_paint.clone();
            one.seam_paint = spec.seam_paint.clone();
            if let Some(tol) = spec.step_tolerance_mm {
                one.step_tolerance_mm = tol;
            }
            Ok(one)
        })
        .collect()
}

/// One object of the plate as the reply reports it, in its part frame.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectView {
    pub id: String,
    pub min: [f64; 3],
    pub max: [f64; 3],
    pub triangles: usize,
    /// Where its part frame sits on the bed.
    pub offset: [f64; 2],
    pub coverage: Vec<CoverageGap>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub in_air: Option<InAir>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skeleton: Option<SupportSkeleton>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub support_edits: Vec<EditOutcomeView>,
    /// Only when the object was sent with paint.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub support_paint: Option<PaintTally>,
    /// Stages taken from memory, as `StageTimes.reused` names them.
    pub reused: Vec<&'static str>,
}

/// Two objects whose XY boxes on the bed overlap.
#[derive(Clone, Debug, Serialize)]
pub struct Collision {
    pub a: String,
    pub b: String,
    /// The overlap, `[min x, min y, max x, max y]`, mm.
    pub overlap: [f64; 4],
}

/// One support edit on the wire. `kind` picks the variant.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum SupportEditSpec {
    /// Remove the limbs born at `sites`.
    Prune { sites: Vec<SiteSpec> },
    /// Grow fresh limbs for the unheld demand inside `region`, on the
    /// layers whose z lies within `z`, low then high.
    Regrow {
        region: Vec<Vec<[f64; 2]>>,
        z: [f64; 2],
    },
}

/// A birth site: xy in mm at the band z the skeleton reported.
#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SiteSpec {
    pub xy: [f64; 2],
    pub z: f64,
}

const MAX_EDITS: usize = 1000;
const MAX_SITES: usize = 200_000;
const MAX_REGION_POINTS: usize = 100_000;
const MAX_MM: f64 = 100_000.0;

/// One support paint disk on the wire, in the mesh frame of the object it
/// was painted on: the frame of the mesh bytes, before the pose.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct PaintDiskSpec {
    /// `enforce` or `block`.
    pub kind: String,
    pub p: [f64; 3],
    pub n: [f64; 3],
    pub r: f64,
}

const MAX_PAINT_DISKS: usize = 20_000;
const PAINT_RADIUS_MM: std::ops::RangeInclusive<f64> = 0.2..=40.0;

/// Checks every disk and turns it into the engine's form, with a unit
/// normal. The error names the disk, as `supportPaint[3].r`.
pub(crate) fn parse_support_paint(specs: &[PaintDiskSpec]) -> Result<Vec<PaintDisk>, String> {
    if specs.len() > MAX_PAINT_DISKS {
        return Err(format!(
            "supportPaint has {} disks, at most {MAX_PAINT_DISKS} are allowed",
            specs.len()
        ));
    }
    specs
        .iter()
        .enumerate()
        .map(|(k, spec)| {
            let field = |name: &str| format!("supportPaint[{k}].{name}");
            let kind = match spec.kind.as_str() {
                "enforce" => PaintKind::Enforce,
                "block" => PaintKind::Block,
                other => {
                    return Err(format!(
                        "{} \"{other}\" is not enforce or block",
                        field("kind")
                    ))
                }
            };
            for (name, v) in [("p", &spec.p), ("n", &spec.n)] {
                if v.iter().any(|c| !c.is_finite()) {
                    return Err(format!("{} is not finite", field(name)));
                }
                if v.iter().any(|c| c.abs() > MAX_MM) {
                    return Err(format!("{} is out of range", field(name)));
                }
            }
            if !spec.r.is_finite() || !PAINT_RADIUS_MM.contains(&spec.r) {
                return Err(format!(
                    "{} is {} mm, it must be {} to {} mm",
                    field("r"),
                    spec.r,
                    PAINT_RADIUS_MM.start(),
                    PAINT_RADIUS_MM.end()
                ));
            }
            let len = spec.n.iter().map(|c| c * c).sum::<f64>().sqrt();
            if len < 1e-9 {
                return Err(format!("{} has no length", field("n")));
            }
            Ok(PaintDisk {
                kind,
                p: spec.p,
                n: spec.n.map(|c| c / len),
                r: spec.r,
            })
        })
        .collect()
}

/// One seam paint disk on the wire, in the mesh frame of the object it was
/// painted on. No kind: every disk pulls the seam.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SeamDiskSpec {
    pub p: [f64; 3],
    pub n: [f64; 3],
    pub r: f64,
}

/// Checks every disk and turns it into the engine's form, with a unit
/// normal. The error names the disk, as `seamPaint[3].r`.
pub(crate) fn parse_seam_paint(specs: &[SeamDiskSpec]) -> Result<Vec<SeamDisk>, String> {
    if specs.len() > MAX_PAINT_DISKS {
        return Err(format!(
            "seamPaint has {} disks, at most {MAX_PAINT_DISKS} are allowed",
            specs.len()
        ));
    }
    specs
        .iter()
        .enumerate()
        .map(|(k, spec)| {
            let field = |name: &str| format!("seamPaint[{k}].{name}");
            for (name, v) in [("p", &spec.p), ("n", &spec.n)] {
                if v.iter().any(|c| !c.is_finite()) {
                    return Err(format!("{} is not finite", field(name)));
                }
                if v.iter().any(|c| c.abs() > MAX_MM) {
                    return Err(format!("{} is out of range", field(name)));
                }
            }
            if !spec.r.is_finite() || !PAINT_RADIUS_MM.contains(&spec.r) {
                return Err(format!(
                    "{} is {} mm, it must be {} to {} mm",
                    field("r"),
                    spec.r,
                    PAINT_RADIUS_MM.start(),
                    PAINT_RADIUS_MM.end()
                ));
            }
            let len = spec.n.iter().map(|c| c * c).sum::<f64>().sqrt();
            if len < 1e-9 {
                return Err(format!("{} has no length", field("n")));
            }
            Ok(SeamDisk {
                p: spec.p,
                n: spec.n.map(|c| c / len),
                r: spec.r,
            })
        })
        .collect()
}

/// Checks every edit and turns it into the engine's form. The error names
/// the edit, as `supportEdits[1]: a prune needs at least one site`.
pub(crate) fn parse_support_edits(specs: &[SupportEditSpec]) -> Result<Vec<SupportEdit>, String> {
    if specs.len() > MAX_EDITS {
        return Err(format!(
            "supportEdits: {} edits, at most {MAX_EDITS} are allowed",
            specs.len()
        ));
    }
    let (mut sites, mut points) = (0usize, 0usize);
    specs
        .iter()
        .enumerate()
        .map(|(n, spec)| {
            parse_one(spec, &mut sites, &mut points).map_err(|e| format!("supportEdits[{n}]: {e}"))
        })
        .collect()
}

fn parse_one(
    spec: &SupportEditSpec,
    sites: &mut usize,
    points: &mut usize,
) -> Result<SupportEdit, String> {
    match spec {
        SupportEditSpec::Prune { sites: specs } => {
            if specs.is_empty() {
                return Err("a prune needs at least one site".into());
            }
            *sites += specs.len();
            if *sites > MAX_SITES {
                return Err(format!("more than {MAX_SITES} sites across all edits"));
            }
            specs
                .iter()
                .map(|s| {
                    finite(s.xy[0], "site x")?;
                    finite(s.xy[1], "site y")?;
                    finite(s.z, "site z")?;
                    Ok(TipSite { xy: s.xy, z: s.z })
                })
                .collect::<Result<_, String>>()
                .map(|sites| SupportEdit::Prune { sites })
        }
        SupportEditSpec::Regrow { region, z } => {
            if region.is_empty() {
                return Err("a regrow needs at least one region loop".into());
            }
            for (l, lp) in region.iter().enumerate() {
                if lp.len() < 3 {
                    return Err(format!(
                        "region loop {l} has {} points, at least 3 are needed",
                        lp.len()
                    ));
                }
                for p in lp {
                    finite(p[0], "region x")?;
                    finite(p[1], "region y")?;
                }
            }
            *points += region.iter().map(Vec::len).sum::<usize>();
            if *points > MAX_REGION_POINTS {
                return Err(format!(
                    "more than {MAX_REGION_POINTS} region points across all edits"
                ));
            }
            finite(z[0], "z low")?;
            finite(z[1], "z high")?;
            if z[0] > z[1] {
                return Err(format!(
                    "z range {} to {} has its low end above its high end",
                    z[0], z[1]
                ));
            }
            Ok(SupportEdit::Regrow {
                region: region.clone(),
                z: *z,
            })
        }
    }
}

fn finite(v: f64, what: &str) -> Result<(), String> {
    if v.is_finite() && v.abs() <= MAX_MM {
        Ok(())
    } else {
        Err(format!(
            "{what} {v} is not a finite coordinate within {MAX_MM} mm"
        ))
    }
}

/// What one edit did, as the response reports it.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditOutcomeView {
    #[serde(flatten)]
    pub status: EditStatus,
    /// Layers whose printed support changed.
    pub changed_layers: usize,
    /// Lowest and highest changed layer, as `PreviewLayer.index` numbers them. Absent when none changed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub changed_span: Option<[usize; 2]>,
    /// Coverage area after the edit less the area before it, mm².
    pub newly_floating_mm2: f64,
    /// Coverage gaps the edit leaves, specks included.
    pub floating: Vec<CoverageGap>,
}

impl EditOutcomeView {
    pub(crate) fn of(outcome: &EditOutcome, bands: &[LayerBand]) -> Self {
        let span = outcome
            .changed
            .first()
            .zip(outcome.changed.last())
            .map(|(&lo, &hi)| [bands[lo].index, bands[hi].index]);
        Self {
            status: outcome.status,
            changed_layers: outcome.changed.len(),
            changed_span: span,
            newly_floating_mm2: outcome.newly_floating_mm2,
            floating: outcome.floating.clone(),
        }
    }
}

/// One height range on the wire.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HeightRangeSpec {
    /// Print Z, low then high. A layer whose z lies inside, ends included,
    /// takes the range.
    pub z: [f64; 2],
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub infill: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub walls: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub speed: Option<f64>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum VolumeKind {
    Box,
    Cylinder,
    Sphere,
}

/// One modifier volume on the wire, in bed millimetres. Axis-aligned.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModifierVolumeSpec {
    pub kind: VolumeKind,
    pub center: [f64; 3],
    /// Full extent along X, Y, and Z.
    pub size: [f64; 3],
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub infill: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub walls: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub speed: Option<f64>,
}

const MAX_OVERRIDES: usize = 64;
const MIN_EXTENT_MM: f64 = 0.2;
const MAX_WALLS: u32 = 12;
const MAX_SPEED: f64 = 1000.0;

/// Checks every range and volume and turns them into the engine's form.
/// The error names the entry and its field, as
/// `heightRanges[0]: walls 0 is outside 1 to 12`.
pub(crate) fn parse_overrides(req: &SliceRequest, bed: [f64; 2]) -> Result<Overrides, String> {
    for (field, n) in [
        ("heightRanges", req.height_ranges.len()),
        ("modifierVolumes", req.modifier_volumes.len()),
    ] {
        if n > MAX_OVERRIDES {
            return Err(format!(
                "{field}: {n} entries, at most {MAX_OVERRIDES} are allowed"
            ));
        }
    }
    let ranges = req
        .height_ranges
        .iter()
        .enumerate()
        .map(|(n, r)| range(r).map_err(|e| format!("heightRanges[{n}]: {e}")))
        .collect::<Result<_, _>>()?;
    let volumes = req
        .modifier_volumes
        .iter()
        .enumerate()
        .map(|(n, v)| volume(v, n, bed).map_err(|e| format!("modifierVolumes[{n}]: {e}")))
        .collect::<Result<_, _>>()?;
    Ok(Overrides { ranges, volumes })
}

fn range(r: &HeightRangeSpec) -> Result<HeightRange, String> {
    finite(r.z[0], "z low")?;
    finite(r.z[1], "z high")?;
    if r.z[0] > r.z[1] {
        return Err(format!("z runs low to high, got {} to {}", r.z[0], r.z[1]));
    }
    Ok(HeightRange {
        z: r.z,
        tweak: tweak(r.infill, r.walls, r.speed)?,
    })
}

fn volume(v: &ModifierVolumeSpec, index: usize, bed: [f64; 2]) -> Result<Volume, String> {
    for (c, axis) in v.center.iter().zip(["center x", "center y", "center z"]) {
        finite(*c, axis)?;
    }
    // The profile has no bed height, so Z is bounded like a coordinate.
    for (s, (axis, most)) in v
        .size
        .iter()
        .zip([("x", bed[0]), ("y", bed[1]), ("z", MAX_MM)])
    {
        if !(s.is_finite() && (MIN_EXTENT_MM..=most).contains(s)) {
            return Err(format!(
                "size {axis} {s} is outside {MIN_EXTENT_MM} to {most} mm"
            ));
        }
    }
    Ok(Volume {
        shape: match v.kind {
            VolumeKind::Box => Shape::Box,
            VolumeKind::Cylinder => Shape::Cylinder,
            VolumeKind::Sphere => Shape::Sphere,
        },
        center: v.center,
        size: v.size,
        tweak: tweak(v.infill, v.walls, v.speed)?,
        index,
    })
}

fn tweak(infill: Option<f64>, walls: Option<u32>, speed: Option<f64>) -> Result<Tweak, String> {
    if let Some(f) = infill.filter(|f| !(f.is_finite() && (0.0..=1.0).contains(f))) {
        return Err(format!("infill {f} is outside 0 to 1"));
    }
    if let Some(w) = walls.filter(|w| !(1..=MAX_WALLS).contains(w)) {
        return Err(format!("walls {w} is outside 1 to {MAX_WALLS}"));
    }
    if let Some(s) = speed.filter(|s| !(s.is_finite() && *s > 0.0 && *s <= MAX_SPEED)) {
        return Err(format!("speed {s} is outside 0 to {MAX_SPEED} mm/s"));
    }
    Ok(Tweak {
        infill,
        walls,
        speed,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_non_finite_paint_disk_names_its_field() {
        let disk = |p: [f64; 3], n: [f64; 3], r: f64| PaintDiskSpec {
            kind: "block".into(),
            p,
            n,
            r,
        };
        let refuse = |spec| parse_support_paint(&[spec]).unwrap_err();
        assert_eq!(
            refuse(disk([f64::NAN, 0.0, 0.0], [0.0, 0.0, 1.0], 1.0)),
            "supportPaint[0].p is not finite"
        );
        assert_eq!(
            refuse(disk([0.0, 0.0, 0.0], [0.0, f64::INFINITY, 1.0], 1.0)),
            "supportPaint[0].n is not finite"
        );
        assert_eq!(
            refuse(disk([0.0, 0.0, 0.0], [0.0, 0.0, 1.0], f64::NAN)),
            "supportPaint[0].r is NaN mm, it must be 0.2 to 40 mm"
        );
        let ok = parse_support_paint(&[disk([1.0, 2.0, 3.0], [0.0, 0.0, -2.0], 0.2)]).unwrap();
        assert_eq!(ok[0].n, [0.0, 0.0, -1.0]);
    }
}
