//! A study of the part as it is sliced: holds, loads and targets given by
//! where they are, not by node, so the same study solves on any grid.
//!
//! Points and directions are in the part frame, the frame the model's faces
//! are in. The slice field's `frame` takes the grid's slice-frame nodes
//! there and back. A `faces` region carries the faces' triangles: this crate
//! has no B-rep, so the caller resolves face numbers.
//!
//! The reply's `margins` are signed and relative (the sliced plan, §7): 0 is
//! on the limit, positive is inside it. Each one that is failing or tightest
//! carries a hot spot, and the safety factor's names what governs it. Three
//! rules keep the staircase surface from deciding a result (§10):
//! - the peaks the margins read are grid-cell averages: the six tets of a
//!   cell, weighted by volume. A Gauss point beside a staircase step sits
//!   at a re-entrant corner whose stress has no finite limit; on a twisted
//!   shaft it read 20% over T r / J and didn't fall with the cell size,
//!   while the cell average read −3.2% and +0.6% at two sizes;
//! - they skip boundary cells less than half full;
//! - trust comes from the governing margin at `h_xy` and at `h_xy / √2`
//!   ([`sliced_trust`]), not from the ZZ estimator. The estimator smooths
//!   across the staircase's corners and across the real stress jump between
//!   cells of different fraction, and reads both as error: on the twisted
//!   shaft it gave 0.34 and 0.25 globally and 0.64 near the peak while the
//!   surface shear was within 3.2% and 0.6%. Its numbers stay on the
//!   solution, unread by the trust word.
//!
//! The Gauss-point minimum over every cell is reported as `rawMinSafetyFactor`.

use serde::{Deserialize, Serialize};

use crate::assemble::{Hold, Load, NodeHold};
use crate::error::SimError;
use crate::fields::Solution;
use crate::material::{BeadMaxStress, Governs, MaxStress, Stress};
use crate::material::{FailureCriterion, MaterialModel};
use crate::mesh::{boundary_faces, BoundaryFace, Mesh};
use crate::slice_field::{SliceField, ROLES};
use crate::sliced::{default_h_xy, SlicedGrid, SlicedMesh, PHI_MIN};
use crate::solve_cases;
use crate::study::{Card, Request, Step};
use crate::trust::TrustLevel;
use crate::units::{cross, dot, norm, sub, NODE_CAP};

/// A boundary cell under this fraction is mostly outside the part. Its
/// stress is the staircase's, so the peaks the margins read skip it.
pub const BOUNDARY_PHI_TRUSTED: f64 = 0.5;

/// The governing margin may move this much between the two cell sizes and
/// still be `converged`.
pub const RESOLUTION_MOVE_MAX: f64 = 0.05;

/// Past this move between the two cell sizes the result is `rough`.
pub const RESOLUTION_MOVE_ROUGH: f64 = 0.15;

/// The trust word of a sliced result, and the sentence that explains a
/// downgrade. `moved` is the governing margin's relative change between
/// the two cell sizes, `None` when only one ran; `one_size_why` says why.
pub fn sliced_trust(
    provisional: bool,
    moved: Option<f64>,
    one_size_why: &str,
) -> (TrustLevel, Option<String>) {
    let (level, note) = match moved {
        None => (TrustLevel::Usable, Some(one_size_why.to_string())),
        Some(m) if m > RESOLUTION_MOVE_ROUGH => (
            TrustLevel::Rough,
            Some(format!(
                "The sliced result moved {}% between two cell sizes.",
                (m * 100.0).round()
            )),
        ),
        Some(m) if m > RESOLUTION_MOVE_MAX => (
            TrustLevel::Usable,
            Some(format!(
                "The sliced result moved {}% between two cell sizes.",
                (m * 100.0).round()
            )),
        ),
        Some(_) => (TrustLevel::Converged, None),
    };
    if provisional {
        return (TrustLevel::Rough, note);
    }
    (level, note)
}

