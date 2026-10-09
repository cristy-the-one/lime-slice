//! Belt slicing.
//!
//! The nozzle plane is tilted to the belt by `angle`. This rotates the mesh
//! about the across-belt axis until that plane is horizontal, the planar
//! pipeline slices it, and emit maps the moves back into the gantry frame.
//! A missing belt is not a belt: nothing here runs, and the cartesian writer
//! is untouched.
//!
//! Belt advance per layer is `layer_height / sin(angle)`. `angle` is the
//! angle between the belt and the nozzle plane, so 35° uses sine, not cosine.

use serde::{Deserialize, Serialize};

use crate::mesh::Mesh;
use crate::toolpath::{Extrusion, PathKind, TravelIn};

/// Wire belt. Absent on a cartesian request, and omitted from its JSON.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BeltSpec {
    pub angle_deg: f64,
    /// Firmware axis that advances the belt: `x`, `y`, or `z`.
    pub axis: String,
    /// `1` or `-1`.
    pub direction: i32,
    pub width_mm: f64,
    /// Omitted when the belt is unlimited. `null` is the same as omitted.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_length_mm: Option<f64>,
    pub copies: u32,
    pub gap_mm: f64,
    /// Pull an explicit seam onto the belt edge. Omitted when off, so a
    /// request that does not set it keeps its bytes. `blend` already lands
    /// on that edge.
    #[serde(default, skip_serializing_if = "is_false")]
    pub seam_on_edge: bool,
    /// Layers of a solid pad on the belt before the part. Omitted when 0,
    /// so a belt slice that does not ask for a raft keeps its bytes.
    #[serde(default, skip_serializing_if = "is_zero")]
    pub raft_layers: u32,
    /// Grow supports down to the tilted belt instead of forcing them off.
    /// Omitted when off, so a belt slice that does not ask keeps its bytes,
    /// including one that set `supports` and still prints none.
    #[serde(default, skip_serializing_if = "is_false")]
    pub floor_supports: bool,
}

/// Which firmware axis the belt is wired to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum BeltAxis {
    X,
    Y,
    Z,
}

/// A belt the planner and the writer can use. Lengths are millimetres.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Belt {
    pub angle_deg: f64,
    pub sin_a: f64,
    pub cos_a: f64,
    pub axis: BeltAxis,
    pub direction: f64,
    pub width_mm: f64,
    pub max_length_mm: Option<f64>,
    pub copies: u32,
    pub gap_mm: f64,
    pub seam_on_edge: bool,
    pub raft_layers: u32,
    pub floor_supports: bool,
    /// The rotation that laid the plate flat. No shift until `lay_flat` sets it.
    pub frame: Frame,
    /// Slice Z the belt run starts from: the bottom of the first printed
    /// layer. Above 0 only when floor supports lowered the frame further
    /// than any tree reached.
    pub start: f64,
}

/// The rotation that laid the plate flat, so preview points can be mapped back.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Frame {
    pub sin_a: f64,
    pub cos_a: f64,
    /// Subtracted from rotated Z. Adding it back is the inverse.
    pub z_drop: f64,
    /// Subtracted from rotated Y so the rail starts at 0.
    pub y_shift: f64,
}

/// A pad on the belt under the plate, in the lab: the footprint it covers and
/// how far it stands off the belt. The parts are lifted onto its top.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Raft {
    pub min: [f64; 2],
    pub max: [f64; 2],
    pub top: f64,
    pub line_width: f64,
}

impl Raft {
    fn corners(&self) -> [[f64; 3]; 8] {
        let ([x0, y0], [x1, y1], z1) = (self.min, self.max, self.top);
        [
            [x0, y0, 0.0],
            [x1, y0, 0.0],
            [x0, y1, 0.0],
            [x1, y1, 0.0],
            [x0, y0, z1],
            [x1, y0, z1],
            [x0, y1, z1],
            [x1, y1, z1],
        ]
    }

