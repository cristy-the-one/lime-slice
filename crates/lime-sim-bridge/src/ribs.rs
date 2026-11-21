//! Auto ribs, the engine side (docs/plan-auto-ribs.md, step 6): the wall
//! `src/modeling/rib-wall.ts` reads off a solid, plus the rules, the goal
//! and the options, in; the rib planner's plan out, as JSON.
//!
//! The wire names are camelCase and match `ribWall`'s `request` field for
//! field (`mesh`, `holds`, `loadCases`, `zones`, `clearance`, `side`), so the
//! TypeScript side sends what `ribWall` returned without reshaping it.
//! `clearance` is `null` where nothing faces the wall (JSON has no Infinity):
//! no cap there.
//!
//! A plan runs as a [`RibJob`]: a worker thread, a cancel flag, and a queue
//! of progress events the caller drains with [`RibJob::poll`]. A cancel
//! returns the plan as it stood (`stoppedEarly`), never an error. The MCP
//! engine keeps the jobs; a desktop command can keep them the same way.
//!
//! The rib section is `rules.profile`: a fixed one (straight, drafted, tee)
//! or `auto` (the planner's `choose_profile` from the process and the flange
//! that prints in the current pose, which only the caller knows). Each
//! planned rib comes back with the section of every stretch, as `ribNet`
//! builds it.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use lime_sim::shell::planner::{
    choose_profile, plan_ribs_with, Family, FlangeShape, Goal, Holds, LoadCombine, LooseEndReason, PlanControl, PlanEvent,
    PlanStage, PlannerOptions, Process, ProfileRules, RibChange, RibEndKind, RibPlan,
    RibPlanRequest, RibProfile, RibRules, Zone, ZoneMode,
};
use lime_sim::shell::{IsotropicShell, RibSection, RibSide, ShellHold, ShellLoad, ShellMesh};
use serde::Deserialize;
use serde_json::{json, Value};

/// The most progress events a job keeps unread. A caller that never reads
/// loses the oldest; the totals in each event keep the running state.
pub const EVENT_CAP: usize = 4000;

/// `ribWall`'s `request.mesh`: the wall's mid-surface.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WireMesh {
    pub vertices: Vec<[f64; 3]>,
    pub triangles: Vec<[u32; 3]>,
    pub thickness: Vec<f64>,
}

/// One held vertex: each dof `0` (held at zero) or `null` (free), order
/// `[ux, uy, uz, θx, θy, θz]`.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WireHold {
    pub node: u32,
    pub dofs: [Option<f64>; 6],
}

#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum WireHolds {
    /// `ribWall`'s holds: the joined borders and the user's holds, clamped.
    Given { holds: Vec<WireHold> },
    AllBoundary,
    OuterBoundary,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum WireLoad {
    Force { node: u32, force: [f64; 3] },
    Moment { node: u32, moment: [f64; 3] },
    Pressure { triangles: Vec<u32>, pressure: f64 },
    SpreadForce { triangles: Vec<u32>, force: [f64; 3] },
}

#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum WireZoneMode {
    NoRibs,
    MaxHeight { mm: f64 },
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WireZone {
    pub triangles: Vec<u32>,
    pub mode: WireZoneMode,
    pub margin: f64,
}

/// `ribWall`'s `request`, as it comes.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WallRequest {
    pub mesh: WireMesh,
    pub holds: WireHolds,
    #[serde(default)]
    pub load_cases: Vec<Vec<WireLoad>>,
    #[serde(default)]
    pub zones: Vec<WireZone>,
    /// Room in front of the wall per vertex, mm; `null` where nothing
    /// faces it.
    #[serde(default)]
    pub clearance: Vec<Option<f64>>,
    /// "positive" (the side the normals point out of: the cavity) or
    /// "negative".
    #[serde(default = "positive")]
    pub side: String,
}

fn positive() -> String {
    "positive".into()
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WireMaterial {
    /// Young's modulus, MPa.
    pub e: f64,
    pub nu: f64,
    /// Mass density, g/cm³. A stiffness plan leaves it out. 1 g/cm³ is
    /// 1e-9 N·s²/mm⁴, which is what [`IsotropicShell::with_density`] stores.
    #[serde(default, rename = "densityGCm3")]
    pub density_g_cm3: Option<f64>,
    /// The card's name, used only when a frequency goal has no density.
    #[serde(default)]
    pub name: Option<String>,
}

/// g/cm³ to N·s²/mm⁴. 1 g/cm³ = 1000 kg/m³ = 1e-9 N·s²/mm⁴.
const DENSITY_G_CM3_TO_N_S2_MM4: f64 = 1e-9;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WireRules {
    pub width: f64,
    pub max_height: f64,
    #[serde(default)]
    pub min_height: Option<f64>,
    pub min_spacing: f64,
    pub min_length: f64,
    #[serde(default)]
    pub extend_limit: Option<f64>,
    /// The rib section. Default `{kind: "auto", process: "filament",
    /// flange: null}`: straight.
    #[serde(default)]
    pub profile: Option<WireProfile>,
}

/// A flange underside, as the caller found it prints.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum WireFlange {
    Chamfered,
    Square,
}