/// Where a hold, a load or a target applies, in the part frame.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum Region {
    /// Model faces, as triangles. A boundary face of the grid belongs to
    /// them when its centroid is within half a cell and its normal agrees.
    Faces {
        triangles: Vec<[[f64; 3]; 3]>,
    },
    Box {
        min: [f64; 3],
        max: [f64; 3],
    },
    Near {
        point: [f64; 3],
        radius: f64,
    },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum SlicedHold {
    /// The part's lowest face, where it stands on the bed.
    Bed,
    /// Every node of the grid's surface in the region, held fixed.
    Region { region: Region },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum SlicedLoad {
    /// `force` newtons in all, spread over the region's surface by area.
    Force { region: Region, force: [f64; 3] },
    /// `mpa` on the region's surface, pushing into it.
    Pressure { region: Region, mpa: f64 },
    /// `torque` N·mm about the line through `origin` along `axis`, as the
    /// shear that a twisted shaft's end carries: tangential, growing with
    /// the distance from the axis.
    Torque {
        region: Region,
        origin: [f64; 3],
        axis: [f64; 3],
        torque: f64,
    },
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ConstraintKind {
    #[default]
    MinSafetyFactor,
    MaxDeflectionMm,
    /// The peak displacement inside `band`: elastic enough, but not too much.
    DeflectionBandMm,
    /// The case's force over the region's mean displacement along it.
    MinStiffnessNPerMm,
    StiffnessBandNPerMm,
    /// How much the distance between the centroids of `region` and `other`
    /// changes.
    RelativeDeflectionMm,
    MaxMassG,
    MinMassG,
}

impl ConstraintKind {
    fn is_band(self) -> bool {
        matches!(self, Self::DeflectionBandMm | Self::StiffnessBandNPerMm)
    }

    fn is_floor(self) -> bool {
        matches!(
            self,
            Self::MinSafetyFactor | Self::MinStiffnessNPerMm | Self::MinMassG
        )
    }

    fn is_stiffness(self) -> bool {
        matches!(self, Self::MinStiffnessNPerMm | Self::StiffnessBandNPerMm)
    }
}

/// A target. A floor or a ceiling has a `value`; a band has `band`. It reads
/// the whole part unless it names a `region`, under the first load case
/// unless it names its `loadCase`.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Constraint {
    pub kind: ConstraintKind,
    #[serde(default)]
    pub value: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub band: Option<[f64; 2]>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub region: Option<Region>,
    /// The second region of a relative deflection.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub other: Option<Region>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub load_case: Option<String>,
}

/// Loads that act together. Several cases share one factorisation: each is
/// one more back-substitution.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LoadCase {
    pub name: String,
    pub loads: Vec<SlicedLoad>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SlicedStudy {
    /// The cell size. Absent, the largest whose dense grid fits the cap.
    #[serde(default)]
    pub h_xy: Option<f64>,
    pub card: Card,
    pub holds: Vec<SlicedHold>,
    /// One load case, named "default". Give this or `loadCases`.
    #[serde(default)]
    pub loads: Vec<SlicedLoad>,
    #[serde(default)]
    pub load_cases: Vec<LoadCase>,
    #[serde(default)]
    pub constraints: Vec<Constraint>,
    /// Solve at a second, finer cell size to judge the result. Off is a
    /// quick look, and is at most `usable`.
    #[serde(default = "yes")]
    pub check_resolution: bool,
}

fn yes() -> bool {
    true
}

impl SlicedStudy {
    /// The load cases, and every target checked against them.
    fn cases(&self) -> Result<Vec<LoadCase>, SimError> {
        let cases = match (self.loads.is_empty(), self.load_cases.is_empty()) {
            (false, true) => vec![LoadCase {
                name: "default".into(),
                loads: self.loads.clone(),
            }],
            (true, false) => self.load_cases.clone(),
            (true, true) => return Err(SimError::new("This study has no load.")),
            (false, false) => return Err(SimError::new("Give loads or load cases, not both.")),
        };
        if cases.iter().any(|c| c.loads.is_empty()) {
            return Err(SimError::new("A load case has no load."));
        }
        for c in &self.constraints {
            if c.kind.is_band() {
                let ok = c.band.is_some_and(|[lo, hi]| {
                    lo.is_finite() && hi.is_finite() && lo >= 0.0 && hi > lo
                });
                if !ok {
                    return Err(SimError::new("A band needs two numbers, the lower first."));
                }
            } else if !(c.value.is_finite() && c.value > 0.0) {
                return Err(SimError::new("A target has to be a positive number."));
            }
            if c.kind.is_stiffness() && c.region.is_none() {
                return Err(SimError::new(
                    "A stiffness target needs the region it reads.",
                ));
            }
            if c.kind == ConstraintKind::RelativeDeflectionMm
                && (c.region.is_none() || c.other.is_none())
            {
                return Err(SimError::new(
                    "A relative deflection needs two regions, region and other.",
                ));
            }
            let case = match &c.load_case {
                Some(name) => cases
                    .iter()
                    .find(|k| &k.name == name)
                    .ok_or_else(|| SimError::new(format!("There is no load case named {name}.")))?,
                None => &cases[0],
            };
            if c.kind.is_stiffness()
                && !case
                    .loads
                    .iter()
                    .any(|l| matches!(l, SlicedLoad::Force { .. }))
            {
                return Err(SimError::new(format!(
                    "A stiffness target reads a force, and load case {} has none.",
                    case.name
                )));
            }
        }
        Ok(cases)
    }
}

/// Where a margin is tightest.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HotSpot {
    /// In the part frame.
    pub at: [f64; 3],
    /// The slice layer the point is in, and that layer's top in the slice
    /// frame.
    pub layer: Option<u32>,
    pub layer_z_mm: Option<f64>,
    /// The role with the most volume in the cell, as the slice names it.
    pub role: String,
    /// Which allowable decided a safety factor.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub governs: Option<Governs>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Margin {
    pub kind: ConstraintKind,
    /// The floor or ceiling; 0 for a band.
    pub limit: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub band: Option<[f64; 2]>,
    pub load_case: String,
    pub value: f64,
    /// Signed and relative: 0 on the limit, positive inside it. A band's is
    /// the distance to its nearer edge over its half-width: 1 at its centre,
    /// 0 at each edge.
    pub margin: f64,
    /// Inside the limit and trusted enough to say so.
    pub met: bool,
    /// Which side a band missed, as a sentence.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hot_spot: Option<HotSpot>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Resolution {
    pub h_xy_mm: f64,
    pub nodes: usize,
    /// Every load case shares this many factorisations of the stiffness.
    pub factorisations: usize,
    /// The governing constraint's value at this cell size.
    pub governing_value: Option<f64>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SlicedReport {
    pub representation: &'static str,
    pub h_xy_mm: f64,
    pub trust: TrustLevel,
    pub notes: Vec<String>,
    pub margins: Vec<Margin>,
    pub load_cases: Vec<String>,
    /// The lowest safety factor at any Gauss point of any cell, the
    /// staircase's steps and corners included.
    pub raw_min_safety_factor: Option<f64>,
    /// The lowest safety factor the margins read: cell averages, boundary
    /// cells under half full skipped.
    pub min_safety_factor: Option<f64>,
    pub max_displacement_mm: f64,
    pub mass_g: f64,
    pub resolutions: Vec<Resolution>,
    /// The first load case's solve at the first cell size.
    #[serde(skip)]
    pub solution: Option<Solution>,
    /// Every load case's solve at the first cell size, in order.
    #[serde(skip)]
    pub case_solutions: Vec<Solution>,
    #[serde(skip)]
    pub mesh: Option<SlicedMesh>,
    /// The second cell size's solve, when it ran.
    #[serde(skip)]
    pub finer: Option<(Solution, SlicedMesh)>,
    /// Slice frame to the frame the study was given in, row-major.
    #[serde(skip)]
    pub frame: [[f64; 4]; 4],
}

/// The solved part's outer surface, ready to draw: three corners a
/// triangle, in the study's frame. Each corner carries its node's
/// displacement and its cell's averaged von Mises and safety factor, the
/// values the margins read; a staircase cell under half full shows as
/// unloaded rather than as its corner peaks.
#[derive(Clone, Debug, Default)]
pub struct DrawSurface {
    pub positions: Vec<[f32; 3]>,
    pub displacement: Vec<[f32; 3]>,
    pub von_mises: Vec<f32>,
    pub safety: Vec<f32>,
}

/// One solid cell's values, the ones the margins read.
#[derive(Clone, Copy, Debug)]
pub struct CellValue {
    /// `(i, j, slab)` in the grid.
    pub key: (u32, u32, u32),
    pub volume_fraction: f64,
    /// The cell's averaged von Mises: the smeared stress.
    pub von_mises: f64,
    /// That stress in the beads themselves: the smeared stress over the
    /// fraction, which is what a strut of sparse infill carries.
    pub bead_von_mises: f64,
    pub safety: f64,
    /// A boundary cell under half full.
    pub staircase: bool,
}

/// Every solid cell's values for the first load case at the first cell size.
pub fn cell_values(report: &SlicedReport, card: &Card) -> Vec<CellValue> {
    let (Some(solution), Some(mesh)) = (report.solution.as_ref(), report.mesh.as_ref()) else {
        return Vec::new();
    };
    let allow = card.material().allowables();
    let axis = [0.0, 0.0, 1.0];
    cell_stresses(solution, mesh)
        .into_iter()
        .map(|cell| {
            let ctx = mesh.cells[cell.element].context(axis);
            let safety = match &card.beads {
                Some(b) => {
                    BeadMaxStress { beads: b }
                        .safety_governed(&Stress { v: cell.stress }, &ctx)
                        .0
                }
                None => MaxStress.safety(&Stress { v: cell.stress }, &allow, &ctx),
            };
            let phi = mesh.cells[cell.element].volume_fraction;
            let von_mises = crate::material::von_mises(&cell.stress);
            CellValue {
                key: mesh.cell_of[cell.element],
                volume_fraction: phi,
                von_mises,
                bead_von_mises: von_mises / phi.max(0.05),
                safety: if safety.is_finite() {
                    safety.min(1.0e6)
                } else {
                    1.0e6
                },
                staircase: cell.staircase,
            }
        })
        .collect()
}

/// The first load case's surface at the first cell size.
pub fn draw_surface(report: &SlicedReport, card: &Card) -> Option<DrawSurface> {
    let solution = report.solution.as_ref()?;
    let mesh = report.mesh.as_ref()?;
    let to = Affine { m: report.frame };
    // Each cell's six elements share its value. A staircase cell shows as
    // unloaded rather than as its corner peaks.
    let by_cell: std::collections::HashMap<(u32, u32, u32), (f32, f32)> = cell_values(report, card)
        .into_iter()
        .map(|c| {
            let shown = if c.staircase {
                (0.0, 1.0e6)
            } else {
                (c.von_mises as f32, c.safety as f32)
            };
            (c.key, shown)
        })
        .collect();
    let mut out = DrawSurface::default();
    for face in boundary_faces(&mesh.mesh) {
        let (vm, sf) = by_cell
            .get(&mesh.cell_of[face.element])
            .copied()
            .unwrap_or((0.0, 1.0e6));
        for &node in &face.nodes[..3] {
            let p = to.point(mesh.mesh.nodes[node]);
            let u = to.vector(solution.displacement[node]);
            out.positions.push([p[0] as f32, p[1] as f32, p[2] as f32]);
            out.displacement
                .push([u[0] as f32, u[1] as f32, u[2] as f32]);
            out.von_mises.push(vm);
            out.safety.push(sf);
        }
    }
    Some(out)
}

/// An affine map, row-major, the last row `[0, 0, 0, 1]`.
#[derive(Clone, Copy, Debug)]
struct Affine {
    m: [[f64; 4]; 4],
}

impl Affine {
    fn point(&self, p: [f64; 3]) -> [f64; 3] {
        let m = &self.m;
        [
            m[0][0] * p[0] + m[0][1] * p[1] + m[0][2] * p[2] + m[0][3],
            m[1][0] * p[0] + m[1][1] * p[1] + m[1][2] * p[2] + m[1][3],
            m[2][0] * p[0] + m[2][1] * p[1] + m[2][2] * p[2] + m[2][3],
        ]
    }

    fn vector(&self, v: [f64; 3]) -> [f64; 3] {
        let m = &self.m;
        [
            m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
            m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
            m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
        ]
    }

    fn inverse(&self) -> Option<Affine> {
        let a = &self.m;
        let det = a[0][0] * (a[1][1] * a[2][2] - a[1][2] * a[2][1])
            - a[0][1] * (a[1][0] * a[2][2] - a[1][2] * a[2][0])
            + a[0][2] * (a[1][0] * a[2][1] - a[1][1] * a[2][0]);
        if det.abs() < 1e-12 {
            return None;
        }
        let mut inv = [[0.0; 4]; 4];
        for r in 0..3 {
            for c in 0..3 {
                let (r1, r2) = ((c + 1) % 3, (c + 2) % 3);
                let (c1, c2) = ((r + 1) % 3, (r + 2) % 3);
                inv[r][c] = (a[r1][c1] * a[r2][c2] - a[r1][c2] * a[r2][c1]) / det;
            }
        }
        for r in 0..3 {
            inv[r][3] = -(inv[r][0] * a[0][3] + inv[r][1] * a[1][3] + inv[r][2] * a[2][3]);
        }
        inv[3][3] = 1.0;
        Some(Affine { m: inv })
    }
}

/// The geometry a region is tested against, in the part frame.
struct Surface<'a> {
    faces: &'a [BoundaryFace],
    to_part: Affine,
    h: f64,
}