    /// Slice Y of each pad line on the nozzle plane at `slice_z`. A plane
    /// crosses the pad in a band from the belt up to `top / sin(angle)`; the
    /// fewest lines that cover it share it evenly, and only where the band is
    /// over the footprint along the belt.
    pub(crate) fn lines(&self, frame: &Frame, slice_z: f64) -> Vec<f64> {
        let band = self.top / frame.sin_a;
        let n = ((band / self.line_width).ceil() as usize).max(1);
        let z_rot = slice_z + frame.z_drop;
        (0..n)
            .map(|k| {
                let gantry = (k as f64 + 0.5) * band / n as f64;
                z_rot * frame.cos_a / frame.sin_a - gantry - frame.y_shift
            })
            .filter(|&y| {
                let lab_y = frame.lab(0.0, y, slice_z)[1];
                (self.min[1]..=self.max[1]).contains(&lab_y)
            })
            .collect()
    }
}

/// Layer-0 speed and flow, applied to the belt-contact edge of later layers.
pub(crate) const WALL_SPEED_MM_S: f64 = 30.0;
pub(crate) const WALL_FLOW: f64 = 1.06;

const ANGLE_MIN: f64 = 10.0;
const ANGLE_MAX: f64 = 80.0;

fn is_false(value: &bool) -> bool {
    !*value
}

fn is_zero(value: &u32) -> bool {
    *value == 0
}

impl Belt {
    pub(crate) fn resolve(spec: &BeltSpec) -> Result<Self, String> {
        if !spec.angle_deg.is_finite() || spec.angle_deg < ANGLE_MIN || spec.angle_deg > ANGLE_MAX {
            return Err(format!(
                "belt.angleDeg {} is outside {ANGLE_MIN} to {ANGLE_MAX}",
                spec.angle_deg
            ));
        }
        let axis = match spec.axis.as_str() {
            "x" => BeltAxis::X,
            "y" => BeltAxis::Y,
            "z" => BeltAxis::Z,
            other => return Err(format!("belt.axis \"{other}\" is not x, y, or z")),
        };
        if spec.direction != 1 && spec.direction != -1 {
            return Err(format!("belt.direction {} is not 1 or -1", spec.direction));
        }
        if !spec.width_mm.is_finite() || spec.width_mm < 10.0 || spec.width_mm > 4000.0 {
            return Err(format!(
                "belt.widthMm {} must be from 10 to 4000",
                spec.width_mm
            ));
        }
        if let Some(length) = spec.max_length_mm {
            if !length.is_finite() || !(10.0..=100_000.0).contains(&length) {
                return Err(format!(
                    "belt.maxLengthMm {length} must be from 10 to 100000"
                ));
            }
        }
        if spec.copies < 1 || spec.copies > 24 {
            return Err(format!("belt.copies {} must be from 1 to 24", spec.copies));
        }
        if !spec.gap_mm.is_finite() || spec.gap_mm < 0.0 || spec.gap_mm > 500.0 {
            return Err(format!("belt.gapMm {} must be from 0 to 500", spec.gap_mm));
        }
        if spec.raft_layers > 8 {
            return Err(format!(
                "belt.raftLayers {} must be from 1 to 8, or omitted",
                spec.raft_layers
            ));
        }
        let rad = spec.angle_deg.to_radians();
        Ok(Self {
            angle_deg: spec.angle_deg,
            sin_a: rad.sin(),
            cos_a: rad.cos(),
            axis,
            direction: f64::from(spec.direction),
            width_mm: spec.width_mm,
            max_length_mm: spec.max_length_mm,
            copies: spec.copies,
            gap_mm: spec.gap_mm,
            seam_on_edge: spec.seam_on_edge,
            raft_layers: spec.raft_layers,
            floor_supports: spec.floor_supports,
            frame: Frame {
                sin_a: rad.sin(),
                cos_a: rad.cos(),
                z_drop: 0.0,
                y_shift: 0.0,
            },
            start: 0.0,
        })
    }

    /// Gantry coordinate of a slice-frame point: how far up the nozzle plane
    /// it is from the belt, which is its lab height over `sin(angle)`. Slice Y
    /// runs down the plane and its zero moves every layer, so it is not this.
    pub(crate) fn gantry(&self, y: f64, slice_z: f64) -> f64 {
        self.frame.lab(0.0, y, slice_z)[2] / self.sin_a
    }

