//! Support edits and plate objects as the request carries them, and edit
//! outcomes and objects as the response reports them.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use super::{RigidPose, SliceRequest};
use crate::adaptive::LayerBand;
use crate::support::edit::{EditOutcome, EditStatus, SupportEdit, TipSite};
use crate::support::skeleton::SupportSkeleton;
use crate::support::{CoverageGap, InAir};

/// One object of a plate on the wire.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ObjectSpec {
    pub id: String,
    pub filename: String,
    pub data_b64: String,
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
}

/// Who may set a request key.
enum Scope {
    Object,
    NotYet,
}

/// Keys an object may set, and keys it will once modifiers land. Every
/// other request key is a plate setting.
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
        ("pose", req.pose.is_some()),
        ("supportEdits", !req.support_edits.is_empty()),
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
            one.pose = spec.pose;
            one.support_edits = spec.support_edits.clone();
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