impl Surface<'_> {
    fn centroid(&self, face: &BoundaryFace) -> [f64; 3] {
        self.to_part.point(face.centroid)
    }

    fn normal(&self, face: &BoundaryFace) -> [f64; 3] {
        let n = self.to_part.vector(face.normal);
        let len = norm(n);
        if len > 0.0 {
            [n[0] / len, n[1] / len, n[2] / len]
        } else {
            n
        }
    }

    /// The boundary faces of the grid in `region`.
    fn select(&self, region: &Region) -> Vec<&BoundaryFace> {
        self.faces
            .iter()
            .filter(|face| {
                let c = self.centroid(face);
                match region {
                    Region::Box { min, max } => (0..3).all(|k| c[k] >= min[k] && c[k] <= max[k]),
                    Region::Near { point, radius } => norm(sub(c, *point)) <= *radius,
                    Region::Faces { triangles } => {
                        let n = self.normal(face);
                        triangles.iter().any(|tri| {
                            let tn = triangle_normal(tri);
                            // A staircase face is axis-aligned; a sloped model
                            // face still owns the steps that face its way.
                            dot(n, tn) > 0.3 && point_triangle_distance(c, tri) <= self.h * 0.75
                        })
                    }
                }
            })
            .collect()
    }
}

fn triangle_normal(tri: &[[f64; 3]; 3]) -> [f64; 3] {
    let n = cross(sub(tri[1], tri[0]), sub(tri[2], tri[0]));
    let len = norm(n);
    if len > 0.0 {
        [n[0] / len, n[1] / len, n[2] / len]
    } else {
        [0.0; 3]
    }
}