    /// Belt travel between two layers of perpendicular height `layer_height`.
    pub(crate) fn advance(layer_height: f64, sin_a: f64) -> f64 {
        layer_height / sin_a
    }

    /// Belt position of a nozzle plane at slice height `slice_z`, plus the
    /// copy shift. `shift` is along the belt, before the direction sign.
    pub(crate) fn position(&self, slice_z: f64, shift: f64) -> f64 {
        self.direction * (Self::advance(slice_z - self.start, self.sin_a) + shift)
    }

    /// How far apart two copies sit on the belt: the part's belt extent plus the gap.
    pub(crate) fn stride(&self, extent: f64) -> f64 {
        extent + self.gap_mm
    }

    /// Belt length of `copies` placed `stride` apart, including one extent.
    pub(crate) fn run_mm(&self, extent: f64) -> f64 {
        let copies = f64::from(self.copies);
        copies * extent + (copies - 1.0) * self.gap_mm
    }

    pub(crate) fn comment(&self) -> String {
        let axis = match self.axis {
            BeltAxis::X => "X",
            BeltAxis::Y => "Y",
            BeltAxis::Z => "Z",
        };
        let dir = if self.direction < 0.0 { "-1" } else { "+1" };
        let mut comment = format!(
            "; belt: angle {} axis {axis} dir {dir}\n",
            format_angle(self.angle_deg)
        );
        if self.raft_layers > 0 {
            comment.push_str(&format!("; belt raft {} layers\n", self.raft_layers));
        }
        if self.floor_supports {
            comment.push_str("; belt floor supports\n");
        }
        comment
    }
}

impl Frame {
    /// Lab point of a slice-frame point. X is across the belt and is unchanged.
    pub(crate) fn lab(&self, x: f64, y: f64, z: f64) -> [f64; 3] {
        let y_rot = y + self.y_shift;
        let z_rot = z + self.z_drop;
        let y_lab = y_rot * self.cos_a + z_rot * self.sin_a;
        let z_lab = -y_rot * self.sin_a + z_rot * self.cos_a;
        [x, y_lab, z_lab]
    }

    /// The move a part at `to_bed`, lifted by `lift`, took to lie flat, as the
    /// rotation (row-major), pivot and translation of a pose. A paint disk
    /// posed with it lands where the mesh vertex under it did.
    pub(crate) fn pose(&self, to_bed: [f64; 2], lift: f64) -> ([f64; 9], [f64; 3], [f64; 3]) {
        let (c, s) = (self.cos_a, self.sin_a);
        (
            [1.0, 0.0, 0.0, 0.0, c, -s, 0.0, s, c],
            [-to_bed[0], -to_bed[1], -lift],
            [0.0, -self.y_shift, -self.z_drop],
        )
    }

    /// The bead bottom at `layer_z` is on the belt.
    pub(crate) fn on_belt(&self, x: f64, y: f64, layer_z: f64, height: f64) -> bool {
        let bottom = self.lab(x, y, (layer_z - height).max(0.0))[2];
        bottom <= height * 0.75
    }
}

/// Translate a mesh in X/Y. Z is the height above the belt and stays.
pub(crate) fn translate_xy(mesh: &Mesh, offset: [f64; 2]) -> Mesh {
    if offset == [0.0, 0.0] {
        return mesh.clone();
    }
    let mut triangles = mesh.triangles.clone();
    for tri in &mut triangles {
        for v in tri.iter_mut() {
            v[0] += offset[0];
            v[1] += offset[1];
        }
    }
    Mesh { triangles }
}