impl From<WireFlange> for FlangeShape {
    fn from(f: WireFlange) -> Self {
        match f {
            WireFlange::Chamfered => FlangeShape::Chamfered,
            WireFlange::Square => FlangeShape::Square,
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum WireProcess {
    Filament,
    Resin,
    Moulded,
}

/// `rules.profile`. A field left out takes `ribNet`'s default.
#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum WireProfile {
    /// The planner's own choice: [`choose_profile`].
    #[serde(rename_all = "camelCase")]
    Auto {
        #[serde(default)]
        process: Option<WireProcess>,
        /// The flange underside that prints in this pose; null for none.
        #[serde(default)]
        flange: Option<WireFlange>,
    },
    #[serde(alias = "rectangular")]
    Straight,
    #[serde(rename_all = "camelCase")]
    Drafted {
        #[serde(default)]
        draft_deg: Option<f64>,
        #[serde(default)]
        root_radius: Option<f64>,
    },
    #[serde(rename_all = "camelCase")]
    Tee {
        #[serde(default)]
        flange: Option<WireFlange>,
        #[serde(default)]
        flange_width: Option<f64>,
        #[serde(default)]
        flange_thickness: Option<f64>,
        #[serde(default)]
        flange_chamfer_deg: Option<f64>,
        #[serde(default)]
        root_radius: Option<f64>,
    },
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum WireGoal {
    Stiffer {
        factor: f64,
    },
    MaxDeflection {
        mm: f64,
    },
    #[serde(rename_all = "camelCase")]
    Budget {
        volume_mm3: f64,
    },
    Balanced,
    /// Raise the lowest natural frequency by this factor. One goal: the
    /// caller refuses a budget or another goal beside it.
    Frequency {
        factor: f64,
    },
    /// Hold at least this multiple of the chosen load before the wall
    /// buckles. `on` is the load-case index when there are two or more
    /// cases. Plate Kg only: no membrane Kg and no beam Kg (the solver).
    #[serde(rename_all = "camelCase")]
    Buckling {
        factor: f64,
        #[serde(default)]
        on: Option<usize>,
    },
}

#[derive(Clone, Copy, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WireOptions {
    #[serde(default)]
    pub shortlist: Option<usize>,
    #[serde(default)]
    pub workers: Option<usize>,
    #[serde(default)]
    pub baselines: Option<bool>,
    /// Plan across creases (`PlannerOptions::creases`). The callers set it
    /// only for a wall extracted with `folded`; absent or false plans as
    /// v6.12 did.
    #[serde(default)]
    pub creases: Option<bool>,
}

/// The whole call: `ribWall`'s request and what the planner needs besides.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RibPlanBody {
    pub request: WallRequest,
    #[serde(default)]
    pub material: Option<WireMaterial>,
    pub rules: WireRules,
    #[serde(default)]
    pub goal: Option<WireGoal>,
    #[serde(default)]
    pub options: Option<WireOptions>,
    /// Keep this far from every hole's rim, mm. Default 3; 0 lets ribs run
    /// to the rims.
    #[serde(default)]
    pub hole_rim_margin_mm: Option<f64>,
    /// One weight per load case. Empty weighs every case at 1.
    #[serde(default)]
    pub case_weights: Vec<f64>,
    /// Resin only. Filament and moulded omit it, and the plan is unchanged.
    #[serde(default)]
    pub vent: bool,
    /// Away from the plate, toward the tank. Omitted: +Z.
    #[serde(default, rename = "buildAxis")]
    pub build_axis: Option<[f64; 3]>,
    /// The wall's outer border is a side wall. Omitted: the edge is open.
    /// Ignored when `borders` is not empty.
    #[serde(default, rename = "risingBorder")]
    pub rising_border: bool,
    /// Wall borders in the wall frame. Each is `{ points, kind }` with kind
    /// `rises`, `open` or `hole`. Empty uses `risingBorder`.
    #[serde(default)]
    pub borders: Vec<WireBorder>,
}

/// One border of the wall the vents are drawn on.
#[derive(Clone, Debug, Deserialize)]
pub struct WireBorder {
    pub points: Vec<[f64; 3]>,
    pub kind: WireBorderKind,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WireBorderKind {
    Rises,
    Open,
    Hole,
}

/// The default material: a PETG-like placeholder. Only ratios matter for
/// placing ribs; a deflection goal reads it, and says it is relative.
pub const DEFAULT_E_MPA: f64 = 2000.0;
pub const DEFAULT_NU: f64 = 0.38;
pub const DEFAULT_HOLE_RIM_MM: f64 = 3.0;

/// The planner's profile for the wire's, with `ribNet`'s defaults filled
/// in. `wall` is the wall's thinnest thickness.
pub fn profile_of(given: Option<WireProfile>, width: f64, max_height: f64, wall: f64) -> RibProfile {
    match given.unwrap_or(WireProfile::Auto {
        process: None,
        flange: None,
    }) {
        WireProfile::Auto { process, flange } => choose_profile(&ProfileRules {
            process: match process.unwrap_or(WireProcess::Filament) {
                WireProcess::Filament => Process::Filament,
                WireProcess::Resin => Process::Resin,
                WireProcess::Moulded => Process::Moulded,
            },
            flange: flange.map(FlangeShape::from),
            width,
            max_height,
            wall,
            force: None,
        }),
        WireProfile::Straight => RibProfile::Rectangular,
        WireProfile::Drafted {
            draft_deg,
            root_radius,
        } => match RibProfile::default_drafted(width, max_height) {
            RibProfile::Drafted {
                draft_deg: d,
                root_radius: r,
            } => RibProfile::Drafted {
                draft_deg: draft_deg.unwrap_or(d),
                root_radius: root_radius.unwrap_or(r),
            },
            other => other,
        },
        WireProfile::Tee {
            flange,
            flange_width,
            flange_thickness,
            flange_chamfer_deg,
            root_radius,
        } => match RibProfile::default_tee(
            width,
            flange.map_or(FlangeShape::Chamfered, FlangeShape::from),
        ) {
            RibProfile::Tee {
                flange_width: fw,
                flange_thickness: ft,
                flange_chamfer_deg: fc,
                root_radius: rr,
            } => RibProfile::Tee {
                flange_width: flange_width.unwrap_or(fw),
                flange_thickness: flange_thickness.unwrap_or(ft),
                flange_chamfer_deg: flange_chamfer_deg.unwrap_or(fc),
                root_radius: root_radius.unwrap_or(rr),
            },
            other => other,
        },
    }
}

fn flange_name(f: FlangeShape) -> &'static str {
    match f {
        FlangeShape::Chamfered => "chamfered",
        FlangeShape::Square => "square",
    }
}

/// The profile as JSON, for the reply.
pub fn profile_json(p: RibProfile) -> Value {
    match p {
        RibProfile::Rectangular => json!({ "kind": "straight" }),
        RibProfile::Drafted {
            draft_deg,
            root_radius,
        } => json!({ "kind": "drafted", "draftDeg": r6(draft_deg), "rootRadius": r6(root_radius) }),
        RibProfile::Tee {
            flange_width,
            flange_thickness,
            flange_chamfer_deg,
            root_radius,
        } => json!({
            "kind": "tee",
            "flangeWidth": r6(flange_width),
            "flangeThickness": r6(flange_thickness),
            "flangeChamferDeg": r6(flange_chamfer_deg),
            "rootRadius": r6(root_radius),
        }),
        RibProfile::TeeWhereLimited {
            flange,
            straight_height,
        } => json!({
            "kind": "teeWhereLimited",
            "flange": flange_name(flange),
            "straightHeight": if straight_height.is_finite() { json!(r6(straight_height)) } else { Value::Null },
        }),
    }
}

/// A stretch's section as `ribNet` takes it: its profile name and fields.
pub fn section_json(s: &RibSection) -> Value {
    match *s {
        RibSection::Rectangular { width, root_radius } => {
            json!({ "profile": "straight", "width": r6(width), "rootRadius": r6(root_radius) })
        }
        RibSection::Drafted {
            width,
            draft_deg,
            root_radius,
        } => json!({ "profile": "drafted", "width": r6(width), "draftDeg": r6(draft_deg), "rootRadius": r6(root_radius) }),
        RibSection::Tee {
            web_width,
            flange_width,
            flange_thickness,
            flange_chamfer_deg,
            root_radius,
        } => json!({
            "profile": "tee",
            "width": r6(web_width),
            "flangeWidth": r6(flange_width),
            "flangeThickness": r6(flange_thickness),
            "flangeChamferDeg": r6(flange_chamfer_deg),
            "rootRadius": r6(root_radius),
        }),
    }
}

fn finite_all(values: &[f64]) -> bool {
    values.iter().all(|v| v.is_finite())
}

/// The planner's request from the wire, or a sentence.
pub fn request_of(body: &RibPlanBody) -> Result<RibPlanRequest, String> {
    let wall = &body.request;
    let n = wall.mesh.vertices.len();
    if n < 3 || wall.mesh.triangles.is_empty() {
        return Err("The wall has no triangles to plan on.".into());
    }
    if wall.mesh.thickness.len() != n {
        return Err("The wall needs one thickness per vertex.".into());
    }
    if wall.mesh.vertices.iter().any(|v| !finite_all(v)) || !finite_all(&wall.mesh.thickness) {
        return Err("The wall has a vertex or a thickness that is not a number.".into());
    }
    if wall.mesh.thickness.iter().any(|&t| t <= 0.0) {
        return Err("The wall's thickness must be above zero everywhere.".into());
    }
    if wall.mesh.triangles.iter().flatten().any(|&v| v as usize >= n) {
        return Err("A wall triangle names a vertex the wall does not have.".into());
    }
    let mesh = ShellMesh {
        vertices: wall.mesh.vertices.clone(),
        triangles: wall.mesh.triangles.clone(),
        thickness: wall.mesh.thickness.clone(),
    };
    let wire = body.material.clone().unwrap_or(WireMaterial {
        e: DEFAULT_E_MPA,
        nu: DEFAULT_NU,
        density_g_cm3: None,
        name: None,
    });
    let mut material = IsotropicShell::new(wire.e, wire.nu).map_err(|e| e.message)?;
    let tri_count = wall.mesh.triangles.len();
    let holds = match &wall.holds {
        WireHolds::Given { holds } => {
            if holds.iter().any(|h| h.node as usize >= n) {
                return Err("A hold names a vertex the wall does not have.".into());
            }
            if holds.is_empty() {
                return Err("Nothing holds the wall: give holds, or leave them to the wall's joined borders.".into());
            }
            Holds::Given(
                holds
                    .iter()
                    .map(|h| ShellHold {
                        node: h.node,
                        dofs: h.dofs,
                    })
                    .collect(),
            )
        }
        WireHolds::AllBoundary => Holds::AllBoundaryClamped,
        WireHolds::OuterBoundary => Holds::OuterBoundaryClamped,
    };
    let mut load_cases = Vec::new();
    for case in &wall.load_cases {
        let mut loads = Vec::new();
        for load in case {
            let tri_ok = |t: &[u32]| t.iter().all(|&t| (t as usize) < tri_count);
            loads.push(match load {
                WireLoad::Force { node, force } if (*node as usize) < n && finite_all(force) => {
                    ShellLoad::Force { node: *node, force: *force }
                }
                WireLoad::Moment { node, moment } if (*node as usize) < n && finite_all(moment) => {
                    ShellLoad::Moment { node: *node, moment: *moment }
                }
                WireLoad::Pressure { triangles, pressure } if tri_ok(triangles) && pressure.is_finite() => {
                    ShellLoad::Pressure { triangles: triangles.clone(), pressure: *pressure }
                }
                WireLoad::SpreadForce { triangles, force } if tri_ok(triangles) && finite_all(force) => {
                    ShellLoad::SpreadForce { triangles: triangles.clone(), force: *force }
                }
                _ => return Err("A load names a vertex or triangle the wall does not have, or a value that is not a number.".into()),
            });
        }
        if !loads.is_empty() {
            load_cases.push(loads);
        }
    }
    let zones = wall
        .zones
        .iter()
        .map(|z| Zone {
            triangles: z.triangles.clone(),
            mode: match z.mode {
                WireZoneMode::NoRibs => ZoneMode::NoRibs,
                WireZoneMode::MaxHeight { mm } => ZoneMode::MaxHeight(mm),
            },
            margin: z.margin,
        })
        .collect();
    let clearance = if wall.clearance.is_empty() {
        None
    } else {
        if wall.clearance.len() != n {
            return Err("The clearance needs one value per wall vertex.".into());
        }
        // null is no cap; a negative or NaN room is none at all.
        Some(
            wall.clearance
                .iter()
                .map(|c| match c {
                    None => f64::INFINITY,
                    Some(v) if v.is_nan() => 0.0,
                    Some(v) => v.max(0.0),
                })
                .collect(),
        )
    };
    let side = match wall.side.as_str() {
        "positive" => RibSide::Positive,
        "negative" => RibSide::Negative,
        other => return Err(format!("side is \"positive\" or \"negative\", not {other:?}.")),
    };
    let r = &body.rules;
    let thinnest = wall.mesh.thickness.iter().copied().fold(f64::INFINITY, f64::min);
    let rules = RibRules {
        width: r.width,
        max_height: r.max_height,
        min_height: r.min_height.unwrap_or_else(|| RibRules::default().min_height.min(r.max_height)),
        clearance,
        min_spacing: r.min_spacing,
        min_length: r.min_length,
        side,
        profile: profile_of(r.profile, r.width, r.max_height, thinnest),
        extend_limit: r.extend_limit,
    };
    let goal = match body.goal.unwrap_or(WireGoal::Balanced) {
        WireGoal::Stiffer { factor } => Goal::Stiffer(factor),
        WireGoal::MaxDeflection { mm } => Goal::MaxDeflection(mm),
        WireGoal::Budget { volume_mm3 } => Goal::Budget { volume_mm3 },
        WireGoal::Balanced => Goal::Balanced,
        WireGoal::Frequency { factor } => {
            if !(factor.is_finite() && factor >= 1.0) {
                return Err("A frequency goal must be 1 or more.".into());
            }
            match wire.density_g_cm3 {
                Some(grams) if grams.is_finite() && grams > 0.0 => {
                    material = material
                        .with_density(grams * DENSITY_G_CM3_TO_N_S2_MM4)
                        .map_err(|e| e.message)?;
                }
                _ => {
                    let name = wire
                        .name
                        .as_deref()
                        .filter(|s| !s.is_empty())
                        .unwrap_or("The material");
                    return Err(format!("{name} has no density."));
                }
            }
            Goal::Frequency { factor }
        }
        WireGoal::Buckling { factor, on } => {
            if !(factor.is_finite() && factor >= 1.0) {
                return Err("A buckling goal must be 1 or more.".into());
            }
            Goal::Buckling { factor, on }
        }
    };
    let given = body.options.unwrap_or_default();
    let defaults = PlannerOptions::default();
    let options = PlannerOptions {
        shortlist: given.shortlist.unwrap_or(defaults.shortlist),
        workers: given.workers.unwrap_or(defaults.workers),
        baselines: given.baselines.unwrap_or(defaults.baselines),
        creases: given.creases.unwrap_or(defaults.creases),
        ..defaults
    };
    let rim = body.hole_rim_margin_mm.unwrap_or(DEFAULT_HOLE_RIM_MM);
    if !(rim.is_finite() && rim >= 0.0) {
        return Err("holeRimMarginMm must not be below zero.".into());
    }
    Ok(RibPlanRequest {
        mesh,
        material,
        holds,
        load_cases,
        case_weights: body.case_weights.clone(),
        // Worst-case mode stays in the crate: on a lopsided panel it does not
        // beat the weighted plan, so the tool does not ask for it.
        combine: LoadCombine::Weighted,
        zones,
        hole_rim_margin: (rim > 0.0).then_some(rim),
        rules,
        goal,
        options,
        vent: body.vent,
        build_axis: {
            let axis = body.build_axis.unwrap_or([0.0, 0.0, 1.0]);
            let n = axis.iter().map(|v| v * v).sum::<f64>().sqrt();
            if !axis.iter().all(|v| v.is_finite()) || n < 1e-9 {
                return Err("buildAxis is three finite numbers, not all zero.".into());
            }
            axis
        },
        rising_border: body.rising_border,
        borders: body
            .borders
            .iter()
            .map(|border| {
                let kind = match border.kind {
                    WireBorderKind::Rises => lime_sim::shell::planner::BorderKind::Rises,
                    WireBorderKind::Open => lime_sim::shell::planner::BorderKind::Open,
                    WireBorderKind::Hole => lime_sim::shell::planner::BorderKind::Hole,
                };
                (border.points.clone(), kind)
            })
            .collect(),
    })
}

fn stage_name(s: PlanStage) -> &'static str {
    match s {
        PlanStage::BareSolve => "bare solve",
        PlanStage::Field => "bending directions",
        PlanStage::Trace => "candidate lines",
        PlanStage::Embed => "cutting lines into the wall",
        PlanStage::Select => "choosing ribs",
        PlanStage::Connect => "joining ends",
        PlanStage::Prune => "pruning",
        PlanStage::Size => "sizing heights",
        PlanStage::Baselines => "comparisons",
        PlanStage::Done => "done",
    }
}