/// The distance from `p` to the triangle, by projection then the edges.
fn point_triangle_distance(p: [f64; 3], tri: &[[f64; 3]; 3]) -> f64 {
    let n = triangle_normal(tri);
    let d = dot(sub(p, tri[0]), n);
    let q = [p[0] - d * n[0], p[1] - d * n[1], p[2] - d * n[2]];
    let inside = (0..3).all(|i| {
        let a = tri[i];
        let b = tri[(i + 1) % 3];
        dot(cross(sub(b, a), sub(q, a)), n) >= -1e-12
    });
    if inside {
        return d.abs();
    }
    (0..3)
        .map(|i| {
            let a = tri[i];
            let b = tri[(i + 1) % 3];
            let ab = sub(b, a);
            let t = (dot(sub(p, a), ab) / dot(ab, ab).max(1e-30)).clamp(0.0, 1.0);
            norm(sub(
                p,
                [a[0] + t * ab[0], a[1] + t * ab[1], a[2] + t * ab[2]],
            ))
        })
        .fold(f64::INFINITY, f64::min)
}

/// One grid cell's stress: its tets' Gauss stresses averaged by volume.
#[derive(Clone, Copy, Debug)]
pub struct CellStress {
    /// The first of the cell's six elements; they share its material.
    pub element: usize,
    /// The centroid, in the slice frame.
    pub at: [f64; 3],
    pub stress: [f64; 6],
    /// A boundary cell under half full: the staircase, not the part.
    pub staircase: bool,
}

/// Every solid cell's averaged stress.
pub fn cell_stresses(solution: &Solution, mesh: &SlicedMesh) -> Vec<CellStress> {
    let mut index: std::collections::HashMap<(u32, u32, u32), usize> = Default::default();
    let mut sums: Vec<([f64; 6], [f64; 3], f64, usize)> = Vec::new();
    for g in &solution.gauss {
        let key = mesh.cell_of[g.element];
        let slot = *index.entry(key).or_insert_with(|| {
            sums.push(([0.0; 6], [0.0; 3], 0.0, g.element));
            sums.len() - 1
        });
        let entry = &mut sums[slot];
        for k in 0..6 {
            entry.0[k] += g.stress[k] * g.weight_det;
        }
        for k in 0..3 {
            entry.1[k] += g.xyz[k] * g.weight_det;
        }
        entry.2 += g.weight_det;
    }
    sums.into_iter()
        .filter(|s| s.2 > 0.0)
        .map(|(stress, at, w, element)| CellStress {
            element,
            at: [at[0] / w, at[1] / w, at[2] / w],
            stress: stress.map(|v| v / w),
            staircase: mesh.boundary[element]
                && mesh.cells[element].volume_fraction < BOUNDARY_PHI_TRUSTED,
        })
        .collect()
}