/// Rotate each mesh about X by the belt angle, then drop the plate onto Z = 0
/// and shift Y so the rail starts at 0. One frame for the whole plate and its
/// raft, so the first layer is where the plane first meets either.
/// Floor supports lower the plate by whole `layer_height` steps, so the part
/// is cut on the same planes.
pub(crate) fn lay_flat(
    meshes: &[Mesh],
    belt: &Belt,
    raft: Option<&Raft>,
    layer_height: f64,
) -> Result<(Vec<Mesh>, Frame), String> {
    let rotated: Vec<Mesh> = meshes
        .iter()
        .map(|m| rotate_x(m, belt.cos_a, belt.sin_a))
        .collect();
    let mut min_y = f64::INFINITY;
    let mut min_z = f64::INFINITY;
    let mut any = false;
    for mesh in &rotated {
        let Some((min, _)) = mesh.bounds() else {
            continue;
        };
        any = true;
        min_y = min_y.min(min[1]);
        min_z = min_z.min(min[2]);
    }
    for [_, y, z] in raft.map(Raft::corners).into_iter().flatten() {
        min_y = min_y.min(y * belt.cos_a - z * belt.sin_a);
        min_z = min_z.min(y * belt.sin_a + z * belt.cos_a);
    }
    if !any || !min_z.is_finite() {
        return Err("empty mesh".into());
    }
    // Supports grow down to the belt. The lowest plane any of them can need
    // meets it under the plate's upstream edge.
    if belt.floor_supports {
        let belt_z = min_y * belt.sin_a / belt.cos_a;
        min_z -= ((min_z - belt_z) / layer_height).ceil() * layer_height;
    }
    let frame = Frame {
        sin_a: belt.sin_a,
        cos_a: belt.cos_a,
        z_drop: min_z,
        y_shift: min_y,
    };
    let laid = rotated
        .into_iter()
        .map(|mesh| shift_yz(&mesh, -min_y, -min_z))
        .collect();
    Ok((laid, frame))
}

/// Across-belt span, and the slice height the belt extent is measured from.
pub(crate) fn plate_span(meshes: &[Mesh]) -> Result<(f64, f64), String> {
    let mut min_x = f64::INFINITY;
    let mut max_x = f64::NEG_INFINITY;
    let mut max_z = f64::NEG_INFINITY;
    for mesh in meshes {
        let (min, max) = mesh.bounds().ok_or("empty mesh")?;
        min_x = min_x.min(min[0]);
        max_x = max_x.max(max[0]);
        max_z = max_z.max(max[2]);
    }
    if !max_z.is_finite() {
        return Err("empty mesh".into());
    }
    Ok((max_x - min_x, max_z))
}

pub(crate) fn check_fit(belt: &Belt, span_x: f64, extent: f64) -> Result<(), String> {
    if span_x > belt.width_mm + 1e-3 {
        return Err(format!(
            "belt.widthMm {} is narrower than the part, which is {span_x:.2} mm across the belt",
            belt.width_mm
        ));
    }
    if let Some(cap) = belt.max_length_mm {
        let run = belt.run_mm(extent);
        if run > cap + 1e-3 {
            return Err(format!(
                "belt.maxLengthMm {cap} is shorter than the belt run of {run:.2} mm"
            ));
        }
    }
    Ok(())
}

/// Rotate about X so the nozzle plane, which climbed by `angle` from the belt, lies flat.
fn rotate_x(mesh: &Mesh, cos_a: f64, sin_a: f64) -> Mesh {
    let mut triangles = Vec::with_capacity(mesh.triangles.len());
    for tri in &mesh.triangles {
        let mut out = [[0.0; 3]; 3];
        for (slot, v) in out.iter_mut().zip(tri.iter()) {
            slot[0] = v[0];
            slot[1] = v[1] * cos_a - v[2] * sin_a;
            slot[2] = v[1] * sin_a + v[2] * cos_a;
        }
        triangles.push(out);
    }
    Mesh { triangles }
}

pub(crate) fn shift_z(mesh: &Mesh, dz: f64) -> Mesh {
    shift_yz(mesh, 0.0, dz)
}

fn shift_yz(mesh: &Mesh, dy: f64, dz: f64) -> Mesh {
    let mut triangles = mesh.triangles.clone();
    for tri in &mut triangles {
        for v in tri.iter_mut() {
            v[1] += dy;
            v[2] += dz;
        }
    }
    Mesh { triangles }
}