fn end_name(e: RibEndKind) -> &'static str {
    match e {
        RibEndKind::Boundary => "boundary",
        RibEndKind::Hold => "hold",
        RibEndKind::Rib => "rib",
        RibEndKind::Free => "free",
        RibEndKind::Gap => "gap",
    }
}

fn r6(v: f64) -> f64 {
    if !v.is_finite() {
        return v;
    }
    let out = (v * 1e6).round() / 1e6;
    if out == 0.0 {
        0.0
    } else {
        out
    }
}

fn p6(p: &[f64; 3]) -> [f64; 3] {
    [r6(p[0]), r6(p[1]), r6(p[2])]
}

/// One progress event as JSON. A stage event is `{kind:"stage", stage,
/// fraction}`; a rib event carries the rib's polyline (mid-surface) and
/// heights per stretch, and the design's totals after the change.
pub fn event_json(event: &PlanEvent) -> Value {
    match event {
        PlanEvent::Stage { stage, fraction } => json!({
            "kind": "stage",
            "stage": stage_name(*stage),
            "fraction": r6(*fraction),
        }),
        PlanEvent::Rib(rib) => {
            let mut out = json!({
                "kind": "rib",
                "change": match rib.change {
                    RibChange::Added => "added",
                    RibChange::Changed => "changed",
                    RibChange::Removed => "removed",
                },
                "id": rib.id,
                "points": rib.points.iter().map(p6).collect::<Vec<_>>(),
                "heights": rib.heights.iter().map(|h| r6(*h)).collect::<Vec<_>>(),
                "ribs": rib.ribs,
                "ribVolumeMm3": r6(rib.rib_volume_mm3),
                "compliance": r6(rib.compliance),
                "stiffnessFactor": r6(rib.stiffness_factor),
                "fraction": r6(rib.fraction),
            });
            if let Some(factor) = rib.frequency_factor {
                let extra = json!({ "frequencyFactor": r6(factor) });
                out["frequencyFactor"] = extra["frequencyFactor"].clone();
            }
            if let Some(factor) = rib.buckling_factor {
                let extra = json!({ "bucklingFactor": r6(factor) });
                out["bucklingFactor"] = extra["bucklingFactor"].clone();
            }
            out
        }
    }
}