/// Run a sliced study on a field.
pub fn run(field: &SliceField, study: &SlicedStudy) -> Result<SlicedReport, SimError> {
    if study.holds.is_empty() {
        return Err(crate::error::not_held());
    }
    let cases = study.cases()?;
    let to_part = Affine {
        m: field.header.frame,
    };
    let to_slice = to_part
        .inverse()
        .ok_or_else(|| SimError::new("The slice field's frame can't be inverted."))?;
    let h = study.h_xy.unwrap_or_else(|| default_h_xy(field));
    let first = solve_at(field, study, &cases, h, to_part, to_slice)?;
    let governing = first.governing(study)?;
    let mut resolutions = vec![first.resolution(governing, study)?];
    let mut notes = first.cases[0].solution.notes.clone();
    let mut finer = None;
    let mut moved = None;
    let fine = h / std::f64::consts::SQRT_2;
    // The node count goes with the cell count, about h⁻³ while slabs follow
    // the layers; √2 finer is about 2.8 times the nodes.
    let estimate = (first.mesh.mesh.nodes.len() as f64 * 2.83) as usize;
    let one_size_why = if !study.check_resolution {
        "The sliced result was solved at one cell size only.".to_string()
    } else if estimate > NODE_CAP {
        format!(
            "This part is too large for a second cell size under the node cap, so the sliced result was not checked at {} mm.",
            format_mm(fine)
        )
    } else {
        let second = solve_at(field, study, &cases, fine, to_part, to_slice)?;
        let resolution = second.resolution(governing, study)?;
        if let (Some(a), Some(b)) = (resolutions[0].governing_value, resolution.governing_value) {
            moved = Some((a - b).abs() / a.abs().max(b.abs()).max(1e-30));
        } else {
            // Nothing governs: no target and no stress.
            moved = Some(0.0);
        }
        resolutions.push(resolution);
        let mut solutions = second.cases.into_iter().map(|c| c.solution);
        finer = solutions.next().map(|s| (s, second.mesh));
        String::new()
    };
    let provisional =
        study.card.provisional || study.card.beads.as_ref().is_some_and(|b| b.provisional);
    let (level, why) = sliced_trust(provisional, moved, &one_size_why);
    notes.extend(why);
    let margins = study
        .constraints
        .iter()
        .map(|c| first.margin(c, level))
        .collect::<Result<Vec<_>, _>>()?;
    let worst_sf = |pick: fn(&CaseResult) -> Option<f64>| {
        first
            .cases
            .iter()
            .filter_map(pick)
            .fold(None, |m: Option<f64>, v| Some(m.map_or(v, |m| m.min(v))))
    };
    let raw_min_safety_factor = worst_sf(|c| c.raw_min_sf.map(|s| s.0));
    let min_safety_factor = worst_sf(|c| c.min_sf.map(|s| s.0));
    let max_displacement_mm = first.cases.iter().map(|c| c.max_disp.0).fold(0.0, f64::max);
    let mass_g = first.cases[0].solution.mass_g;
    let mut case_solutions: Vec<Solution> = first.cases.into_iter().map(|c| c.solution).collect();
    Ok(SlicedReport {
        representation: "sliced",
        h_xy_mm: h,
        trust: level,
        notes,
        margins,
        load_cases: cases.iter().map(|c| c.name.clone()).collect(),
        raw_min_safety_factor,
        min_safety_factor,
        max_displacement_mm,
        mass_g,
        resolutions,
        solution: Some(case_solutions[0].clone()),
        case_solutions: std::mem::take(&mut case_solutions),
        mesh: Some(first.mesh),
        finer,
        frame: field.header.frame,
    })
}

/// One load case solved on one grid.
struct CaseResult {
    solution: Solution,
    /// The case's force loads summed, in the part frame.
    force: Option<[f64; 3]>,
    /// Every trusted cell's safety factor, the element it starts at, its
    /// slice-frame centroid, and what governs it.
    cell_safety: Vec<(f64, usize, [f64; 3], Option<Governs>)>,
    min_sf: Option<(f64, usize, [f64; 3], Option<Governs>)>,
    raw_min_sf: Option<(f64, usize, [f64; 3])>,
    /// Largest displacement and its node.
    max_disp: (f64, usize),
}

struct Solved {
    mesh: SlicedMesh,
    faces: Vec<BoundaryFace>,
    h: f64,
    to_part: Affine,
    layers: Vec<(u32, f64, f64)>,
    names: Vec<String>,
    cases: Vec<CaseResult>,
    factorisations: usize,
}

/// What decides trust: a target, or the lowest safety factor when the study
/// has none.
#[derive(Clone, Copy)]
enum Governing {
    Target(usize),
    SafetyFactor,
    Nothing,
}