fn format_angle(deg: f64) -> String {
    let rounded = (deg * 100.0).round() / 100.0;
    let text = format!("{rounded:.2}");
    text.trim_end_matches('0').trim_end_matches('.').to_string()
}

/// Slow and fatten the belt-contact edge of an outer wall.
/// `slow_all` is a later copy's first layer: the whole layer is that edge's job.
pub(crate) fn retouch(
    path: &Extrusion,
    layer_z: f64,
    height: f64,
    frame: &Frame,
    slow_all: bool,
) -> Vec<Extrusion> {
    if slow_all {
        return vec![slow(path)];
    }
    if path.kind != PathKind::Outer && path.kind != PathKind::Wall {
        return vec![path.clone()];
    }
    if path.points.len() < 2 {
        return vec![path.clone()];
    }
    let on: Vec<bool> = path
        .points
        .iter()
        .map(|p| frame.on_belt(p[0], p[1], layer_z, height))
        .collect();
    if on.iter().all(|hit| !hit) {
        return vec![path.clone()];
    }
    if on.iter().all(|hit| *hit) {
        return vec![slow(path)];
    }
    split_contact(path, &on)
}

fn slow(path: &Extrusion) -> Extrusion {
    let mut path = path.clone();
    path.speed = path.speed.min(WALL_SPEED_MM_S);
    path.flow *= WALL_FLOW;
    path.fan = 0;
    path
}

/// Split an outer wall into contact and free runs. A contact run under 0.8 mm
/// stays at the path's own speed: a corner speck is not a belt wall.
fn split_contact(path: &Extrusion, on: &[bool]) -> Vec<Extrusion> {
    let mut groups = Vec::new();
    let mut start = 0usize;
    for i in 1..=on.len() {
        if i == on.len() || on[i] != on[start] {
            groups.push((start, i, on[start]));
            start = i;
        }
    }
    for group in &mut groups {
        if group.2 && run_len(&path.points, group.0, group.1) < 0.8 {
            group.2 = false;
        }
    }
    let mut merged: Vec<(usize, usize, bool)> = Vec::new();
    for group in groups {
        if let Some(prev) = merged.last_mut() {
            if prev.2 == group.2 {
                prev.1 = group.1;
                continue;
            }
        }
        merged.push(group);
    }
    if merged.len() == 1 {
        return vec![if merged[0].2 {
            slow(path)
        } else {
            path.clone()
        }];
    }
    let mut out = Vec::with_capacity(merged.len());
    for (n, (a, b, contact)) in merged.into_iter().enumerate() {
        let mut piece = path.clone();
        // Share the boundary vertex so the next run starts where this one ends.
        let end = if b < path.points.len() { b + 1 } else { b };
        let from = a.min(end.saturating_sub(1));
        piece.points = path.points[from..end].to_vec();
        if piece.points.len() < 2 {
            continue;
        }
        if n > 0 {
            piece.lead_in.clear();
            piece.travel_in = TravelIn::Inside;
            piece.z_frac.clear();
            piece.flow_frac.clear();
        } else {
            piece.z_frac = slice_frac(&path.z_frac, from, end);
            piece.flow_frac = slice_frac(&path.flow_frac, from, end);
        }
        if contact {
            piece = slow(&piece);
        }
        out.push(piece);
    }
    if out.is_empty() {
        vec![path.clone()]
    } else {
        out
    }
}

fn slice_frac(frac: &[f64], from: usize, end: usize) -> Vec<f64> {
    if frac.is_empty() {
        Vec::new()
    } else {
        frac.get(from..end).unwrap_or(&[]).to_vec()
    }
}

