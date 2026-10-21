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
use crate::solve_request;
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

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ConstraintKind {
    MinSafetyFactor,
    MaxDeflectionMm,
    MaxMassG,
    MinMassG,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Constraint {
    pub kind: ConstraintKind,
    pub value: f64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SlicedStudy {
    /// The cell size. Absent, the largest whose dense grid fits the cap.
    #[serde(default)]
    pub h_xy: Option<f64>,
    pub card: Card,
    pub holds: Vec<SlicedHold>,
    pub loads: Vec<SlicedLoad>,
    #[serde(default)]
    pub constraints: Vec<Constraint>,
    /// Run the second cell size even when it is past the cap is not an
    /// option; this turns it off for a quick look.
    #[serde(default = "yes")]
    pub check_resolution: bool,
}

fn yes() -> bool {
    true
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
    pub limit: f64,
    pub value: f64,
    /// 0 on the limit, positive inside it, as a share of the limit.
    pub margin: f64,
    /// Inside the limit and trusted enough to say so.
    pub met: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hot_spot: Option<HotSpot>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Resolution {
    pub h_xy_mm: f64,
    pub nodes: usize,
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
    /// The lowest safety factor at any Gauss point of any cell, the
    /// staircase's steps and corners included.
    pub raw_min_safety_factor: Option<f64>,
    /// The lowest safety factor the margins read: cell averages, boundary
    /// cells under half full skipped.
    pub min_safety_factor: Option<f64>,
    pub max_displacement_mm: f64,
    pub mass_g: f64,
    pub resolutions: Vec<Resolution>,
    #[serde(skip)]
    pub solution: Option<Solution>,
    #[serde(skip)]
    pub mesh: Option<SlicedMesh>,
    /// The second cell size's solve, when it ran.
    #[serde(skip)]
    pub finer: Option<(Solution, SlicedMesh)>,
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
    if study.loads.is_empty() {
        return Err(SimError::new("This study has no load."));
    }
    for c in &study.constraints {
        if !(c.value.is_finite() && c.value > 0.0) {
            return Err(SimError::new("A target has to be a positive number."));
        }
    }
    let to_part = Affine {
        m: field.header.frame,
    };
    let to_slice = to_part
        .inverse()
        .ok_or_else(|| SimError::new("The slice field's frame can't be inverted."))?;
    let h = study.h_xy.unwrap_or_else(|| default_h_xy(field));
    let first = solve_at(field, study, h, to_part, to_slice)?;
    let mut resolutions = vec![first.resolution(study)];
    let mut notes = first.solution.notes.clone();
    let governing = first.governing(study);
    let mut finer = None;
    let mut moved = None;
    let fine = h / std::f64::consts::SQRT_2;
    // The node count goes with the cell count, about h⁻³ while slabs follow
    // the layers; √2 finer is about 2.8 times the nodes.
    let estimate = (first.solution.mesh.nodes.len() as f64 * 2.83) as usize;
    let one_size_why = if !study.check_resolution {
        "The sliced result was solved at one cell size only.".to_string()
    } else if estimate > NODE_CAP {
        format!(
            "This part is too large for a second cell size under the node cap, so the sliced result was not checked at {} mm.",
            format_mm(fine)
        )
    } else {
        let second = solve_at(field, study, fine, to_part, to_slice)?;
        resolutions.push(second.resolution(study));
        if let (Some(k), Some(a)) = (governing, first.value(governing)) {
            let b = second
                .value(Some(k))
                .expect("the same constraint on both grids");
            moved = Some((a - b).abs() / a.abs().max(b.abs()).max(1e-30));
        }
        finer = Some((second.solution, second.mesh));
        String::new()
    };
    if moved.is_none() && one_size_why.is_empty() {
        // Both sizes ran but nothing governs: no target and no stress.
        moved = Some(0.0);
    }
    let provisional =
        study.card.provisional || study.card.beads.as_ref().is_some_and(|b| b.provisional);
    let (level, why) = sliced_trust(provisional, moved, &one_size_why);
    notes.extend(why);
    let margins = study
        .constraints
        .iter()
        .map(|c| first.margin(c, level))
        .collect();
    Ok(SlicedReport {
        representation: "sliced",
        h_xy_mm: h,
        trust: level,
        notes,
        margins,
        raw_min_safety_factor: first.raw_min_sf.map(|s| s.0),
        min_safety_factor: first.min_sf.map(|s| s.0),
        max_displacement_mm: first.max_disp.0,
        mass_g: first.solution.mass_g,
        resolutions,
        solution: Some(first.solution),
        mesh: Some(first.mesh),
        finer,
    })
}

struct Solved {
    mesh: SlicedMesh,
    solution: Solution,
    to_part: Affine,
    layers: Vec<(u32, f64, f64)>,
    /// Lowest safety factor, the element it is in, the slice-frame point,
    /// and what governs it.
    min_sf: Option<(f64, usize, [f64; 3], Option<Governs>)>,
    raw_min_sf: Option<(f64, usize, [f64; 3])>,
    /// Largest displacement and its node.
    max_disp: (f64, usize),
}

fn solve_at(
    field: &SliceField,
    study: &SlicedStudy,
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
    let mut loads = Vec::new();
    for load in &study.loads {
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
                    loads.push(Load::Traction {
                        nodes: face.nodes.clone(),
                        traction: [t[0] / area, t[1] / area, t[2] / area],
                    });
                }
            }
            SlicedLoad::Pressure { mpa, .. } => {
                for face in picked {
                    let n = face.normal;
                    loads.push(Load::Traction {
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
                    loads.push(Load::Traction {
                        nodes: face.nodes.clone(),
                        traction: t,
                    });
                }
            }
        }
    }
    let card = &study.card;
    let req = Request {
        mesh: mesh.clone(),
        material: card.material(),
        recipe: crate::recipe::Recipe::solid(),
        // The grid is in the slice frame, where the layers stack along +Z.
        build_axis: [0.0, 0.0, 1.0],
        holds,
        loads,
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
    let solution = solve_request(&req)?;
    let allow = card.material().allowables();
    let axis = [0.0, 0.0, 1.0];
    let safety = |stress: [f64; 6], element: usize| {
        let ctx = sliced.cells[element].context(axis);
        match &card.beads {
            Some(b) => BeadMaxStress { beads: b }.safety_governed(&Stress { v: stress }, &ctx),
            None => (MaxStress.safety(&Stress { v: stress }, &allow, &ctx), None),
        }
    };
    let mut raw_min_sf: Option<(f64, usize, [f64; 3])> = None;
    for sample in &solution.gauss {
        let (sf, _) = safety(sample.stress, sample.element);
        if sf.is_finite() && raw_min_sf.is_none_or(|(best, _, _)| sf < best) {
            raw_min_sf = Some((sf, sample.element, sample.xyz));
        }
    }
    let mut min_sf: Option<(f64, usize, [f64; 3], Option<Governs>)> = None;
    for cell in cell_stresses(&solution, &sliced) {
        if cell.staircase {
            continue;
        }
        let (sf, governs) = safety(cell.stress, cell.element);
        if sf.is_finite() && min_sf.is_none_or(|(best, ..)| sf < best) {
            min_sf = Some((sf, cell.element, cell.at, governs));
        }
    }
    let max_disp = solution
        .displacement
        .iter()
        .enumerate()
        .map(|(i, u)| (norm(*u), i))
        .fold((0.0, 0), |a, b| if b.0 > a.0 { b } else { a });
    let mut layers: Vec<(u32, f64, f64)> = field
        .header
        .layers
        .iter()
        .map(|l| (l.index, l.z_mm - l.height_mm, l.z_mm))
        .collect();
    layers.sort_by(|a, b| a.1.total_cmp(&b.1));
    Ok(Solved {
        mesh: sliced,
        solution,
        to_part,
        layers,
        min_sf,
        raw_min_sf,
        max_disp,
    })
}

impl Solved {
    fn value(&self, kind: Option<ConstraintKind>) -> Option<f64> {
        self.value_of(kind?)
    }

    /// The constraint with the smallest margin, or the safety factor when
    /// the study names none.
    fn governing(&self, study: &SlicedStudy) -> Option<ConstraintKind> {
        if study.constraints.is_empty() {
            return self.min_sf.map(|_| ConstraintKind::MinSafetyFactor);
        }
        study
            .constraints
            .iter()
            .filter_map(|c| Some((c.kind, signed_margin(c, self.value(Some(c.kind))?))))
            .min_by(|a, b| a.1.total_cmp(&b.1))
            .map(|(k, _)| k)
    }

    fn resolution(&self, study: &SlicedStudy) -> Resolution {
        Resolution {
            h_xy_mm: self.mesh.h_xy,
            nodes: self.solution.mesh.nodes.len(),
            governing_value: self.value(self.governing(study)),
        }
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

    fn margin(&self, c: &Constraint, level: TrustLevel) -> Margin {
        let value = self.value_of(c.kind);
        let margin = value.map_or(f64::INFINITY, |v| signed_margin(c, v));
        let hot_spot = match c.kind {
            ConstraintKind::MinSafetyFactor => self
                .min_sf
                .map(|(_, element, at, governs)| self.hot_spot(element, at, governs)),
            ConstraintKind::MaxDeflectionMm => {
                let node = self.max_disp.1;
                let at = self.solution.mesh.nodes[node];
                let element = nearest_element(&self.solution.mesh, node);
                Some(self.hot_spot(element, at, None))
            }
            ConstraintKind::MaxMassG | ConstraintKind::MinMassG => None,
        };
        Margin {
            kind: c.kind,
            limit: c.value,
            value: value.unwrap_or(f64::INFINITY),
            margin,
            met: margin >= 0.0 && level != TrustLevel::Rough,
            hot_spot,
        }
    }

    fn value_of(&self, kind: ConstraintKind) -> Option<f64> {
        match kind {
            ConstraintKind::MinSafetyFactor => self.min_sf.map(|s| s.0),
            ConstraintKind::MaxDeflectionMm => Some(self.max_disp.0),
            ConstraintKind::MaxMassG | ConstraintKind::MinMassG => Some(self.solution.mass_g),
        }
    }
}

/// `(value − S) / S` for a floor, `(L − value) / L` for a ceiling.
fn signed_margin(c: &Constraint, value: f64) -> f64 {
    match c.kind {
        ConstraintKind::MinSafetyFactor | ConstraintKind::MinMassG => (value - c.value) / c.value,
        ConstraintKind::MaxDeflectionMm | ConstraintKind::MaxMassG => (c.value - value) / c.value,
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