fn solve_at(
    field: &SliceField,
    study: &SlicedStudy,
    cases: &[LoadCase],
    h: f64,
    to_part: Affine,
    to_slice: Affine,
) -> Result<Solved, SimError> {
    let grid = SlicedGrid::rasterize(field, h)?;
    let sliced = grid.mesh(PHI_MIN)?;
    let mesh = &sliced.mesh;
    let faces = boundary_faces(mesh);
    let surface = Surface {
        faces: &faces,
        to_part,
        h,
    };
    let mut holds = Vec::new();
    for hold in &study.holds {
        let picked: Vec<&BoundaryFace> = match hold {
            SlicedHold::Bed => {
                let lowest = faces
                    .iter()
                    .map(|f| surface.centroid(f)[2])
                    .fold(f64::INFINITY, f64::min);
                let slab = grid.slabs.first().map_or(h, |s| s[1] - s[0]);
                faces
                    .iter()
                    .filter(|f| {
                        surface.centroid(f)[2] <= lowest + 0.5 * slab && surface.normal(f)[2] < -0.5
                    })
                    .collect()
            }
            SlicedHold::Region { region } => surface.select(region),
        };
        if picked.is_empty() {
            return Err(SimError::new(
                "A hold's region touches no surface of the sliced part.",
            ));
        }
        for face in picked {
            for &node in &face.nodes {
                holds.push(NodeHold {
                    node,
                    hold: Hold::Fixed,
                });
            }
        }
    }
    let mut case_loads = Vec::with_capacity(cases.len());
    for case in cases {
        case_loads.push(loads_of(&case.loads, &surface, to_slice)?);
    }
    let card = &study.card;
    let req = Request {
        mesh: mesh.clone(),
        material: card.material(),
        recipe: crate::recipe::Recipe::solid(),
        // The grid is in the slice frame, where the layers stack along +Z.
        build_axis: [0.0, 0.0, 1.0],
        holds,
        loads: Vec::new(),
        steps: vec![Step {
            factor: 1.0,
            max_iter: 1,
            tol: 1e-10,
        }],
        linear: true,
        gravity: None,
        h_mm: h,
        allow_linear_tets: false,
        analysis: "static".into(),
        temperature_c: None,
        fibre_axis: None,
        solver: "faer-ldlt".into(),
        representation: "sliced".into(),
        cells: sliced.cells.clone(),
        beads: card.beads.clone(),
        post_steps: Vec::new(),
        provisional: card.provisional,
        cancel: None,
        on_progress: None,
    };
    let solved = solve_cases(&req, &case_loads)?;
    let allow = card.material().allowables();
    let axis = [0.0, 0.0, 1.0];
    let safety = |stress: [f64; 6], element: usize| {
        let ctx = sliced.cells[element].context(axis);
        match &card.beads {
            Some(b) => BeadMaxStress { beads: b }.safety_governed(&Stress { v: stress }, &ctx),
            None => (MaxStress.safety(&Stress { v: stress }, &allow, &ctx), None),
        }
    };
    let mut results = Vec::with_capacity(cases.len());
    for (case, solution) in cases.iter().zip(solved.solutions) {
        let mut raw_min_sf: Option<(f64, usize, [f64; 3])> = None;
        for sample in &solution.gauss {
            let (sf, _) = safety(sample.stress, sample.element);
            if sf.is_finite() && raw_min_sf.is_none_or(|(best, _, _)| sf < best) {
                raw_min_sf = Some((sf, sample.element, sample.xyz));
            }
        }
        let cell_safety: Vec<(f64, usize, [f64; 3], Option<Governs>)> =
            cell_stresses(&solution, &sliced)
                .into_iter()
                .filter(|cell| !cell.staircase)
                .filter_map(|cell| {
                    let (sf, governs) = safety(cell.stress, cell.element);
                    sf.is_finite()
                        .then_some((sf, cell.element, cell.at, governs))
                })
                .collect();
        let min_sf = cell_safety
            .iter()
            .copied()
            .min_by(|a, b| a.0.total_cmp(&b.0));
        let max_disp = solution
            .displacement
            .iter()
            .enumerate()
            .map(|(i, u)| (norm(*u), i))
            .fold((0.0, 0), |a, b| if b.0 > a.0 { b } else { a });
        let forces: Vec<[f64; 3]> = case
            .loads
            .iter()
            .filter_map(|l| match l {
                SlicedLoad::Force { force, .. } => Some(*force),
                _ => None,
            })
            .collect();
        let force = (!forces.is_empty()).then(|| {
            forces
                .iter()
                .fold([0.0; 3], |a, f| [a[0] + f[0], a[1] + f[1], a[2] + f[2]])
        });
        results.push(CaseResult {
            solution,
            force,
            cell_safety,
            min_sf,
            raw_min_sf,
            max_disp,
        });
    }
    let mut layers: Vec<(u32, f64, f64)> = field
        .header
        .layers
        .iter()
        .map(|l| (l.index, l.z_mm - l.height_mm, l.z_mm))
        .collect();
    layers.sort_by(|a, b| a.1.total_cmp(&b.1));
    Ok(Solved {
        mesh: sliced,
        faces,
        h,
        to_part,
        layers,
        names: cases.iter().map(|c| c.name.clone()).collect(),
        cases: results,
        factorisations: solved.factorisations,
    })
}

/// A case's loads as tractions on the grid's surface, in the slice frame.
fn loads_of(
    loads: &[SlicedLoad],
    surface: &Surface<'_>,
    to_slice: Affine,
) -> Result<Vec<Load>, SimError> {
    let mut out = Vec::new();
    for load in loads {
        let region = match load {
            SlicedLoad::Force { region, .. }
            | SlicedLoad::Pressure { region, .. }
            | SlicedLoad::Torque { region, .. } => region,
        };
        let picked = surface.select(region);
        if picked.is_empty() {
            return Err(SimError::new(
                "A load's region touches no surface of the sliced part.",
            ));
        }
        match load {
            SlicedLoad::Force { force, .. } => {
                let area: f64 = picked.iter().map(|f| f.area).sum();
                let t = to_slice.vector(*force);
                for face in picked {
                    out.push(Load::Traction {
                        nodes: face.nodes.clone(),
                        traction: [t[0] / area, t[1] / area, t[2] / area],
                    });
                }
            }
            SlicedLoad::Pressure { mpa, .. } => {
                for face in picked {
                    let n = face.normal;
                    out.push(Load::Traction {
                        nodes: face.nodes.clone(),
                        traction: [-mpa * n[0], -mpa * n[1], -mpa * n[2]],
                    });
                }
            }
            SlicedLoad::Torque {
                origin,
                axis,
                torque,
                ..
            } => {
                let a = norm(*axis);
                if a <= 0.0 {
                    return Err(SimError::new("A torque's axis has zero length."));
                }
                let axis_part = [axis[0] / a, axis[1] / a, axis[2] / a];
                // The polar moment of the picked area about the axis.
                let arm = |c: [f64; 3]| {
                    let d = sub(c, *origin);
                    let along = dot(d, axis_part);
                    [
                        d[0] - along * axis_part[0],
                        d[1] - along * axis_part[1],
                        d[2] - along * axis_part[2],
                    ]
                };
                let polar: f64 = picked
                    .iter()
                    .map(|f| {
                        let r = arm(surface.centroid(f));
                        f.area * dot(r, r)
                    })
                    .sum();
                if polar <= 0.0 {
                    return Err(SimError::new("A torque's region sits on its axis."));
                }
                for face in picked {
                    let r = arm(surface.centroid(face));
                    let t_part = cross(axis_part, r);
                    let s = torque / polar;
                    let t = to_slice.vector([t_part[0] * s, t_part[1] * s, t_part[2] * s]);
                    out.push(Load::Traction {
                        nodes: face.nodes.clone(),
                        traction: t,
                    });
                }
            }
        }
    }
    Ok(out)
}