/// The plan as JSON: every rib with its polyline on the mid-surface, its
/// width, heights per stretch, profile and ends; the totals; the two
/// comparisons; and timings.
pub fn plan_json(plan: &RibPlan) -> Value {
    let ribs: Vec<Value> = plan
        .ribs
        .iter()
        .map(|r| {
            json!({
                "points": r.points.iter().map(p6).collect::<Vec<_>>(),
                "width": r6(r.width),
                "height": r6(r.height),
                "heights": r.heights.iter().map(|h| r6(*h)).collect::<Vec<_>>(),
                "profile": profile_json(r.profile),
                "sections": r.sections.iter().map(section_json).collect::<Vec<_>>(),
                "ends": [end_name(r.ends[0]), end_name(r.ends[1])],
                "family": match r.family { Family::Major => "major", Family::Minor => "minor" },
                "lengthMm": r6(r.length_mm),
                "volumeMm3": r6(r.volume_mm3),
                "gain": r6(r.gain),
                "energyShare": r6(r.energy_share),
            })
        })
        .collect();
    let s = &plan.stats.seconds;
    let mut out = json!({
        "ok": true,
        "ribs": ribs,
        "ribVolumeMm3": r6(plan.rib_volume_mm3),
        "bare": { "compliance": r6(plan.bare.compliance), "maxDeflectionMm": r6(plan.bare.max_deflection) },
        "ribbed": { "compliance": r6(plan.ribbed.compliance), "maxDeflectionMm": r6(plan.ribbed.max_deflection) },
        "stiffnessFactor": r6(plan.stiffness_factor),
        "caseFactors": plan.case_factors.iter().map(|f| r6(*f)).collect::<Vec<_>>(),
        "caseDeflectionMm": plan.case_deflection_mm.iter().map(|d| json!({ "bare": r6(d[0]), "ribbed": r6(d[1]) })).collect::<Vec<_>>(),
        "goalMet": plan.goal_met,
        "thickening": plan.thickening.map(|t| json!({
            "addedThicknessMm": r6(t.added_thickness_mm),
            "addedVolumeMm3": r6(t.added_volume_mm3),
            "compliance": r6(t.compliance),
            "solves": t.solves,
        })),
        "grid": plan.grid.map(|g| json!({
            "reached": g.reached,
            "pitchMm": r6(g.pitch_mm),
            "lines": g.lines,
            "gridVolumeMm3": r6(g.grid_volume_mm3),
            "compliance": r6(g.compliance),
            "volumeMm3": g.volume_mm3.map(r6),
            "solves": g.solves,
        })),
        "notBetterThanBaseline": plan.not_better_than_baseline,
        "stoppedEarly": plan.stopped_early,
        "looseEnds": plan.loose_ends.iter().map(|l| json!({
            "rib": l.rib,
            "end": l.end,
            "point": p6(&l.point),
            "reason": match l.reason {
                LooseEndReason::NoRibZone => "noRibZone",
                LooseEndReason::Budget => "budget",
                LooseEndReason::Open => "open",
            },
        })).collect::<Vec<_>>(),
        "stats": {
            "candidates": plan.stats.candidates,
            "embeddedCandidates": plan.stats.embedded_candidates,
            "inputTriangles": plan.stats.input_triangles,
            "embeddedTriangles": plan.stats.embedded_triangles,
            "solves": plan.stats.solves,
            "baselineSolves": plan.stats.baseline_solves,
            "selectionFactor": r6(plan.stats.selection_factor),
            "cleanRetries": plan.stats.clean_retries,
            "looseEnds": {
                "before": plan.stats.loose_ends.before,
                "extended": plan.stats.loose_ends.extended,
                "trimmed": plan.stats.loose_ends.trimmed,
                "dropped": plan.stats.loose_ends.dropped,
                "after": plan.stats.loose_ends.after,
            },
        },
        "seconds": {
            "bare": r6(s.bare), "field": r6(s.field), "trace": r6(s.trace), "embed": r6(s.embed),
            "select": r6(s.select), "connect": r6(s.connect), "prune": r6(s.prune), "size": r6(s.size),
            "baselines": r6(s.baselines), "solver": r6(s.solver), "total": r6(s.total),
        },
    });
    // Resin only. Filament and moulded leave the key off, so their replies stay as they were.
    if let Some(vents) = &plan.vents {
        out["vents"] = json!({
            "sizeMm": r6(vents.size_mm),
            "factorBefore": r6(vents.factor_before),
            "factorAfter": r6(vents.factor_after),
            "notch": "gap",
            "pockets": vents.pockets.iter().map(|p| json!({
                "rib": p.rib,
                "at": p6(&p.at),
                "sizeMm": r6(p.size_mm),
            })).collect::<Vec<_>>(),
            "unvented": vents.unvented.iter().map(|item| json!({
                "at": p6(&item.at),
                "message": item.message,
            })).collect::<Vec<_>>(),
            "note": vents.note,
        });
    }
    // A frequency plan names Hz before and after and the ratio. A stiffness
    // plan leaves those off. Notes are the draft-lost sentence, the
    // frequency sentences, a skipped vent, or several; an empty list stays
    // off the JSON so an unchanged stiffness plan stays unchanged.
    if let Some(hz) = plan.frequency_hz {
        let extra = json!({ "frequencyHz": { "bare": r6(hz.bare), "ribbed": r6(hz.ribbed) } });
        out["frequencyHz"] = extra["frequencyHz"].clone();
    }
    if let Some(factor) = plan.frequency_factor {
        let extra = json!({ "frequencyFactor": r6(factor) });
        out["frequencyFactor"] = extra["frequencyFactor"].clone();
    }
    // Bare and ribbed load factor. A stiffness plan leaves it off, so the
    // stiffness snapshot stays byte-identical. The case name is not here.
    if let Some(factor) = plan.buckling_factor {
        let extra = json!({ "bucklingFactor": { "bare": r6(factor.bare), "ribbed": r6(factor.ribbed) } });
        out["bucklingFactor"] = extra["bucklingFactor"].clone();
    }
    if !plan.notes.is_empty() {
        out["notes"] = json!(plan.notes);
    }
    // Only a worst-case plan has one, and the tool asks for weighted plans.
    if plan.notes.iter().any(|note| note.starts_with("Venting was skipped")) {
        out["notes"] = json!(plan.notes);
    }
    if !plan.worst_trace.is_empty() {
        out["worstTrace"] = json!(plan
            .worst_trace
            .iter()
            .map(|round| json!({ "case": round.limiting_case, "minFactor": r6(round.min_factor) }))
            .collect::<Vec<_>>());
    }
    out
}