fn run_len(points: &[[f64; 2]], a: usize, b: usize) -> f64 {
    let end = b.min(points.len());
    if a >= end {
        return 0.0;
    }
    points[a..end]
        .windows(2)
        .map(|w| {
            let dx = w[1][0] - w[0][0];
            let dy = w[1][1] - w[0][1];
            dx.hypot(dy)
        })
        .sum()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn belt_at(angle: f64) -> Belt {
        Belt::resolve(&BeltSpec {
            angle_deg: angle,
            axis: "z".into(),
            direction: 1,
            width_mm: 220.0,
            max_length_mm: None,
            copies: 1,
            gap_mm: 5.0,
            seam_on_edge: false,
            raft_layers: 0,
            floor_supports: false,
        })
        .unwrap()
    }

    #[test]
    fn advance_at_45_is_layer_height_times_sqrt2() {
        let belt = belt_at(45.0);
        let step = Belt::advance(0.2, belt.sin_a);
        assert!((step - 0.2 * std::f64::consts::SQRT_2).abs() < 1e-12);
    }

    #[test]
    fn advance_at_35_uses_sine_not_cosine() {
        let belt = belt_at(35.0);
        let step = Belt::advance(0.2, belt.sin_a);
        let sine = 0.2 / 35.0_f64.to_radians().sin();
        let cosine = 0.2 / 35.0_f64.to_radians().cos();
        assert!((step - sine).abs() < 1e-12);
        assert!((step - cosine).abs() > 1e-3);
    }

    #[test]
    fn rotation_keeps_nozzle_plane_lengths() {
        let belt = belt_at(45.0);
        // A unit segment lying in the nozzle plane: direction (0, cos α, -sin α).
        let (c, s) = (belt.cos_a, belt.sin_a);
        let mesh = Mesh {
            triangles: vec![[[0.0, 0.0, 0.0], [0.0, c, -s], [1.0, 0.0, 0.0]]],
        };
        let (laid, frame) = lay_flat(&[mesh], &belt, None, 0.2).unwrap();
        let tri = laid[0].triangles[0];
        let dy = tri[1][1] - tri[0][1];
        let dz = tri[1][2] - tri[0][2];
        assert!(
            dz.abs() < 1e-9,
            "nozzle-plane segment should be horizontal, dz={dz}"
        );
        assert!((dy.abs() - 1.0).abs() < 1e-9, "length {dy}");
        let back = frame.lab(tri[1][0], tri[1][1], tri[1][2]);
        assert!((back[1] - c).abs() < 1e-9);
        assert!((back[2] - (-s)).abs() < 1e-9);
    }

    #[test]
    fn inverse_round_trips_a_cube_corner() {
        let belt = belt_at(45.0);
        let mesh = Mesh {
            triangles: vec![[[0.0, 0.0, 0.0], [20.0, 0.0, 0.0], [0.0, 20.0, 20.0]]],
        };
        let (laid, frame) = lay_flat(&[mesh], &belt, None, 0.2).unwrap();
        for tri in &laid[0].triangles {
            for v in tri {
                let lab = frame.lab(v[0], v[1], v[2]);
                let hit = [[0.0, 0.0, 0.0], [20.0, 0.0, 0.0], [0.0, 20.0, 20.0]]
                    .into_iter()
                    .any(|p| {
                        (p[0] - lab[0]).abs() < 1e-6
                            && (p[1] - lab[1]).abs() < 1e-6
                            && (p[2] - lab[2]).abs() < 1e-6
                    });
                assert!(hit, "lab {lab:?} from slice {v:?}");
            }
        }
    }

    #[test]
    fn a_disk_posed_by_the_frame_lands_on_its_laid_vertex() {
        use crate::support::paint::SeamDisk;
        let belt = belt_at(45.0);
        let (to_bed, lift) = ([12.5, -7.25], 0.6);
        let placed = shift_z(&translate_xy(&box20(), to_bed), lift);
        let (laid, frame) = lay_flat(&[placed], &belt, None, 0.2).unwrap();
        let (rotation, pivot, translation) = frame.pose(to_bed, lift);
        for (tri, flat) in box20().triangles.iter().zip(&laid[0].triangles) {
            for (v, want) in tri.iter().zip(flat) {
                let disk = SeamDisk {
                    p: *v,
                    n: [0.0, 0.0, -1.0],
                    r: 1.5,
                }
                .posed(&rotation, pivot, translation);
                assert_eq!(disk.p, *want);
                assert_eq!(disk.n, [0.0, belt.sin_a, -belt.cos_a]);
                assert_eq!(disk.r, 1.5);
            }
        }
    }

    #[test]
    fn a_cube_extent_at_45_is_the_diagonal() {
        let belt = belt_at(45.0);
        let mesh = box20();
        let (laid, _) = lay_flat(&[mesh], &belt, None, 0.2).unwrap();
        let (_, height) = plate_span(&laid).unwrap();
        let extent = height / belt.sin_a;
        assert!((extent - 40.0).abs() < 1e-6, "extent {extent}");
    }

    #[test]
    fn width_and_length_errors_name_the_field() {
        let mut belt = belt_at(45.0);
        belt.width_mm = 10.0;
        let err = check_fit(&belt, 20.0, 40.0).unwrap_err();
        assert!(err.contains("belt.widthMm"), "{err}");
        belt.width_mm = 220.0;
        belt.max_length_mm = Some(30.0);
        belt.copies = 1;
        let err = check_fit(&belt, 20.0, 40.0).unwrap_err();
        assert!(err.contains("belt.maxLengthMm"), "{err}");
    }

    #[test]
    fn bad_angle_names_the_field() {
        let err = Belt::resolve(&BeltSpec {
            angle_deg: 5.0,
            axis: "z".into(),
            direction: 1,
            width_mm: 200.0,
            max_length_mm: None,
            copies: 1,
            gap_mm: 5.0,
            seam_on_edge: false,
            raft_layers: 0,
            floor_supports: false,
        })
        .unwrap_err();
        assert!(err.contains("belt.angleDeg"), "{err}");
    }

    #[test]
    fn floor_supports_are_omitted_when_off() {
        let spec = BeltSpec {
            angle_deg: 45.0,
            axis: "z".into(),
            direction: 1,
            width_mm: 220.0,
            max_length_mm: None,
            copies: 1,
            gap_mm: 5.0,
            seam_on_edge: false,
            raft_layers: 0,
            floor_supports: false,
        };
        let value = serde_json::to_value(&spec).unwrap();
        assert!(value.get("floorSupports").is_none(), "{value}");
        let parsed: BeltSpec = serde_json::from_value(serde_json::json!({
            "angleDeg": 45.0,
            "axis": "z",
            "direction": 1,
            "widthMm": 220.0,
            "copies": 1,
            "gapMm": 5.0
        }))
        .unwrap();
        assert!(!parsed.floor_supports);
    }

    #[test]
    fn comment_matches_the_preamble_line() {
        let belt = belt_at(45.0);
        assert_eq!(belt.comment(), "; belt: angle 45 axis Z dir +1\n");
        let mut neg = belt_at(35.0);
        neg.direction = -1.0;
        neg.axis = BeltAxis::Y;
        assert_eq!(neg.comment(), "; belt: angle 35 axis Y dir -1\n");
    }

    fn box20() -> Mesh {
        let (x, y, z) = (20.0, 20.0, 20.0);
        let faces = [
            [[0.0, 0.0, 0.0], [x, 0.0, 0.0], [x, y, 0.0]],
            [[0.0, 0.0, 0.0], [x, y, 0.0], [0.0, y, 0.0]],
            [[0.0, 0.0, z], [x, y, z], [x, 0.0, z]],
            [[0.0, 0.0, z], [0.0, y, z], [x, y, z]],
            [[0.0, 0.0, 0.0], [x, 0.0, z], [x, 0.0, 0.0]],
            [[0.0, 0.0, 0.0], [0.0, 0.0, z], [x, 0.0, z]],
            [[0.0, y, 0.0], [x, y, 0.0], [x, y, z]],
            [[0.0, y, 0.0], [x, y, z], [0.0, y, z]],
            [[0.0, 0.0, 0.0], [0.0, y, 0.0], [0.0, y, z]],
            [[0.0, 0.0, 0.0], [0.0, y, z], [0.0, 0.0, z]],
            [[x, 0.0, 0.0], [x, y, z], [x, y, 0.0]],
            [[x, 0.0, 0.0], [x, 0.0, z], [x, y, z]],
        ];
        Mesh {
            triangles: faces.to_vec(),
        }
    }
}