/// A target read on one grid: its value and where it is tightest.
struct Reading {
    value: f64,
    hot_spot: Option<HotSpot>,
}

impl Solved {
    fn case_of(&self, c: &Constraint) -> usize {
        c.load_case
            .as_ref()
            .and_then(|name| self.names.iter().position(|n| n == name))
            .unwrap_or(0)
    }

    fn surface(&self) -> Surface<'_> {
        Surface {
            faces: &self.faces,
            to_part: self.to_part,
            h: self.h,
        }
    }

    fn in_region(&self, part_point: [f64; 3], region: &Region) -> bool {
        match region {
            Region::Box { min, max } => {
                (0..3).all(|k| part_point[k] >= min[k] && part_point[k] <= max[k])
            }
            Region::Near { point, radius } => norm(sub(part_point, *point)) <= *radius,
            Region::Faces { triangles } => triangles
                .iter()
                .any(|tri| point_triangle_distance(part_point, tri) <= self.h * 0.75),
        }
    }

    /// The grid nodes a region reads: inside a box or a ball, or on the
    /// surface it picks for model faces.
    fn region_nodes(&self, region: &Region) -> Result<Vec<usize>, SimError> {
        let nodes: Vec<usize> = match region {
            Region::Faces { .. } => {
                let mut picked: Vec<usize> = self
                    .surface()
                    .select(region)
                    .into_iter()
                    .flat_map(|f| f.nodes.iter().copied())
                    .collect();
                picked.sort_unstable();
                picked.dedup();
                picked
            }
            _ => (0..self.mesh.mesh.nodes.len())
                .filter(|&i| self.in_region(self.to_part.point(self.mesh.mesh.nodes[i]), region))
                .collect(),
        };
        if nodes.is_empty() {
            return Err(SimError::new(
                "A target's region holds no node of the sliced part.",
            ));
        }
        Ok(nodes)
    }

    fn displacement_part(&self, case: usize, node: usize) -> [f64; 3] {
        self.to_part
            .vector(self.cases[case].solution.displacement[node])
    }

    fn node_spot(&self, node: usize) -> HotSpot {
        let at = self.mesh.mesh.nodes[node];
        let element = nearest_element(&self.mesh.mesh, node);
        self.hot_spot(element, at, None)
    }

    fn read(&self, c: &Constraint) -> Result<Option<Reading>, SimError> {
        let k = self.case_of(c);
        let case = &self.cases[k];
        Ok(Some(match c.kind {
            ConstraintKind::MinSafetyFactor => {
                let best = match &c.region {
                    None => case.min_sf,
                    Some(region) => case
                        .cell_safety
                        .iter()
                        .copied()
                        .filter(|cell| self.in_region(self.to_part.point(cell.2), region))
                        .min_by(|a, b| a.0.total_cmp(&b.0)),
                };
                let Some((sf, element, at, governs)) = best else {
                    return Ok(None);
                };
                Reading {
                    value: sf,
                    hot_spot: Some(self.hot_spot(element, at, governs)),
                }
            }
            ConstraintKind::MaxDeflectionMm | ConstraintKind::DeflectionBandMm => {
                let (value, node) = match &c.region {
                    None => case.max_disp,
                    Some(region) => self
                        .region_nodes(region)?
                        .into_iter()
                        .map(|n| (norm(case.solution.displacement[n]), n))
                        .fold((0.0, 0), |a, b| if b.0 > a.0 { b } else { a }),
                };
                Reading {
                    value,
                    hot_spot: Some(self.node_spot(node)),
                }
            }
            ConstraintKind::MinStiffnessNPerMm | ConstraintKind::StiffnessBandNPerMm => {
                let region = c
                    .region
                    .as_ref()
                    .expect("checked: a stiffness target has a region");
                let force = case.force.expect("checked: its case has a force");
                let magnitude = norm(force);
                let along = [
                    force[0] / magnitude,
                    force[1] / magnitude,
                    force[2] / magnitude,
                ];
                let nodes = self.region_nodes(region)?;
                let moved = nodes
                    .iter()
                    .map(|&n| dot(self.displacement_part(k, n), along))
                    .sum::<f64>()
                    / nodes.len() as f64;
                Reading {
                    value: if moved > 1e-15 {
                        magnitude / moved
                    } else {
                        f64::INFINITY
                    },
                    hot_spot: None,
                }
            }
            ConstraintKind::RelativeDeflectionMm => {
                let centre = |region: &Region| -> Result<([f64; 3], [f64; 3]), SimError> {
                    let nodes = self.region_nodes(region)?;
                    let n = nodes.len() as f64;
                    let mut at = [0.0; 3];
                    let mut u = [0.0; 3];
                    for &i in &nodes {
                        let p = self.to_part.point(self.mesh.mesh.nodes[i]);
                        let d = self.displacement_part(k, i);
                        for j in 0..3 {
                            at[j] += p[j] / n;
                            u[j] += d[j] / n;
                        }
                    }
                    Ok((at, u))
                };
                let (a, ua) = centre(c.region.as_ref().expect("checked"))?;
                let (b, ub) = centre(c.other.as_ref().expect("checked"))?;
                let before = norm(sub(b, a));
                let after = norm(sub(
                    [b[0] + ub[0], b[1] + ub[1], b[2] + ub[2]],
                    [a[0] + ua[0], a[1] + ua[1], a[2] + ua[2]],
                ));
                Reading {
                    value: (after - before).abs(),
                    hot_spot: None,
                }
            }
            ConstraintKind::MaxMassG | ConstraintKind::MinMassG => Reading {
                value: case.solution.mass_g,
                hot_spot: None,
            },
        }))
    }

    fn governing(&self, study: &SlicedStudy) -> Result<Governing, SimError> {
        if study.constraints.is_empty() {
            return Ok(if self.cases[0].min_sf.is_some() {
                Governing::SafetyFactor
            } else {
                Governing::Nothing
            });
        }
        let mut best: Option<(usize, f64)> = None;
        for (i, c) in study.constraints.iter().enumerate() {
            if let Some(reading) = self.read(c)? {
                let m = signed_margin(c, reading.value);
                if best.is_none_or(|(_, b)| m < b) {
                    best = Some((i, m));
                }
            }
        }
        Ok(best.map_or(Governing::Nothing, |(i, _)| Governing::Target(i)))
    }

    fn governing_value(
        &self,
        governing: Governing,
        study: &SlicedStudy,
    ) -> Result<Option<f64>, SimError> {
        Ok(match governing {
            Governing::Target(i) => self.read(&study.constraints[i])?.map(|r| r.value),
            Governing::SafetyFactor => self.cases[0].min_sf.map(|s| s.0),
            Governing::Nothing => None,
        })
    }

    fn resolution(
        &self,
        governing: Governing,
        study: &SlicedStudy,
    ) -> Result<Resolution, SimError> {
        Ok(Resolution {
            h_xy_mm: self.mesh.h_xy,
            nodes: self.mesh.mesh.nodes.len(),
            factorisations: self.factorisations,
            governing_value: self.governing_value(governing, study)?,
        })
    }

    fn hot_spot(&self, element: usize, slice_point: [f64; 3], governs: Option<Governs>) -> HotSpot {
        let cell = self.mesh.cells[element];
        let z = slice_point[2];
        let layer = self
            .layers
            .iter()
            .find(|(_, bottom, top)| z >= *bottom - 1e-9 && z <= *top + 1e-9)
            .or_else(|| {
                self.layers.iter().min_by(|a, b| {
                    let da = (0.5 * (a.1 + a.2) - z).abs();
                    let db = (0.5 * (b.1 + b.2) - z).abs();
                    da.total_cmp(&db)
                })
            });
        HotSpot {
            at: self.to_part.point(slice_point),
            layer: layer.map(|l| l.0),
            layer_z_mm: layer.map(|l| l.2),
            role: ROLES.get(cell.role as usize).unwrap_or(&"wall").to_string(),
            governs,
        }
    }

    fn margin(&self, c: &Constraint, level: TrustLevel) -> Result<Margin, SimError> {
        let reading = self.read(c)?;
        let value = reading.as_ref().map_or(f64::INFINITY, |r| r.value);
        let margin = reading
            .as_ref()
            .map_or(f64::INFINITY, |r| signed_margin(c, r.value));
        Ok(Margin {
            kind: c.kind,
            limit: if c.kind.is_band() { 0.0 } else { c.value },
            band: c.band,
            load_case: self.names[self.case_of(c)].clone(),
            value,
            margin,
            met: margin >= 0.0 && level != TrustLevel::Rough,
            note: band_note(c, value),
            hot_spot: reading.and_then(|r| r.hot_spot),
        })
    }
}