/// Read the body and plan, on this thread, with `control`. The reply is
/// the plan's JSON, or `{ok:false, reason}`.
pub fn plan_value(body: &str, control: PlanControl) -> Value {
    let parsed: RibPlanBody = match serde_json::from_str(body) {
        Ok(parsed) => parsed,
        Err(err) => return json!({ "ok": false, "reason": format!("The rib plan request could not be read. {err}") }),
    };
    let req = match request_of(&parsed) {
        Ok(req) => req,
        Err(reason) => return json!({ "ok": false, "reason": reason }),
    };
    match plan_ribs_with(&req, control) {
        Ok(plan) => {
            let mut out = plan_json(&plan);
            out["profile"] = profile_json(req.rules.profile);
            out
        }
        Err(err) => json!({ "ok": false, "reason": err.message }),
    }
}

/// [`plan_value`] with no progress and no cancel, as a string.
pub fn plan_ribs_json(body: &str) -> String {
    plan_value(body, PlanControl::default()).to_string()
}

#[derive(Default)]
struct JobState {
    status: &'static str,
    stage: String,
    fraction: f64,
    events: VecDeque<Value>,
    /// Events dropped from the front because nobody read them.
    dropped: usize,
    /// The design's running totals from the last rib event.
    totals: Option<Value>,
    result: Option<Value>,
}

/// One plan running on its own thread.
pub struct RibJob {
    cancel: Arc<AtomicBool>,
    state: Arc<Mutex<JobState>>,
    started: Instant,
}

impl RibJob {
    /// Start planning `body` on a worker thread. The body is read at once,
    /// so a request that cannot be read is refused here, not later.
    pub fn start(body: String) -> Result<RibJob, String> {
        let parsed: RibPlanBody = serde_json::from_str(&body)
            .map_err(|err| format!("The rib plan request could not be read. {err}"))?;
        let req = request_of(&parsed)?;
        let cancel = Arc::new(AtomicBool::new(false));
        let state = Arc::new(Mutex::new(JobState {
            status: "running",
            stage: "starting".into(),
            ..JobState::default()
        }));
        let (flag, shared) = (Arc::clone(&cancel), Arc::clone(&state));
        std::thread::Builder::new()
            .name("lime-rib-plan".into())
            .spawn(move || {
                let sink = |event: &PlanEvent| {
                    let mut st = shared.lock().unwrap_or_else(|e| e.into_inner());
                    match event {
                        PlanEvent::Stage { stage, fraction } => {
                            let name = stage_name(*stage);
                            let changed = st.stage != name;
                            st.stage = name.into();
                            st.fraction = *fraction;
                            if !changed {
                                return;
                            }
                        }
                        PlanEvent::Rib(rib) => {
                            st.fraction = rib.fraction;
                            let mut totals = json!({
                                "ribs": rib.ribs,
                                "ribVolumeMm3": r6(rib.rib_volume_mm3),
                                "compliance": r6(rib.compliance),
                                "stiffnessFactor": r6(rib.stiffness_factor),
                            });
                            if let Some(factor) = rib.frequency_factor {
                                let extra = json!({ "frequencyFactor": r6(factor) });
                                totals["frequencyFactor"] = extra["frequencyFactor"].clone();
                            }
                            if let Some(factor) = rib.buckling_factor {
                                let extra = json!({ "bucklingFactor": r6(factor) });
                                totals["bucklingFactor"] = extra["bucklingFactor"].clone();
                            }
                            st.totals = Some(totals);
                        }
                    }
                    if st.events.len() >= EVENT_CAP {
                        st.events.pop_front();
                        st.dropped += 1;
                    }
                    st.events.push_back(event_json(event));
                };
                let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    match plan_ribs_with(
                        &req,
                        PlanControl {
                            progress: Some(&sink),
                            cancel: Some(&flag),
                        },
                    ) {
                        Ok(plan) => {
                            let mut out = plan_json(&plan);
                            out["profile"] = profile_json(req.rules.profile);
                            out
                        }
                        Err(err) => json!({ "ok": false, "reason": err.message }),
                    }
                }));
                let mut st = shared.lock().unwrap_or_else(|e| e.into_inner());
                let value = outcome.unwrap_or_else(|_| {
                    json!({ "ok": false, "reason": "The rib planner stopped unexpectedly." })
                });
                st.status = if value["ok"] == true { "done" } else { "error" };
                st.fraction = 1.0;
                st.stage = "done".into();
                st.result = Some(value);
            })
            .map_err(|e| format!("The rib planner could not start. {e}"))?;
        Ok(RibJob {
            cancel,
            state,
            started: Instant::now(),
        })
    }

    /// The state, and every event since the last poll (drained). Once done,
    /// `result` is the plan (or `{ok:false, reason}`).
    pub fn poll(&self) -> Value {
        let mut st = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let events: Vec<Value> = st.events.drain(..).collect();
        let dropped = std::mem::take(&mut st.dropped);
        json!({
            "status": st.status,
            "stage": st.stage,
            "fraction": r6(st.fraction),
            "events": events,
            "dropped": dropped,
            "totals": st.totals,
            "cancelled": self.cancel.load(Ordering::Relaxed),
            "seconds": r6(self.started.elapsed().as_secs_f64()),
            "result": st.result,
        })
    }

    /// Ask the planner to stop: it returns the plan as it stands, within
    /// about one batch of solves, marked `stoppedEarly`.
    pub fn cancel(&self) {
        self.cancel.store(true, Ordering::Relaxed);
    }

    pub fn running(&self) -> bool {
        self.state.lock().map(|st| st.status == "running").unwrap_or(false)
    }
}