/// Signed and relative. A floor: `(value − S) / S`. A ceiling:
/// `(L − value) / L`. A band: the distance to the nearer edge over the
/// half-width, 1 at the centre, 0 at each edge, negative outside.
pub fn signed_margin(c: &Constraint, value: f64) -> f64 {
    if let Some([lo, hi]) = c.band.filter(|_| c.kind.is_band()) {
        return (value - lo).min(hi - value) / (0.5 * (hi - lo));
    }
    if c.kind.is_floor() {
        (value - c.value) / c.value
    } else {
        (c.value - value) / c.value
    }
}

/// The side a band missed, as a sentence. Inside it, nothing.
fn band_note(c: &Constraint, value: f64) -> Option<String> {
    let [lo, hi] = c.band.filter(|_| c.kind.is_band())?;
    let v = format_num(value);
    match c.kind {
        ConstraintKind::DeflectionBandMm if value < lo => Some(format!(
            "Too stiff: it moves {v} mm, and the band starts at {} mm.",
            format_num(lo)
        )),
        ConstraintKind::DeflectionBandMm if value > hi => Some(format!(
            "Too flexible: it moves {v} mm, and the band ends at {} mm.",
            format_num(hi)
        )),
        ConstraintKind::StiffnessBandNPerMm if value < lo => Some(format!(
            "Too flexible: it takes {v} N/mm, and the band starts at {} N/mm.",
            format_num(lo)
        )),
        ConstraintKind::StiffnessBandNPerMm if value > hi => Some(format!(
            "Too stiff: it takes {v} N/mm, and the band ends at {} N/mm.",
            format_num(hi)
        )),
        _ => None,
    }
}

fn nearest_element(mesh: &Mesh, node: usize) -> usize {
    mesh.elements
        .iter()
        .position(|e| e.nodes.contains(&node))
        .unwrap_or(0)
}

fn format_mm(mm: f64) -> String {
    let text = format!("{mm:.2}");
    text.trim_end_matches('0').trim_end_matches('.').to_string()
}

/// Three significant figures, no trailing zeros.
fn format_num(value: f64) -> String {
    if !value.is_finite() || value == 0.0 {
        return format!("{value}");
    }
    let digits = (2 - value.abs().log10().floor() as i32).max(0) as usize;
    let text = format!("{value:.digits$}");
    if text.contains('.') {
        text.trim_end_matches('0').trim_end_matches('.').to_string()
    } else {
        text
    }
}