/// The most rib plans kept at once. Finished ones are dropped first; a
/// running one is kept until it ends.
pub const JOB_KEEP: usize = 8;

struct Kept {
    id: usize,
    job: RibJob,
}

fn kept() -> &'static Mutex<Vec<Kept>> {
    static JOBS: std::sync::OnceLock<Mutex<Vec<Kept>>> = std::sync::OnceLock::new();
    JOBS.get_or_init(|| Mutex::new(Vec::new()))
}

fn next_id() -> usize {
    static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(1);
    NEXT.fetch_add(1, Ordering::Relaxed)
}

/// Start a plan: `ribWall`'s request plus rules, goal and options in
/// ([`RibPlanBody`]); `{ "id" }` or `{ "error" }` out. The MCP engine's
/// `ribPlanStart` and the desktop's `rib_plan_start` command both call this,
/// so both see the same jobs, wire and replies.
pub fn rib_plan_start(body: String) -> String {
    let job = match RibJob::start(body) {
        Ok(job) => job,
        Err(err) => return json!({ "error": err }).to_string(),
    };
    let id = next_id();
    let mut guard = kept().lock().unwrap_or_else(|e| e.into_inner());
    while guard.len() >= JOB_KEEP {
        match guard.iter().position(|row| !row.job.running()) {
            Some(at) => {
                guard.remove(at);
            }
            None => break,
        }
    }
    guard.push(Kept { id, job });
    json!({ "id": id }).to_string()
}

/// A job's state and the progress events since the last poll
/// ([`RibJob::poll`]), or `{ "error" }` for an id this process never had.
pub fn rib_plan_poll(id: usize) -> String {
    let guard = kept().lock().unwrap_or_else(|e| e.into_inner());
    match guard.iter().find(|row| row.id == id) {
        Some(row) => row.job.poll().to_string(),
        None => json!({ "error": "That rib plan is not in this session." }).to_string(),
    }
}

/// Stop a plan; it returns the plan as it stands, marked `stoppedEarly`.
pub fn rib_plan_cancel(id: usize) -> String {
    let guard = kept().lock().unwrap_or_else(|e| e.into_inner());
    match guard.iter().find(|row| row.id == id) {
        Some(row) => {
            row.job.cancel();
            json!({ "ok": true }).to_string()
        }
        None => json!({ "ok": false, "error": "That rib plan is not in this session." }).to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use lime_sim::shell::planner::{plan_ribs, Goal, RibPlanRequest};
    use lime_sim::shell::ShellLoad;

    /// A flat 120 × 60 wall, 2 mm thick, clamped all round, as `ribWall`
    /// writes it (one clearance null: nothing faces it there).
    fn flat_body(extra: Value) -> String {
        let mesh = ShellMesh::rectangle([120.0, 60.0], [24, 12], 2.0);
        let n = mesh.vertices.len();
        let boundary: Vec<Value> = mesh
            .vertices
            .iter()
            .enumerate()
            .filter(|(_, v)| v[0] < 1e-9 || v[0] > 120.0 - 1e-9 || v[1] < 1e-9 || v[1] > 60.0 - 1e-9)
            .map(|(i, _)| json!({ "node": i, "dofs": [0, 0, 0, 0, 0, 0] }))
            .collect();
        let mut clearance = vec![json!(40.0); n];
        clearance[0] = Value::Null;
        let mut body = json!({
            "request": {
                "mesh": { "vertices": mesh.vertices, "triangles": mesh.triangles, "thickness": mesh.thickness },
                "holds": { "kind": "given", "holds": boundary },
                "loadCases": [],
                "zones": [],
                "clearance": clearance,
                "side": "positive",
            },
            "rules": { "width": 1.2, "maxHeight": 6.0, "minSpacing": 15.0, "minLength": 10.0 },
            "goal": { "kind": "balanced" },
            "options": { "workers": 2 },
        });
        for (k, v) in extra.as_object().unwrap() {
            body[k] = v.clone();
        }
        body.to_string()
    }

    #[test]
    fn a_flat_wall_plans_through_the_wire() {
        let out: Value = serde_json::from_str(&plan_ribs_json(&flat_body(json!({})))).unwrap();
        assert_eq!(out["ok"], true, "{out}");
        assert!(!out["ribs"].as_array().unwrap().is_empty());
        assert!(out["stiffnessFactor"].as_f64().unwrap() > 1.0);
        assert_eq!(out["profile"]["kind"], "straight");
        let rib = &out["ribs"][0];
        assert_eq!(rib["heights"].as_array().unwrap().len() + 1, rib["points"].as_array().unwrap().len());
        assert_eq!(rib["sections"].as_array().unwrap().len(), rib["heights"].as_array().unwrap().len());
        assert_eq!(rib["sections"][0]["profile"], "straight");
    }

    #[test]
    fn null_clearance_is_no_cap_and_a_short_one_is_refused_in_a_sentence() {
        let body: RibPlanBody = serde_json::from_str(&flat_body(json!({}))).unwrap();
        let req = request_of(&body).unwrap();
        let c = req.rules.clearance.unwrap();
        assert!(c[0].is_infinite() && c[1] == 40.0);
        let mut bad: Value = serde_json::from_str(&flat_body(json!({}))).unwrap();
        bad["request"]["clearance"] = json!([1.0]);
        let out: Value = serde_json::from_str(&plan_ribs_json(&bad.to_string())).unwrap();
        assert_eq!(out["ok"], false);
        assert!(out["reason"].as_str().unwrap().contains("one value per wall vertex"));
    }

    #[test]
    fn an_unknown_field_is_refused_and_profiles_read() {
        let mut bad: Value = serde_json::from_str(&flat_body(json!({}))).unwrap();
        bad["request"]["extra"] = json!(1);
        assert!(plan_ribs_json(&bad.to_string()).contains("could not be read"));
        let p = |v: Value| profile_of(Some(serde_json::from_value(v).unwrap()), 1.35, 6.0, 2.0);
        assert_eq!(p(json!({ "kind": "straight" })), RibProfile::Rectangular);
        assert!(matches!(p(json!({ "kind": "tee", "flange": "square" })), RibProfile::Tee { flange_chamfer_deg, .. } if flange_chamfer_deg == 0.0));
        assert!(matches!(p(json!({ "kind": "auto", "process": "moulded" })), RibProfile::Drafted { .. }));
        assert!(matches!(p(json!({ "kind": "auto", "flange": "chamfered" })), RibProfile::TeeWhereLimited { .. }));
        assert_eq!(p(json!({ "kind": "auto", "flange": null })), RibProfile::Rectangular);
    }

    /// `options.creases` reaches the planner; absent it is off, so a
    /// request that never names it plans as v6.12 did.
    #[test]
    fn creases_are_off_unless_the_request_asks() {
        let body: RibPlanBody = serde_json::from_str(&flat_body(json!({}))).unwrap();
        assert!(!request_of(&body).unwrap().options.creases);
        let on: RibPlanBody = serde_json::from_str(&flat_body(json!({ "options": { "workers": 2, "creases": true } }))).unwrap();
        assert!(request_of(&on).unwrap().options.creases);
        let off: RibPlanBody = serde_json::from_str(&flat_body(json!({ "options": { "creases": false } }))).unwrap();
        assert!(!request_of(&off).unwrap().options.creases);
        let mut bad: Value = serde_json::from_str(&flat_body(json!({}))).unwrap();
        bad["options"]["crease"] = json!(true);
        assert!(plan_ribs_json(&bad.to_string()).contains("could not be read"));
    }

    #[test]
    fn a_job_reports_progress_and_a_cancel_returns_the_plan_so_far() {
        let job = RibJob::start(flat_body(json!({ "options": { "workers": 1, "shortlist": 0 } }))).unwrap();
        // Wait for the first rib, then stop.
        let mut seen = Vec::new();
        let t = Instant::now();
        loop {
            let p = job.poll();
            seen.extend(p["events"].as_array().unwrap().iter().cloned());
            if seen.iter().any(|e| e["kind"] == "rib") || p["status"] != "running" {
                break;
            }
            assert!(t.elapsed().as_secs() < 120, "no rib within 120 s");
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        job.cancel();
        let done = loop {
            let p = job.poll();
            seen.extend(p["events"].as_array().unwrap().iter().cloned());
            if p["status"] != "running" {
                break p;
            }
            std::thread::sleep(std::time::Duration::from_millis(5));
        };
        assert_eq!(done["status"], "done", "{done}");
        let result = &done["result"];
        assert_eq!(result["ok"], true);
        assert!(seen.iter().any(|e| e["kind"] == "stage" && e["stage"] == "bare solve"));
        let rib = seen.iter().find(|e| e["kind"] == "rib").unwrap();
        assert!(rib["points"].as_array().unwrap().len() >= 2 && rib["ribVolumeMm3"].as_f64().unwrap() > 0.0);
        // A plan that was stopped says so, unless it had already finished.
        if result["stoppedEarly"] == true {
            assert!(!result["ribs"].as_array().unwrap().is_empty() || result["stiffnessFactor"] == 1.0);
        }
    }

    /// 1 g/cm³ is 1e-9 N·s²/mm⁴, the unit [`IsotropicShell::with_density`] stores.
    #[test]
    fn one_gram_per_cm3_is_the_crate_density_unit() {
        // 1 g/cm³ is exactly 1e-9. 1.27 is not a binary float, so 1.27 × 1e-9
        // is the value with_density stores, not the decimal 1.27e-9.
        let one = IsotropicShell::new(2000.0, 0.3)
            .unwrap()
            .with_density(1.0 * DENSITY_G_CM3_TO_N_S2_MM4)
            .unwrap();
        assert_eq!(one.density, Some(1.0e-9));
        let stored = 1.27 * DENSITY_G_CM3_TO_N_S2_MM4;
        let from_card = IsotropicShell::new(2000.0, 0.3).unwrap().with_density(stored).unwrap();
        assert_eq!(from_card.density, Some(stored));
        println!("1 g/cm³ -> {one:?}; 1.27 g/cm³ -> {stored:.16e}");
    }

    fn panel_body(size: [f64; 2], div: [usize; 2], goal: Value, density: Option<f64>, name: Option<&str>, load: Option<(u32, [f64; 3])>) -> String {
        let mesh = ShellMesh::rectangle(size, div, 2.0);
        let load_cases = match load {
            Some((node, force)) => json!([[{ "kind": "force", "node": node, "force": force }]]),
            None => json!([]),
        };
        let mut material = json!({ "e": 2000.0, "nu": 0.3 });
        if let Some(grams) = density {
            material["densityGCm3"] = json!(grams);
        }
        if let Some(name) = name {
            material["name"] = json!(name);
        }
        json!({
            "request": {
                "mesh": { "vertices": mesh.vertices, "triangles": mesh.triangles, "thickness": mesh.thickness },
                "holds": { "kind": "allBoundary" },
                "loadCases": load_cases,
                "side": "positive",
            },
            "material": material,
            "rules": {
                "width": 1.2, "maxHeight": 6.0, "minHeight": 1.0,
                "minSpacing": 15.0, "minLength": 10.0,
                "profile": { "kind": "straight" },
            },
            "goal": goal,
            "options": { "baselines": false },
        })
        .to_string()
    }

    fn reason_of(body: &str) -> String {
        let out: Value = serde_json::from_str(&plan_ribs_json(body)).unwrap();
        assert_eq!(out["ok"], false, "{out}");
        out["reason"].as_str().unwrap().to_string()
    }

    #[test]
    fn a_frequency_goal_is_refused_by_the_material_name_and_by_a_factor_below_one() {
        let missing = panel_body([40.0, 20.0], [4, 2], json!({ "kind": "frequency", "factor": 1.3 }), None, Some("PETG"), None);
        let reason = reason_of(&missing);
        assert_eq!(reason, "PETG has no density.");
        println!("missing density: {reason}");
        let unnamed = panel_body([40.0, 20.0], [4, 2], json!({ "kind": "frequency", "factor": 1.3 }), None, None, None);
        assert_eq!(reason_of(&unnamed), "The material has no density.");
        let low = panel_body([40.0, 20.0], [4, 2], json!({ "kind": "frequency", "factor": 0.5 }), Some(1.0), Some("PETG"), None);
        let reason = reason_of(&low);
        assert_eq!(reason, "A frequency goal must be 1 or more.");
        println!("factor 0.5: {reason}");
    }

    /// The stiffness reply with `seconds` removed. Wall-clock is the only
    /// field a stiffness plan does not repeat. Set `LIME_WRITE_STIFFNESS_REPLY`
    /// to regenerate the file from this function.
    #[test]
    fn a_stiffness_reply_matches_the_base_once_seconds_are_removed() {
        let body = panel_body([40.0, 20.0], [4, 2], json!({ "kind": "stiffer", "factor": 1.5 }), None, None, None);
        let out: Value = serde_json::from_str(&plan_ribs_json(&body)).unwrap();
        assert_eq!(out["ok"], true, "{out}");
        assert!(out.get("frequencyHz").is_none(), "a stiffness reply gained frequencyHz");
        assert!(out.get("frequencyFactor").is_none(), "a stiffness reply gained frequencyFactor");
        assert!(out.get("bucklingFactor").is_none(), "a stiffness reply gained bucklingFactor");
        assert!(out.get("notes").is_none(), "a stiffness reply gained notes");
        let mut stripped = out;
        stripped.as_object_mut().unwrap().remove("seconds");
        let text = serde_json::to_string_pretty(&stripped).unwrap() + "\n";
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/stiffness_reply_base.json");
        if std::env::var_os("LIME_WRITE_STIFFNESS_REPLY").is_some() {
            std::fs::write(path, &text).unwrap();
        }
        let expected = std::fs::read_to_string(path).unwrap_or_default();
        assert_eq!(text, expected, "stiffness reply differs from {path}");
        println!("stiffness snapshot {} bytes, ribs {}", text.len(), stripped["ribs"].as_array().unwrap().len());
    }

    /// Clamped 120 × 70 × 2, the crate test's panel. Hz in the bridge reply
    /// matches `plan_ribs` to 1e-6. The same call times a frequency plan
    /// against a stiffness plan; the times are printed and not asserted.
    #[test]
    fn frequency_reply_matches_the_crate_on_the_120_panel() {
        let mesh = ShellMesh::rectangle([120.0, 70.0], [24, 14], 2.0);
        let node = mesh.nearest_vertex([15.0, 35.0, 0.0]);
        let force = [0.0, 0.0, -10.0];
        let body = panel_body(
            [120.0, 70.0],
            [24, 14],
            json!({ "kind": "frequency", "factor": 1.3 }),
            Some(1.0),
            Some("panel"),
            Some((node, force)),
        );
        let mut req = RibPlanRequest::new(mesh, IsotropicShell::new(2000.0, 0.3).unwrap().with_density(1.0e-9).unwrap());
        req.goal = Goal::Frequency { factor: 1.3 };
        req.load_cases = vec![vec![ShellLoad::Force { node, force }]];
        req.options.baselines = false;
        let t = Instant::now();
        let crate_plan = plan_ribs(&req).unwrap();
        let crate_s = t.elapsed().as_secs_f64();
        let t = Instant::now();
        let text = plan_ribs_json(&body);
        let bridge_s = t.elapsed().as_secs_f64();
        let out: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(out["ok"], true, "{out}");
        let hz = crate_plan.frequency_hz.unwrap();
        let bare = out["frequencyHz"]["bare"].as_f64().unwrap();
        let ribbed = out["frequencyHz"]["ribbed"].as_f64().unwrap();
        let factor = out["frequencyFactor"].as_f64().unwrap();
        println!(
            "bridge frequency: bare {bare} Hz, ribbed {ribbed} Hz, ×{factor} frequency, ×{} stiffness, volume {} mm³, goalMet {}, bridge {:.3} s, crate {:.3} s",
            out["stiffnessFactor"], out["ribVolumeMm3"], out["goalMet"], bridge_s, crate_s
        );
        println!("bridge notes: {}", out["notes"]);
        assert!((bare - hz.bare).abs() < 1e-6, "bare {bare} vs crate {}", hz.bare);
        assert!((ribbed - hz.ribbed).abs() < 1e-6, "ribbed {ribbed} vs crate {}", hz.ribbed);
        assert!((factor - crate_plan.frequency_factor.unwrap()).abs() < 1e-6, "factor {factor} vs crate {}", crate_plan.frequency_factor.unwrap());
        assert!(factor >= 1.3, "reached ×{factor}");
        assert_eq!(out["goalMet"], true);
        assert!(out["notes"].to_string().contains("ignored"));
        assert!(out.get("stiffnessFactor").is_some());

        let stiff = panel_body([120.0, 70.0], [24, 14], json!({ "kind": "stiffer", "factor": 1.3 }), None, None, Some((node, force)));
        let t = Instant::now();
        let stiff_out: Value = serde_json::from_str(&plan_ribs_json(&stiff)).unwrap();
        let stiff_s = t.elapsed().as_secs_f64();
        println!(
            "tool plan time on 120×70×2: frequency {bridge_s:.3} s, stiffness {stiff_s:.3} s (stiffnessFactor {})",
            stiff_out["stiffnessFactor"]
        );
        assert_eq!(stiff_out["ok"], true, "{stiff_out}");
        assert!(stiff_out.get("frequencyHz").is_none());
    }

    #[test]
    fn an_unreached_frequency_ratio_is_named() {
        let body = panel_body([40.0, 20.0], [4, 2], json!({ "kind": "frequency", "factor": 20.0 }), Some(1.0), Some("panel"), None);
        let out: Value = serde_json::from_str(&plan_ribs_json(&body)).unwrap();
        assert_eq!(out["ok"], true, "{out}");
        let factor = out["frequencyFactor"].as_f64().unwrap();
        println!("40×20 asked ×20: reached ×{factor}, goalMet {}, notes {}", out["goalMet"], out["notes"]);
        assert_eq!(out["goalMet"], false, "×20 was reached; raise the ask, do not drop this check");
        let note = out["notes"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|n| n.as_str())
            .find(|n| n.contains("cannot be reached"))
            .unwrap_or("");
        let quoted: f64 = note.split('×').nth(1).unwrap_or("").trim_end_matches('.').parse().unwrap_or(0.0);
        println!("unreached note: {note}");
        assert!(!note.is_empty(), "the reply did not say the ratio cannot be reached: {}", out["notes"]);
        assert!((quoted - factor).abs() < 1e-6, "the note quotes {quoted}, the reply's frequencyFactor is {factor}: {note}");
    }

    /// plan.bucklingFactor before and after, from plan_ribs_json. A factor
    /// below 1 and a pressure with no compression are refused first.
    #[test]
    fn buckling_reply_prints_the_factor_before_and_after() {
        let low = panel_body([40.0, 40.0], [4, 4], json!({ "kind": "buckling", "factor": 0.5 }), None, None, None);
        let low_reason = reason_of(&low);
        assert_eq!(low_reason, "A buckling goal must be 1 or more.");
        println!("factor below 1: {low_reason}");

        let pressure = panel_body([40.0, 40.0], [4, 4], json!({ "kind": "buckling", "factor": 2.0 }), None, None, None);
        let pressure_reason = reason_of(&pressure);
        assert_eq!(
            pressure_reason,
            "This load bends the wall but doesn't press along it, so it can't buckle it. Buckling needs a load along the wall, such as a push on its edge."
        );
        println!("pressure refusal: {pressure_reason}");

        let mesh = ShellMesh::rectangle([80.0, 80.0], [8, 8], 2.0);
        let tris: Vec<u32> = (0..mesh.triangles.len() as u32).collect();
        let body = json!({
            "request": {
                "mesh": { "vertices": mesh.vertices, "triangles": mesh.triangles, "thickness": mesh.thickness },
                "holds": { "kind": "allBoundary" },
                "loadCases": [[{ "kind": "spreadForce", "triangles": tris, "force": [10000.0, 0.0, 0.0] }]],
                "side": "positive",
            },
            "material": { "e": 2000.0, "nu": 0.3 },
            "rules": {
                "width": 2.0, "maxHeight": 6.0, "minHeight": 1.0,
                "minSpacing": 12.0, "minLength": 8.0,
                "profile": { "kind": "straight" },
            },
            "goal": { "kind": "buckling", "factor": 2.0 },
            "options": { "baselines": false, "shortlist": 4 },
        })
        .to_string();
        let out: Value = serde_json::from_str(&plan_ribs_json(&body)).unwrap();
        assert_eq!(out["ok"], true, "{out}");
        let bare = out["bucklingFactor"]["bare"].as_f64().unwrap();
        let ribbed = out["bucklingFactor"]["ribbed"].as_f64().unwrap();
        println!(
            "plan.bucklingFactor bare {bare} ribbed {ribbed} ribs {} goalMet {} notes {}",
            out["ribs"].as_array().unwrap().len(),
            out["goalMet"],
            out["notes"]
        );
        assert!(bare > 0.0 && bare < 2.0, "bare load factor {bare} was not short of the 2× ask");
        assert!(ribbed > bare, "ribbed {ribbed} did not rise above bare {bare}");
        assert!(!out["ribs"].as_array().unwrap().is_empty(), "no rib was planned");
        let notes = out["notes"].as_array().unwrap();
        assert!(notes.iter().any(|n| n.as_str().unwrap_or("").starts_with("This is the ideal buckling load.")));
    }
}
