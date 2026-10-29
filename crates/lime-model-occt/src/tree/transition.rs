//! --- Print transitions (docs/plan-belt-transitions.md, steps 2 and 4): corners and lips on straight edges.
//!
//! A **corner** is a concave, straight edge between two flat faces whose flatter face (the far face) grows flatter to
//! the layers than the angle asked. The wedge fills the air between the faces: its new face holds the edge's direction
//! and makes the asked angle with the layers, so each of its rows stands on the one before. It runs `size` along the far
//! face, or to that face's end. A wedge that stops short of both faces' ends is a chamfer by a distance and an angle
//! from the far face; one that reaches an end is a triangular prism fused on, since a chamfer cannot use up a face.
//!
//! A **lip** is a convex, straight edge between two flat faces that is the lowest point of both along the build, with
//! the flatter face (the underside) flatter to the layers than the angle asked: its first rows appear at once, in the
//! air. The gusset is the underside swept down the build, on the part's side of a plane through the edge at the asked
//! angle, less the solid: the piece under the underside, which must land on the part within `maxMm`. With
//! `mode: "cut"` the underside becomes a ramp from the lip's root up to its first edge's other face instead, refused
//! when it would leave less than `floorMm` there. A concave edge given `case: "lip"` is a lip's root: its flatter face's
//! far edge is the lip's first edge.
//!
//! Every refusal is a sentence, and the solid is not changed.

use std::os::raw::{c_char, c_int};
use std::ptr::NonNull;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::{
    lime_tree_edge_end_faces, lime_tree_edge_stations, lime_tree_face_distances,
    lime_tree_face_span, lime_tree_inside, lime_tree_join, lime_tree_lip_gusset, lime_tree_mesh,
    lime_tree_transition_chamfer, lime_tree_transition_tools, lime_tree_wedges, take_text,
    BuildFail, Built, Mesh, MeshView, Op, RawShape, Shape,
};

/// The support angle: a face holds its own rows at 45° to the layers or steeper.
pub(super) fn default_angle() -> f64 {
    45.0
}

/// The wedge's reach along the far face without a typed `size`.
const DEFAULT_SIZE_MM: f64 = 2.0;
/// The largest wedge built without a typed `maxMm`, along either face; for a lip, the deepest gusset along the build.
const DEFAULT_MAX_MM: f64 = 20.0;
/// The least a lip's ramp leaves at its first edge without a typed `floorMm`: two widths of a 0.4 mm nozzle.
const DEFAULT_FLOOR_MM: f64 = 0.8;
/// Shorter edges are refused.
const MIN_EDGE_MM: f64 = 0.2;
/// The new face may be off the asked angle by this much, measured on the built solid.
const ANGLE_CHECK_DEG: f64 = 1.0;
/// A wedge closer than this to a face's end is built to the end, as a prism.
const END_MM: f64 = 0.05;
/// A curved edge, or an edge on a curved face, is read about this often along its length.
const STATION_MM: f64 = 1.0;
/// A swept or pushed wedge's sides sink this far into their faces, past any gap the faces' curve leaves, so the
/// boolean never meets a face it only touches.
const SINK_MM: f64 = 0.02;
/// The most a face may curve away from one section of wedge, along the edge or across its reach, before it is refused:
/// a quarter of the wedge's smaller reach.
const GAP_SHARE: f64 = 0.25;
/// Edges whose tangents turn more than this where they meet are mitred there (plan section 4).
const MITRE_DEG: f64 = 5.0;

/// How far the wedge reaches along the far face: millimetres, or `"face"`, to that face's end. 2 mm when absent: on the
/// step 2 coupons it held every row a larger wedge held, and from 5 mm up, with Skin on shallow slopes on, a wedge left
/// more rows hanging than no wedge (docs/plan-belt-transitions.md, "As built: step 2"). A lip's gusset ignores it: it
/// runs back into the part until it meets material.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum TransitionSize {
    Mm(f64),
    Word(SizeWord),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SizeWord {
    Face,
}

impl Default for TransitionSize {
    fn default() -> Self {
        TransitionSize::Mm(DEFAULT_SIZE_MM)
    }
}

/// `auto` adds, as `add` does: a wedge in a corner, a gusset under a lip. `cut` turns a thick lip's underside into a ramp.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TransitionMode {
    Auto,
    Add,
    Cut,
}

/// The case, when the user overrides the one found per edge.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TransitionCase {
    Corner,
    Lip,
}

type V3 = [f64; 3];

fn dot(a: V3, b: V3) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

fn cross(a: V3, b: V3) -> V3 {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

fn scale(a: V3, k: f64) -> V3 {
    a.map(|v| v * k)
}

fn add(a: V3, b: V3) -> V3 {
    [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}

fn sub(a: V3, b: V3) -> V3 {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

fn length(a: V3) -> f64 {
    dot(a, a).sqrt()
}

fn unit(a: V3) -> Option<V3> {
    let length = length(a);
    (length.is_finite() && length > 1e-9).then(|| scale(a, 1.0 / length))
}

fn deg(radians: f64) -> f64 {
    radians.to_degrees()
}

/// The angle between a face with outward normal `n` and the layers, for a solid built along `b`: 0° is a face lying in
/// one layer, 90° a wall in the slicer's frame, past 90° a face looking up the build.
fn to_layers(n: V3, b: V3) -> f64 {
    deg(dot(n, scale(b, -1.0)).clamp(-1.0, 1.0).acos())
}

fn refuse(message: impl Into<String>) -> BuildFail {
    BuildFail::plain(message)
}

/// The face's least and most reach from `origin` along `dir`.
fn span(shape: &mut Shape, face: c_int, origin: V3, dir: V3) -> Option<(f64, f64)> {
    let mut out = [0.0f64; 2];
    // SAFETY: `shape` is held for this call; the kernel reads three numbers from each pointer and writes two.
    let ok = unsafe {
        lime_tree_face_span(
            shape.0.as_ptr(),
            face,
            origin.as_ptr(),
            dir.as_ptr(),
            out.as_mut_ptr(),
        )
    };
    (ok != 0 && out.iter().all(|v| v.is_finite())).then_some((out[0], out[1]))
}

/// A point along an edge, from its first vertex as Open CASCADE orients it: the tangent, and the outward normals of the
/// edge's two faces in `EdgeRead::faces` order.
#[derive(Clone, Copy)]
pub(super) struct Station {
    pub p: V3,
    pub t: V3,
    pub n: [V3; 2],
}

/// Stations a curved edge, or an edge on a curved face, is read at: about one per millimetre, at least 5, at most 65.
pub(super) fn station_count(length: f64, even: bool) -> usize {
    if even {
        2
    } else {
        ((length / STATION_MM).ceil() as usize).clamp(4, 64) + 1
    }
}

/// `count` stations along edge `edge`, its faces' normals in the order of `faces`. None when it cannot be read.
pub(super) fn stations(
    shape: &mut Shape,
    edge: c_int,
    faces: [c_int; 2],
    count: usize,
) -> Option<Vec<Station>> {
    let mut out = vec![0.0f64; 12 * count];
    // SAFETY: `shape` is held for this call; the kernel writes 12 numbers per station.
    let ok = unsafe {
        lime_tree_edge_stations(
            shape.0.as_ptr(),
            edge,
            faces[0],
            faces[1],
            count as c_int,
            out.as_mut_ptr(),
        )
    };
    if ok == 0 || !out.iter().all(|v| v.is_finite()) {
        return None;
    }
    let read = |s: &[f64], at: usize| [s[at], s[at + 1], s[at + 2]];
    let found: Vec<Station> = out
        .chunks_exact(12)
        .map(|s| Station {
            p: read(s, 0),
            t: read(s, 3),
            n: [read(s, 6), read(s, 9)],
        })
        .collect();
    found
        .iter()
        .all(|s| unit(s.t).is_some() && unit(s.n[0]).is_some() && unit(s.n[1]).is_some())
        .then_some(found)
}

/// Each point's signed distance to face `face`'s surface along its outward normal: above 0 in the air outside it.
fn distances(shape: &mut Shape, face: c_int, points: &[V3]) -> Option<Vec<f64>> {
    let flat: Vec<f64> = points.iter().flatten().copied().collect();
    let mut out = vec![0.0f64; points.len()];
    // SAFETY: `shape` is held for this call; the kernel reads three numbers per point and writes one.
    let ok = unsafe {
        lime_tree_face_distances(
            shape.0.as_ptr(),
            face,
            flat.as_ptr(),
            points.len() as c_int,
            out.as_mut_ptr(),
        )
    };
    (ok != 0 && out.iter().all(|v| v.is_finite())).then_some(out)
}

/// The faces at either end of edge `edge`, which a tool grown into a wall at that end may change.
fn end_faces(shape: &mut Shape, edge: c_int) -> Vec<c_int> {
    let mut out = vec![0 as c_int; 64];
    // SAFETY: `shape` is held for this call; the kernel writes at most 64 ints.
    let count = unsafe { lime_tree_edge_end_faces(shape.0.as_ptr(), edge, out.as_mut_ptr(), 64) };
    out.truncate(count.max(0) as usize);
    out
}

/// Whether `point` lies inside the solid.
fn inside(shape: &mut Shape, point: V3) -> bool {
    // SAFETY: `shape` is held for this call; the kernel reads three numbers.
    unsafe { lime_tree_inside(shape.0.as_ptr(), point.as_ptr()) == 1 }
}

/// One picked edge, read: convex or concave, between two faces; straight or curved, the faces flat or curved. A flat face
/// or a straight edge a STEP file stores as a B-spline reads as flat or straight.
struct EdgeRead {
    index: c_int,
    length: f64,
    mid: V3,
    /// The edge's unit direction, at its middle on a curved edge.
    e: V3,
    faces: [c_int; 2],
    normals: [V3; 2],
    convex: bool,
    /// A line between two planes as stored: the chamfer and the step 2 prism are exact on it.
    exact: bool,
    straight: bool,
    flat: bool,
    stations: Vec<Station>,
}

impl EdgeRead {
    /// The edge's start: its middle less half its length along `e`.
    fn start(&self) -> V3 {
        add(self.mid, scale(self.e, -0.5 * self.length))
    }

    /// Into face `n` from the edge: square to the edge, in the face. At a concave edge that is toward the air side of
    /// the other face, at a convex one away from it.
    fn into(&self, n: V3, other: V3) -> Option<V3> {
        let u = cross(self.e, n);
        let toward = dot(u, other) >= 0.0;
        unit(if toward != self.convex {
            u
        } else {
            scale(u, -1.0)
        })
    }
}

fn read_edge(
    from: &mut Shape,
    index: c_int,
    b: V3,
    angle: f64,
    which: &dyn Fn(String) -> String,
) -> Result<EdgeRead, BuildFail> {
    let edge = from
        .edge(index)
        .ok_or_else(|| refuse(which("That edge is not on this solid.".into())))?;
    if edge.length_mm < MIN_EDGE_MM {
        return Err(refuse(which(format!(
            "This edge is {:.2} mm long, under the {MIN_EDGE_MM} mm a print transition needs.",
            edge.length_mm
        ))));
    }
    let (sig, faces) = from.edge_sig_flat(index).ok_or_else(|| {
        refuse(which(
            "Open CASCADE could not read this edge's faces.".into(),
        ))
    })?;
    if faces[0] < 0 || faces[1] < 0 || sig.kinds.contains(&9) {
        return Err(refuse(which(
            "This edge is not between two faces: a seam or an open boundary has no corner to fill."
                .into(),
        )));
    }
    let convex = match from.edge_kinds(&[index]).map_err(refuse)?.first() {
        Some(2) => false,
        Some(1) => true,
        _ => {
            return Err(refuse(which(
                "The faces at this edge meet with no corner, so there is nothing to fill.".into(),
            )))
        }
    };
    let exact = from
        .edge_sig(index)
        .is_some_and(|(raw, _)| raw.curve == 0 && raw.kinds == [0, 0]);
    let straight = sig.curve == 0;
    let flat = sig.kinds == [0, 0];
    let read = stations(
        from,
        index,
        faces,
        station_count(edge.length_mm, straight && flat),
    )
    .ok_or_else(|| refuse(which("Open CASCADE could not read along this edge.".into())))?;
    let e = if straight {
        unit(sig.dir)
    } else {
        unit(read[read.len() / 2].t)
    }
    .ok_or_else(|| {
        refuse(which(
            "Open CASCADE could not read this edge's direction.".into(),
        ))
    })?;
    // The steepest any face through the edge can lie: when even that is at least the angle asked, every face holds. A
    // curved edge is refused when that holds all along it.
    let climbs = |t: V3| {
        let across = (1.0 - dot(t, b).powi(2)).max(0.0).sqrt();
        deg(across.clamp(-1.0, 1.0).acos()) >= angle - 1e-6
    };
    if climbs(e) && read.iter().all(|s| climbs(s.t)) {
        return Err(refuse(which(format!(
            "This edge already grows at least {angle}° to the layers, so every face through it holds its own rows."
        ))));
    }
    Ok(EdgeRead {
        index,
        length: edge.length_mm,
        mid: edge.mid,
        e,
        faces,
        normals: sig.normals,
        convex,
        exact,
        straight,
        flat,
        stations: read,
    })
}

/// One corner, worked out on the solid it is built from.
struct Corner {
    edge: c_int,
    far: c_int,
    near: c_int,
    /// The new face's outward normal.
    normal: V3,
    far_deg: f64,
    near_deg: f64,
    /// The new face's angle from the far face, which the chamfer takes.
    from_far_deg: f64,
    /// Along the far face and up the near face, from the edge.
    reach: f64,
    near_reach: f64,
    far_end: f64,
    near_end: f64,
    /// The wedge's section corners: on the edge's start, then on the far face, then on the near face.
    section: [V3; 3],
    along: V3,
    volume: f64,
}

/// The far (flatter, facing more down the build) and near faces: index, outward normal.
fn far_near(read: &EdgeRead, b: V3) -> ((c_int, V3), (c_int, V3)) {
    let down = scale(b, -1.0);
    let [a, c] = read.normals;
    if dot(a, down) >= dot(c, down) {
        ((read.faces[0], a), (read.faces[1], c))
    } else {
        ((read.faces[1], c), (read.faces[0], a))
    }
}

/// The new face's outward normal in a corner, and its turn from the far face: it turns from the far face's normal toward
/// the near face's, about the edge, until it makes `angle` with the layers. At the far end it is too flat, at the near
/// end steep enough, so the turn is bisected.
fn wedge_normal(n_far: V3, n_near: V3, b: V3, angle: f64) -> Option<(V3, f64)> {
    let down = scale(b, -1.0);
    let theta = dot(n_far, n_near).clamp(-1.0, 1.0).acos();
    let turn = |t: f64| -> V3 {
        let s = theta.sin();
        add(
            scale(n_far, ((1.0 - t) * theta).sin() / s),
            scale(n_near, (t * theta).sin() / s),
        )
    };
    let target = angle.to_radians().cos();
    let (mut lo, mut hi) = (0.0f64, 1.0f64);
    for _ in 0..64 {
        let mid = 0.5 * (lo + hi);
        if dot(turn(mid), down) > target {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    let t = 0.5 * (lo + hi);
    unit(turn(t)).map(|normal| (normal, t * theta))
}

/// Into a concave corner's face with outward normal `n` from an edge along `e`: square to the edge, in the face, toward
/// the air side of the other face.
fn into_corner(e: V3, n: V3, other: V3) -> Option<V3> {
    let u = cross(e, n);
    unit(if dot(u, other) >= 0.0 {
        u
    } else {
        scale(u, -1.0)
    })
}

/// A wedge pushed along a straight edge or swept along a curved one, before it is fused: one per picked corner on the
/// path for curved edges and faces, chains and walls (plan section 4).
struct ToolPlan {
    edge: c_int,
    straight: bool,
    /// At the edge's first vertex as Open CASCADE orients it: sunk into the faces, then the new face's two corners.
    section: Vec<V3>,
    ext: [f64; 2],
    /// Per end: the point and the side of the mitre plane kept.
    mitre: [Option<(V3, V3)>; 2],
    /// Per end: the edge's end point, the direction the edge arrives at it in, and the wedge's middle from there.
    ends: [(V3, V3, V3); 2],
    /// How far the wedge reaches from its edge.
    size: f64,
    /// The new face's angle to the layers, least and most along the edge.
    angles: (f64, f64),
    /// The triangle's own volume, without its sunk sides.
    volume: f64,
    /// For the ghost: the triangle at each station.
    rings: Vec<[V3; 3]>,
}

/// Transport from station 0 to station `i`: a straight edge's prism moves its section along the edge; a sweep turns it
/// with the frame whose binormal stays `b` (tangent, `b` × tangent, then their cross).
fn transport(read: &EdgeRead, b: V3, i: usize) -> Option<impl Fn(V3) -> V3> {
    let s0 = read.stations[0];
    let si = read.stations[i];
    let frame = |t: V3| -> Option<[V3; 3]> {
        let t = unit(t)?;
        let n = unit(cross(b, t))?;
        Some([t, n, cross(t, n)])
    };
    let (f0, fi) = if read.straight {
        let id = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];
        (id, id)
    } else {
        (frame(s0.t)?, frame(si.t)?)
    };
    Some(move |q: V3| {
        let d = sub(q, s0.p);
        let local = [dot(d, f0[0]), dot(d, f0[1]), dot(d, f0[2])];
        add(
            si.p,
            add(
                add(scale(fi[0], local[0]), scale(fi[1], local[1])),
                scale(fi[2], local[2]),
            ),
        )
    })
}

/// The tool for `corner`, its section read at the edge's first station and checked at every one: the steeper face must
/// hold all along, the new face must keep the angle asked within 1°, and the faces may curve away from the section by
/// no more than a quarter of its smaller reach, which the section's sides then sink past.
fn corner_tool(
    from: &mut Shape,
    read: &EdgeRead,
    c: &Corner,
    b: V3,
    angle: f64,
    which: &dyn Fn(String) -> String,
) -> Result<ToolPlan, BuildFail> {
    let (fi, ni) = if c.far == read.faces[0] {
        (0, 1)
    } else {
        (1, 0)
    };
    let st = &read.stations;
    let s0 = st[0];
    let t0 = unit(s0.t)
        .ok_or_else(|| refuse(which("Open CASCADE could not read along this edge.".into())))?;
    let (n_far, n_near) = (s0.n[fi], s0.n[ni]);
    let lost = || {
        refuse(which(
            "This corner has no wedge at that angle where the edge starts.".into(),
        ))
    };
    let (normal, from_far) = wedge_normal(n_far, n_near, b, angle).ok_or_else(lost)?;
    let u_far = into_corner(t0, n_far, n_near).ok_or_else(lost)?;
    let u_near = into_corner(t0, n_near, n_far).ok_or_else(lost)?;
    let gap = dot(u_far, u_near).clamp(-1.0, 1.0).acos();
    let reach = c.reach;
    let near_reach = reach * from_far.sin() / (gap + from_far).sin();
    if !(near_reach.is_finite() && near_reach > 0.0) {
        return Err(lost());
    }
    let p0 = s0.p;
    let p1 = add(p0, scale(u_far, reach));
    let p2 = add(p0, scale(u_near, near_reach));
    // Every station: the steeper face's angle, the new face's, and the points of the section's two sides.
    let mut least_near = f64::INFINITY;
    let mut angles = (f64::INFINITY, f64::NEG_INFINITY);
    let mut far_points = Vec::new();
    let mut near_points = Vec::new();
    let mut rings = Vec::with_capacity(st.len());
    for (i, station) in st.iter().enumerate() {
        let moved = transport(read, b, i)
            .ok_or_else(|| refuse(which("This edge runs along the build somewhere, so no wedge holds one lean to the layers along it.".into())))?;
        least_near = least_near.min(to_layers(station.n[ni], b));
        let at = moved(add(p0, normal));
        let n_i = unit(sub(at, moved(p0))).unwrap_or(normal);
        let a = to_layers(n_i, b);
        angles = (angles.0.min(a), angles.1.max(a));
        for k in 1..=4 {
            let f = k as f64 / 4.0;
            far_points.push(moved(add(p0, scale(u_far, f * reach))));
            near_points.push(moved(add(p0, scale(u_near, f * near_reach))));
        }
        rings.push([moved(p0), moved(p1), moved(p2)]);
    }
    if least_near < angle - 0.5 {
        return Err(refuse(which(format!(
            "Along this edge the steeper face turns to {least_near:.1}° to the layers, flatter than the {angle}° asked, so the wedge would start in the air there."
        ))));
    }
    if angles.0 < angle - ANGLE_CHECK_DEG || angles.1 > angle + ANGLE_CHECK_DEG {
        return Err(refuse(which(format!(
            "Along this edge the wedge's face would range from {:.1}° to {:.1}° to the layers, more than {ANGLE_CHECK_DEG}° off the {angle}° asked: the edge climbs through the layers as it turns. A shorter run of it holds the angle.",
            angles.0, angles.1
        ))));
    }
    let gap_of = |from: &mut Shape, face: c_int, points: &[V3]| -> Result<f64, BuildFail> {
        distances(from, face, points)
            .map(|d| d.into_iter().fold(0.0f64, f64::max))
            .ok_or_else(|| {
                refuse(which(
                    "Open CASCADE could not measure this corner's faces along the edge.".into(),
                ))
            })
    };
    let gap_far = gap_of(from, c.far, &far_points)?;
    let gap_near = gap_of(from, c.near, &near_points)?;
    let most = GAP_SHARE * reach.min(near_reach);
    if gap_far.max(gap_near) > most {
        return Err(refuse(which(format!(
            "The faces curve away from this wedge by up to {:.2} mm along the edge, more than a quarter of its {:.2} mm reach, so it would stand off them. A smaller size, or a shorter run of the edge, keeps it on them.",
            gap_far.max(gap_near),
            reach.min(near_reach)
        ))));
    }
    let (sink_far, sink_near) = (gap_far + SINK_MM, gap_near + SINK_MM);
    let section = vec![
        sub(p0, add(scale(n_far, sink_far), scale(n_near, sink_near))),
        sub(p1, scale(n_far, sink_far)),
        p1,
        p2,
        sub(p2, scale(n_near, sink_near)),
    ];
    let last = st.len() - 1;
    let end_move = transport(read, b, last).ok_or_else(lost)?;
    let middle = scale(add(add(p0, p1), p2), 1.0 / 3.0);
    let ends = [
        (p0, scale(t0, -1.0), sub(middle, p0)),
        (
            st[last].p,
            unit(st[last].t).unwrap_or(t0),
            sub(end_move(middle), st[last].p),
        ),
    ];
    Ok(ToolPlan {
        edge: read.index,
        straight: read.straight,
        section,
        ext: [0.0; 2],
        mitre: [None, None],
        ends,
        size: reach.max(near_reach) + sink_far.max(sink_near),
        angles,
        volume: 0.5 * reach * near_reach * gap.sin() * read.length,
        rings,
    })
}

/// Where two picked edges meet at an angle, each wedge runs past the shared point and is cut on the plane that bisects
/// the turn, so they meet with no notch and no spike. Where an end meets a wall, the wedge runs into it by its own size
/// and the boolean merges it there; at an end in the open air it stops flush (plan section 4).
fn join_ends(from: &mut Shape, plans: &mut [ToolPlan]) {
    let tight = MITRE_DEG.to_radians().cos();
    for i in 0..plans.len() {
        for end in 0..2 {
            let (at, arrive, middle) = plans[i].ends[end];
            let mut met = false;
            for j in 0..plans.len() {
                if j == i {
                    continue;
                }
                for other in 0..2 {
                    let (there, arrive_j, _) = plans[j].ends[other];
                    if length(sub(there, at)) > 1e-4 {
                        continue;
                    }
                    met = true;
                    // Straight on, or nearly: the two sections meet flush.
                    if dot(arrive, scale(arrive_j, -1.0)) >= tight {
                        continue;
                    }
                    if let Some(m) = unit(sub(arrive, arrive_j)) {
                        plans[i].ext[end] = 2.0 * plans[i].size.max(plans[j].size);
                        plans[i].mitre[end] = Some((at, scale(m, -1.0)));
                    }
                }
            }
            if met {
                continue;
            }
            let step = (0.1 * plans[i].size).clamp(0.05, 0.5);
            if inside(from, add(add(at, middle), scale(arrive, step))) {
                plans[i].ext[end] = plans[i].size;
            }
        }
    }
}

/// The triangles of a wedge drawn through its section at each station, for the card's ghost.
fn ring_soup(rings: &[[V3; 3]]) -> Vec<f64> {
    let mut out = Vec::with_capacity(18 * 3 * rings.len() + 18);
    let mut tri = |points: [V3; 3]| {
        for p in points {
            out.extend(p.map(round6));
        }
    };
    if let (Some(first), Some(last)) = (rings.first(), rings.last()) {
        tri([first[0], first[2], first[1]]);
        tri([last[0], last[1], last[2]]);
    }
    for pair in rings.windows(2) {
        let [a0, a1, a2] = pair[0];
        let [b0, b1, b2] = pair[1];
        for (p, q, r, s) in [(a0, a1, b1, b0), (a1, a2, b2, b1), (a2, a0, b0, b2)] {
            tri([p, q, r]);
            tri([p, r, s]);
        }
    }
    out
}

/// The corners' tools fused on in one boolean, then checked: the boolean may change only the corners' own faces and the
/// faces at their edges' ends (walls, and the other edge where two meet), and it adds no more than the tools hold. On
/// straight edges between flat faces meeting nothing, it must add the wedges' own volume within 1 %, as step 2 checks.
fn sweep_corners(
    from: &mut Shape,
    corners: &[&Corner],
    plans: &[ToolPlan],
    reads: &[&EdgeRead],
    b: V3,
    angle: f64,
) -> Result<(Shape, Vec<Vec<f64>>), BuildFail> {
    let edges: Vec<c_int> = plans.iter().map(|p| p.edge).collect();
    let straight: Vec<c_int> = plans.iter().map(|p| c_int::from(p.straight)).collect();
    let counts: Vec<c_int> = plans.iter().map(|p| p.section.len() as c_int).collect();
    let sections: Vec<f64> = plans
        .iter()
        .flat_map(|p| p.section.iter().flatten().copied())
        .collect();
    let ext: Vec<f64> = plans.iter().flat_map(|p| p.ext).collect();
    let mitres: Vec<f64> = plans
        .iter()
        .flat_map(|p| {
            p.mitre.iter().flat_map(|m| match m {
                Some((at, keep)) => [1.0, at[0], at[1], at[2], keep[0], keep[1], keep[2]],
                None => [0.0; 7],
            })
        })
        .collect();
    let faces = from.fingerprint().faces.max(0) as usize;
    let mut touched = vec![0 as c_int; faces];
    let mut out = [0.0f64; 1];
    let mut tools: *mut RawShape = std::ptr::null_mut();
    // SAFETY: `from` is held for this call; the kernel reads the arrays as its comment says, writes one flag per face of
    // `from`, one number, and the tools as a new shape.
    let made = Shape::made(|error| unsafe {
        lime_tree_transition_tools(
            from.raw(),
            plans.len() as c_int,
            edges.as_ptr(),
            straight.as_ptr(),
            counts.as_ptr(),
            sections.as_ptr(),
            ext.as_ptr(),
            mitres.as_ptr(),
            b.as_ptr(),
            0,
            touched.as_mut_ptr(),
            out.as_mut_ptr(),
            &mut tools,
            error,
        )
    });
    let _tools = std::ptr::NonNull::new(tools).map(Shape);
    let mut made = made.map_err(refuse)?;
    let mut allowed: Vec<c_int> = corners.iter().flat_map(|c| [c.far, c.near]).collect();
    for p in plans {
        allowed.extend(end_faces(from, p.edge));
    }
    let others: Vec<c_int> = touched
        .iter()
        .enumerate()
        .filter(|(index, &flag)| flag != 0 && !allowed.contains(&(*index as c_int)))
        .map(|(index, _)| index as c_int)
        .collect();
    if let Some(&face) = others.first() {
        let more = if others.len() > 1 {
            format!(" and {} more", others.len() - 1)
        } else {
            String::new()
        };
        return Err(refuse(format!(
            "The wedge would run into another part of the solid: it meets face {face}{more}, beyond the corner's own faces and the walls at its ends. Use a smaller size, or an edge with nothing else between its faces."
        )));
    }
    let added = made.fingerprint().volume_mm3 - from.fingerprint().volume_mm3;
    let expected: f64 = plans.iter().map(|p| p.volume).sum();
    let tools_volume = out[0];
    let plain = reads.iter().all(|r| r.straight && r.flat)
        && plans
            .iter()
            .all(|p| p.ext.iter().all(|&x| x == 0.0) && p.mitre.iter().all(Option::is_none));
    let off = if plain {
        (added - expected).abs() > 0.01 * expected + 0.05
    } else {
        added < 0.5 * expected || added > tools_volume + 0.05
    };
    if off {
        return Err(refuse(format!(
            "The wedge would run into another part of the solid: it adds {added:.1} mm³ where the wedge alone is {expected:.1} mm³. Use a smaller size, or an edge with nothing else between its faces."
        )));
    }
    for (c, read) in corners.iter().zip(reads) {
        if read.straight && !has_face(&mut made, c.normal) {
            return Err(refuse(format!(
                "Open CASCADE built the wedge's face off the {angle}° asked, so it was not kept."
            )));
        }
    }
    let soups = plans.iter().map(|p| ring_soup(&p.rings)).collect();
    Ok((made, soups))
}

fn corner(
    from: &mut Shape,
    read: &EdgeRead,
    b: V3,
    angle: f64,
    size: TransitionSize,
    max_mm: f64,
    which: &dyn Fn(String) -> String,
) -> Result<Corner, BuildFail> {
    let e = read.e;
    let ((far, n_far), (near, n_near)) = far_near(read, b);
    let far_deg = to_layers(n_far, b);
    let near_deg = to_layers(n_near, b);
    if far_deg >= 90.0 {
        return Err(refuse(which(
            "Both faces at this edge look up the build, so nothing here hangs.".into(),
        )));
    }
    if far_deg >= angle - 0.05 {
        return Err(refuse(which(format!(
            "The flatter face here already grows at {far_deg:.1}° to the layers, as steep as the {angle}° asked, so a wedge adds nothing. A steeper angle makes one."
        ))));
    }
    if near_deg < angle - 0.05 {
        return Err(refuse(which(format!(
            "Both faces here grow flatter than {angle}° to the layers (the steeper at {near_deg:.1}°), so a wedge would itself start in the air. That is a lip: the Lip case puts a gusset under the flatter face, back into the part."
        ))));
    }
    // A steeper face at the angle asked would be the new face itself: the wedge would run along it with no end.
    if near_deg < angle + 0.05 {
        return Err(refuse(which(format!(
            "The steeper face here grows at {near_deg:.1}° to the layers, the {angle}° asked, so a wedge at that angle would run along it. A steeper angle makes one."
        ))));
    }
    let (normal, from_far) = wedge_normal(n_far, n_near, b, angle)
        .ok_or_else(|| refuse(which("This corner has no wedge at that angle.".into())))?;
    let (u_far, u_near) = match (read.into(n_far, n_near), read.into(n_near, n_far)) {
        (Some(f), Some(n)) => (f, n),
        _ => {
            return Err(refuse(which(
                "Open CASCADE could not read this corner's faces.".into(),
            )))
        }
    };
    let gap = dot(u_far, u_near).clamp(-1.0, 1.0).acos();
    let start = read.start();
    let far_end = span(from, far, read.mid, u_far)
        .ok_or_else(|| {
            refuse(which(
                "Open CASCADE could not measure the flatter face.".into(),
            ))
        })?
        .1;
    let near_end = span(from, near, read.mid, u_near)
        .ok_or_else(|| {
            refuse(which(
                "Open CASCADE could not measure the steeper face.".into(),
            ))
        })?
        .1;
    let reach = match size {
        TransitionSize::Mm(mm) if mm.is_finite() && mm > 0.0 => mm,
        TransitionSize::Mm(_) => {
            return Err(refuse(
                "A print transition's size must be above 0 mm, or \"face\".",
            ))
        }
        TransitionSize::Word(SizeWord::Face) => far_end,
    };
    let near_reach = reach * from_far.sin() / (gap + from_far).sin();
    if reach > far_end + 1e-3 {
        return Err(refuse(which(format!(
            "A {reach:.1} mm wedge runs past the end of the flatter face, {far_end:.1} mm from the edge. Use size \"face\" to fill it to its end, or a smaller size."
        ))));
    }
    if near_reach > near_end + 1e-3 {
        return Err(refuse(which(format!(
            "This wedge would climb {near_reach:.1} mm up the steeper face, which ends {near_end:.1} mm from the edge. Use a smaller size."
        ))));
    }
    if reach.max(near_reach) > max_mm + 1e-9 {
        return Err(refuse(which(format!(
            "This wedge would reach {:.1} mm from the edge, past the {max_mm} mm limit. Supports or a split are the way here, or a larger maxMm.",
            reach.max(near_reach)
        ))));
    }
    let along = scale(e, read.length);
    Ok(Corner {
        edge: read.index,
        far,
        near,
        normal,
        far_deg,
        near_deg,
        from_far_deg: deg(from_far),
        reach,
        near_reach,
        far_end,
        near_end,
        section: [
            start,
            add(start, scale(u_far, reach)),
            add(start, scale(u_near, near_reach)),
        ],
        along,
        volume: 0.5 * reach * near_reach * gap.sin() * read.length,
    })
}

/// One lip, worked out on the solid it is built from.
struct Lip {
    /// The edge picked: the lip's first edge, or its root when picked there.
    edge: c_int,
    /// The lip's first edge, the lowest along the build.
    first: c_int,
    under: c_int,
    front: c_int,
    under_deg: f64,
    front_deg: f64,
    /// The new face's outward normal: the gusset's underside, or the ramp, which lean the same way.
    normal: V3,
    start: V3,
    mid: V3,
    along: V3,
    u_under: V3,
    u_front: V3,
    /// Down the gusset's face from the edge, square to it.
    down_face: V3,
    /// Square to the edge: toward the part in the layers, and up the build.
    toward: V3,
    up: V3,
    /// The new face's lean from the layers in the plane square to the edge.
    lean: f64,
    /// How far the underside reaches from the first edge, and the other face up from it.
    depth: f64,
    front_end: f64,
}

fn lip(
    from: &mut Shape,
    read: &EdgeRead,
    picked: c_int,
    b: V3,
    angle: f64,
    which: &dyn Fn(String) -> String,
) -> Result<Lip, BuildFail> {
    let ((under, n_under), (front, n_front)) = far_near(read, b);
    let (u_under, u_front) = match (read.into(n_under, n_front), read.into(n_front, n_under)) {
        (Some(u), Some(f)) => (u, f),
        _ => {
            return Err(refuse(which(
                "Open CASCADE could not read this lip's faces.".into(),
            )))
        }
    };
    if dot(u_under, b) < -1e-6 || dot(u_front, b) < -1e-6 {
        return Err(refuse(which(
            "This edge is convex, and a face at it goes on down the build past it, so no lip starts here. A lip's first edge is the lowest point of both its faces; a corner wedge goes in a concave edge."
                .into(),
        )));
    }
    let under_deg = to_layers(n_under, b);
    let front_deg = to_layers(n_front, b);
    if under_deg >= angle - 0.05 {
        return Err(refuse(which(format!(
            "This lip's underside already grows at {under_deg:.1}° to the layers, as steep as the {angle}° asked, so its rows hold and nothing here hangs."
        ))));
    }
    let e = read.e;
    let up = unit(sub(b, scale(e, dot(b, e))))
        .ok_or_else(|| refuse(which("This edge runs along the build.".into())))?;
    let toward = unit(sub(u_under, scale(up, dot(u_under, up)))).ok_or_else(|| {
        refuse(which(
            "This lip's underside stands square to the layers.".into(),
        ))
    })?;
    let across = (1.0 - dot(e, b).powi(2)).max(0.0).sqrt();
    let lean = (angle.to_radians().cos() / across).clamp(-1.0, 1.0).acos();
    let normal = scale(add(scale(toward, lean.sin()), scale(up, lean.cos())), -1.0);
    let down_face = sub(scale(toward, lean.cos()), scale(up, lean.sin()));
    let start = read.start();
    let depth = span(from, under, start, u_under)
        .ok_or_else(|| {
            refuse(which(
                "Open CASCADE could not measure the lip's underside.".into(),
            ))
        })?
        .1;
    let front_end = span(from, front, start, u_front)
        .ok_or_else(|| {
            refuse(which(
                "Open CASCADE could not measure the lip's front face.".into(),
            ))
        })?
        .1;
    Ok(Lip {
        edge: picked,
        first: read.index,
        under,
        front,
        under_deg,
        front_deg,
        normal,
        start,
        mid: read.mid,
        along: scale(e, read.length),
        u_under,
        u_front,
        down_face,
        toward,
        up,
        lean,
        depth,
        front_end,
    })
}

/// A concave edge given the Lip case is a lip's root: the lip's first edge is its flatter face's far edge, straight and
/// along this one.
fn lip_from_root(
    from: &mut Shape,
    read: &EdgeRead,
    b: V3,
    angle: f64,
    which: &dyn Fn(String) -> String,
) -> Result<Lip, BuildFail> {
    let ((far, n_far), (_, n_near)) = far_near(read, b);
    let not_found = || {
        refuse(which(
            "This concave edge has no lip on it: its flatter face does not end in a straight edge along this one. Pick the lip's first edge, its lowest, instead."
                .into(),
        ))
    };
    let u_far = read.into(n_far, n_near).ok_or_else(not_found)?;
    let start = read.start();
    let far_end = span(from, far, start, u_far).ok_or_else(not_found)?.1;
    let count = from.fingerprint().edges;
    let tight = 0.5f64.to_radians().cos();
    let first = (0..count)
        .filter(|&index| index != read.index)
        .find(|&index| {
            let Some((sig, faces)) = from.edge_sig_flat(index) else {
                return false;
            };
            if sig.curve != 0 || !faces.contains(&far) {
                return false;
            }
            let along = unit(sig.dir).map_or(0.0, |d| dot(d, read.e).abs());
            along >= tight
                && from.edge(index).is_some_and(|edge| {
                    (dot(sub(edge.mid, start), u_far) - far_end).abs() < 1e-3 + 1e-4 * far_end
                })
        })
        .ok_or_else(not_found)?;
    let first_read = read_edge(from, first, b, angle, &|text| {
        which(format!("The lip's first edge: {text}"))
    })?;
    if !first_read.convex {
        return Err(not_found());
    }
    lip(from, &first_read, read.index, b, angle, which)
}

enum Found {
    Corner(Corner),
    Lip(Lip),
}

/// What a lip's gusset or ramp came to, once built.
struct LipMade {
    volume: f64,
    height: f64,
    landing: f64,
    left: Option<f64>,
    near_reach: f64,
    soup: Vec<f64>,
}

/// Whether one of the edges the last op made borders a face whose outward normal is `normal`, within the check angle.
fn has_face(kept: &mut Shape, normal: V3) -> bool {
    let tight = ANGLE_CHECK_DEG.to_radians().cos();
    kept.created_indexes()
        .into_iter()
        .filter_map(|index| kept.edge_sig(index).map(|(sig, _)| sig.normals))
        .flatten()
        .any(|n| dot(n, normal) >= tight)
}

/// The triangles of `shape`'s faces, as positions, three per corner, rounded to 0.1 µm.
fn soup(shape: &mut Shape) -> Vec<f64> {
    let mut view = MeshView {
        positions: std::ptr::null(),
        positions_bytes: 0,
        triangles: std::ptr::null(),
        triangles_bytes: 0,
        edge_points: std::ptr::null(),
        edge_points_bytes: 0,
        edge_offsets: std::ptr::null(),
        edge_offsets_bytes: 0,
        meta: std::ptr::null(),
    };
    let mut error: *mut c_char = std::ptr::null_mut();
    // SAFETY: `shape` is held for this call; the kernel fills `view` with the mesh's own arrays.
    let raw = unsafe { lime_tree_mesh(shape.0.as_ptr(), 0.05, &mut view, &mut error) };
    let _ = take_text(error);
    let Some(mesh) = NonNull::new(raw).map(Mesh) else {
        return Vec::new();
    };
    // SAFETY: `lime_tree_mesh` filled `view` with `mesh`'s own arrays, which live until it drops. The positions are a
    // triangle soup already, nine floats per triangle.
    let positions = unsafe { mesh.bytes(view.positions, view.positions_bytes) };
    positions
        .chunks_exact(4)
        .map(|b| (f32::from_le_bytes([b[0], b[1], b[2], b[3]]) as f64 * 1e4).round() / 1e4)
        .collect()
}

/// A triangular prism's triangles: `section` pushed along `along`.
fn prism_soup(section: [V3; 3], along: V3) -> Vec<f64> {
    let [a0, a1, a2] = section;
    let [b0, b1, b2] = section.map(|p| add(p, along));
    let mut out = Vec::with_capacity(72);
    let mut tri = |points: [V3; 3]| {
        for p in points {
            out.extend(p.map(round6));
        }
    };
    tri([a0, a2, a1]);
    tri([b0, b1, b2]);
    for (p, q, r, s) in [(a0, a1, b1, b0), (a1, a2, b2, b1), (a2, a0, b0, b2)] {
        tri([p, q, r]);
        tri([p, r, s]);
    }
    out
}

/// The gusset under `lip`, built against `onto`, fused on. Refused when it does not land on the part within `max_mm`.
fn gusset(
    from: &Shape,
    onto: &Shape,
    lip: &Lip,
    b: V3,
    max_mm: f64,
    which: &dyn Fn(String) -> String,
) -> Result<(Shape, LipMade), BuildFail> {
    let keep = scale(lip.normal, -1.0);
    let step = (0.25 * lip.depth).min(0.05);
    let inside = unit(add(lip.u_under, lip.down_face))
        .map(|d| add(lip.mid, scale(d, step)))
        .ok_or_else(|| refuse(which("This lip has no room under it.".into())))?;
    let mut out = [0.0f64; 6];
    // SAFETY: both shapes are held for this call; the kernel reads three numbers from each point and writes six.
    let mut piece = Shape::made(|error| unsafe {
        lime_tree_lip_gusset(
            from.raw(),
            onto.raw(),
            lip.under,
            lip.start.as_ptr(),
            keep.as_ptr(),
            b.as_ptr(),
            max_mm,
            inside.as_ptr(),
            out.as_mut_ptr(),
            error,
        )
    })
    .map_err(|message| refuse(which(format!("{message}."))))?;
    let height = -out[1];
    if out[2] != 1.0 || height >= max_mm - 1e-6 {
        return Err(refuse(which(format!(
            "There is nothing of the part under this lip within {max_mm} mm along the build, so a gusset would itself start in the air. Supports or a split are the way here, or a larger maxMm."
        ))));
    }
    // How far from the edge the gusset lands: its lowest point, square to the edge.
    let low = sub([out[3], out[4], out[5]], lip.start);
    let e = unit(lip.along).unwrap_or([0.0; 3]);
    let landing = length(sub(low, scale(e, dot(low, e))));
    let volume = out[0];
    let place: [f64; 12] = [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0];
    // SAFETY: both shapes are held for this call; the kernel reads 12 numbers from `place` and a C string.
    let mut fused = Shape::made(|error| unsafe {
        lime_tree_join(
            onto.raw(),
            piece.raw(),
            c"fuse".as_ptr(),
            place.as_ptr(),
            error,
        )
    })
    .map_err(|message| refuse(which(format!("{message}."))))?;
    let added = fused.fingerprint().volume_mm3 - onto.fingerprint().volume_mm3;
    if (added - volume).abs() > 0.01 * volume + 0.05 {
        return Err(refuse(which(format!(
            "The gusset would run into another part of the solid: it adds {added:.1} mm³ where the gusset alone is {volume:.1} mm³."
        ))));
    }
    if !has_face(&mut fused, lip.normal) {
        return Err(refuse(which(
            "Open CASCADE built the gusset's face off the angle asked, so it was not kept.".into(),
        )));
    }
    let soup = soup(&mut piece);
    Ok((
        fused,
        LipMade {
            volume,
            height,
            landing,
            left: None,
            near_reach: 0.0,
            soup,
        },
    ))
}

/// The ramp `cut` turns `lip`'s underside into: its section, from the first edge's start, the root, and where it meets
/// the first edge's other face; and how much that face keeps above it.
fn ramp(
    lip: &Lip,
    angle: f64,
    floor_mm: f64,
    which: &dyn Fn(String) -> String,
) -> Result<([V3; 3], f64, f64), BuildFail> {
    let flat = |p: V3| (dot(p, lip.toward), dot(p, lip.up));
    let root = scale(lip.u_under, lip.depth);
    let (rh, rz) = flat(root);
    // From the root back toward the first edge, rising at the asked angle.
    let (dh, dz) = (-lip.lean.cos(), lip.lean.sin());
    let (fh, fz) = flat(lip.u_front);
    let det = -dh * fz + fh * dz;
    if det.abs() < 1e-9 {
        return Err(refuse(which(
            "This lip's front face runs along the ramp, so a ramp cannot end on it.".into(),
        )));
    }
    let up_front = (-dh * rz + dz * rh) / det;
    let left = lip.front_end - up_front;
    if left < floor_mm - 1e-9 {
        let what = if left <= 0.0 {
            format!("would cut through this lip: it needs {up_front:.2} mm of its first edge's face, which is {:.2} mm", lip.front_end)
        } else {
            format!("would leave {left:.2} mm at this lip's first edge, under the {floor_mm} mm wall floor (twice the nozzle)")
        };
        return Err(refuse(which(format!(
            "A ramp at {angle}° from the lip's root {what}. A gusset (mode add) keeps the lip whole."
        ))));
    }
    Ok((
        [
            lip.start,
            add(lip.start, root),
            add(lip.start, scale(lip.u_front, up_front)),
        ],
        up_front,
        left,
    ))
}

/// The wedges, gussets and ramps for every edge of `op`, checked on the built solid: the volume each adds or removes is
/// its own, so it touched nothing else, and each new face lies at the angle asked.
pub(super) fn build(from: &mut Shape, op: Op, picks: &[c_int]) -> Result<Built, BuildFail> {
    let Op::Transition {
        build,
        angle_deg,
        size,
        max_mm,
        mode,
        case,
        floor_mm,
        ..
    } = &op
    else {
        unreachable!("matched a transition");
    };
    if !(angle_deg.is_finite() && *angle_deg > 0.0 && *angle_deg <= 85.0) {
        return Err(refuse(
            "The angle to the layers must be above 0° and at most 85°.",
        ));
    }
    let b =
        unit(*build).ok_or_else(|| refuse("The build direction must be a direction, not zero."))?;
    let max_mm = max_mm.unwrap_or(DEFAULT_MAX_MM);
    if !(max_mm.is_finite() && max_mm > 0.0) {
        return Err(refuse("maxMm must be above 0 mm."));
    }
    let floor = floor_mm.unwrap_or(DEFAULT_FLOOR_MM);
    if !(floor.is_finite() && floor > 0.0) {
        return Err(refuse("floorMm must be above 0 mm."));
    }
    if picks.is_empty() {
        return Err(refuse("Pick an edge to give a print transition."));
    }
    let cut = mode == &Some(TransitionMode::Cut);
    let one = picks.len() == 1;
    let mut found = Vec::with_capacity(picks.len());
    let mut reads: Vec<EdgeRead> = Vec::with_capacity(picks.len());
    for &index in picks {
        let which = move |text: String| {
            if one {
                text
            } else {
                format!("Edge {index}: {text}")
            }
        };
        let read = read_edge(from, index, b, *angle_deg, &which)?;
        if (read.convex || case == &Some(TransitionCase::Lip)) && !read.straight {
            return Err(refuse(which(
                "A lip on a curved edge has no gusset yet: a gusset is built from a straight lip edge, its faces flat or curved. Supports are the way here for now."
                    .into(),
            )));
        }
        found.push(match (read.convex, case) {
            (false, Some(TransitionCase::Lip)) => {
                Found::Lip(lip_from_root(from, &read, b, *angle_deg, &which)?)
            }
            (false, _) if cut => {
                return Err(refuse(which(
                    "Cut is for a lip. This edge is a corner, which takes add: cutting a bend thins the wall on its other side and leaves the rows that hang."
                        .into(),
                )))
            }
            (false, _) => Found::Corner(corner(from, &read, b, *angle_deg, *size, max_mm, &which)?),
            (true, Some(TransitionCase::Corner)) => {
                return Err(refuse(which(
                    "This edge is convex. A corner wedge goes in a concave corner, on the inner side of a bend; a convex edge at the bottom of a ledge is a lip, which the Lip case fixes."
                        .into(),
                )))
            }
            (true, _) => Found::Lip(lip(from, &read, index, b, *angle_deg, &which)?),
        });
        reads.push(read);
    }
    let corners: Vec<&Corner> = found
        .iter()
        .filter_map(|f| match f {
            Found::Corner(c) => Some(c),
            Found::Lip(_) => None,
        })
        .collect();
    // Every corner's tool on the path that sweeps and mitres, read whatever path builds it: its ends tell whether the
    // wedges meet one another or a wall.
    let mut plans: Vec<ToolPlan> = Vec::with_capacity(corners.len());
    for (f, read) in found.iter().zip(&reads) {
        if let Found::Corner(c) = f {
            let index = read.index;
            let which = move |text: String| {
                if one {
                    text
                } else {
                    format!("Edge {index}: {text}")
                }
            };
            plans.push(corner_tool(from, read, c, b, *angle_deg, &which)?);
        }
    }
    join_ends(from, &mut plans);
    let corner_reads: Vec<&EdgeRead> = found
        .iter()
        .zip(&reads)
        .filter(|(f, _)| matches!(f, Found::Corner(_)))
        .map(|(_, read)| read)
        .collect();
    let exact = corner_reads.iter().all(|read| read.exact);
    let joined = plans
        .iter()
        .any(|p| p.ext.iter().any(|&x| x > 0.0) || p.mitre.iter().any(Option::is_some));
    // Straight edges between planes as stored, meeting nothing, keep the exact paths of step 2: the chamfer, or the
    // prism to a face's end. Anything else is swept or pushed, sunk into its faces, mitred and grown into walls.
    let swept = !exact || joined;
    let to_end = |c: &Corner| c.reach > c.far_end - END_MM || c.near_reach > c.near_end - END_MM;
    let prism = corners.iter().any(|c| to_end(c));
    let mut kept: Option<Shape> = None;
    let mut swept_soup: Vec<Vec<f64>> = Vec::new();
    if !corners.is_empty() && swept {
        let (made, soups) = sweep_corners(from, &corners, &plans, &corner_reads, b, *angle_deg)?;
        swept_soup = soups;
        kept = Some(made);
    } else if !corners.is_empty() {
        let built = if prism {
            let points: Vec<f64> = corners
                .iter()
                .flat_map(|c| c.section.iter().flatten().copied())
                .collect();
            let along: Vec<f64> = corners.iter().flat_map(|c| c.along).collect();
            // SAFETY: `from` is held for this call; the kernel reads 9 and 3 numbers per wedge.
            Shape::made(|error| unsafe {
                lime_tree_wedges(
                    from.raw(),
                    points.as_ptr(),
                    along.as_ptr(),
                    corners.len() as c_int,
                    0,
                    error,
                )
            })
        } else {
            let edges: Vec<c_int> = corners.iter().map(|c| c.edge).collect();
            let faces: Vec<c_int> = corners.iter().map(|c| c.far).collect();
            let sizes: Vec<f64> = corners.iter().map(|c| c.reach).collect();
            let angles: Vec<f64> = corners.iter().map(|c| c.from_far_deg).collect();
            // SAFETY: `from` is held for this call; the kernel reads `count` of each.
            Shape::made(|error| unsafe {
                lime_tree_transition_chamfer(
                    from.raw(),
                    edges.as_ptr(),
                    faces.as_ptr(),
                    sizes.as_ptr(),
                    angles.as_ptr(),
                    edges.len() as c_int,
                    error,
                )
            })
        };
        let mut made = built.map_err(refuse)?;
        let added = made.fingerprint().volume_mm3 - from.fingerprint().volume_mm3;
        let expected: f64 = corners.iter().map(|c| c.volume).sum();
        if (added - expected).abs() > 0.01 * expected + 0.05 {
            return Err(refuse(format!(
                "The wedge would run into another part of the solid: it adds {added:.1} mm³ where the wedge alone is {expected:.1} mm³. Use a smaller size, or an edge with nothing else between its faces."
            )));
        }
        for c in &corners {
            if !has_face(&mut made, c.normal) {
                return Err(refuse(format!(
                    "Open CASCADE built the wedge's face off the {angle_deg}° asked, so it was not kept."
                )));
            }
        }
        kept = Some(made);
    }
    // The lips, each on the solid so far.
    let mut lips_made: Vec<Option<LipMade>> = Vec::with_capacity(found.len());
    let mut cuts: Vec<([V3; 3], V3, f64)> = Vec::new();
    for (at, f) in found.iter().enumerate() {
        let Found::Lip(lip) = f else {
            lips_made.push(None);
            continue;
        };
        let index = picks[at];
        let which = move |text: String| {
            if one {
                text
            } else {
                format!("Edge {index}: {text}")
            }
        };
        if cut {
            let (section, up_front, left) = ramp(lip, *angle_deg, floor, &which)?;
            let volume =
                0.5 * length(cross(
                    sub(section[1], section[0]),
                    sub(section[2], section[0]),
                )) * length(lip.along);
            let height = dot(sub(section[2], section[1]), b);
            cuts.push((section, lip.along, volume));
            lips_made.push(Some(LipMade {
                volume,
                height,
                landing: lip.depth,
                left: Some(left),
                near_reach: up_front,
                soup: prism_soup(section, lip.along),
            }));
        } else {
            let (fused, made) = gusset(
                &*from,
                kept.as_ref().unwrap_or(&*from),
                lip,
                b,
                max_mm,
                &which,
            )?;
            kept = Some(fused);
            lips_made.push(Some(made));
        }
    }
    if !cuts.is_empty() {
        let onto = kept.as_ref().unwrap_or(&*from);
        let points: Vec<f64> = cuts
            .iter()
            .flat_map(|c| c.0.iter().flatten().copied())
            .collect();
        let along: Vec<f64> = cuts.iter().flat_map(|c| c.1).collect();
        // SAFETY: `onto` is held for this call; the kernel reads 9 and 3 numbers per ramp.
        let mut made = Shape::made(|error| unsafe {
            lime_tree_wedges(
                onto.raw(),
                points.as_ptr(),
                along.as_ptr(),
                cuts.len() as c_int,
                1,
                error,
            )
        })
        .map_err(refuse)?;
        let removed = onto.fingerprint().volume_mm3 - made.fingerprint().volume_mm3;
        let expected: f64 = cuts.iter().map(|c| c.2).sum();
        if (removed - expected).abs() > 0.01 * expected + 0.05 {
            return Err(refuse(format!(
                "The ramp would cut into another part of the solid: it removes {removed:.1} mm³ where the ramp alone is {expected:.1} mm³. A gusset (mode add) may fit instead."
            )));
        }
        for f in &found {
            if let Found::Lip(lip) = f {
                if !has_face(&mut made, lip.normal) {
                    return Err(refuse(format!(
                        "Open CASCADE built the ramp off the {angle_deg}° asked, so it was not kept."
                    )));
                }
            }
        }
        kept = Some(made);
    }
    let kept = kept.ok_or_else(|| refuse("Pick an edge to give a print transition."))?;
    let mut corner_at = 0usize;
    let sides = found
        .iter()
        .zip(&lips_made)
        .map(|(f, made)| match (f, made) {
            (Found::Corner(c), _) => {
                let plan = &plans[corner_at];
                let read = corner_reads[corner_at];
                let soup = swept_soup.get(corner_at).cloned();
                corner_at += 1;
                let path = if swept && !read.straight {
                    "sweep"
                } else if swept || prism {
                    "prism"
                } else {
                    "chamfer"
                };
                let mut row = json!({
                    "edge": c.edge,
                    "case": "corner",
                    "path": path,
                    "material": "add",
                    "farFace": c.far,
                    "nearFace": c.near,
                    "farDeg": round(c.far_deg),
                    "nearDeg": round(c.near_deg),
                    "normal": c.normal.map(round6),
                    "angleToLayersDeg": round(to_layers(c.normal, b)),
                    "reachMm": round(c.reach),
                    "nearReachMm": round(c.near_reach),
                    "farEndMm": round(c.far_end),
                    "volumeMm3": round(c.volume),
                });
                if swept {
                    row["curved"] = json!(!(read.straight && read.flat));
                    row["angleRangeDeg"] = json!([round(plan.angles.0), round(plan.angles.1)]);
                    row["ends"] = json!(plan
                        .ext
                        .iter()
                        .zip(&plan.mitre)
                        .map(|(&x, m)| if m.is_some() {
                            "mitre"
                        } else if x > 0.0 {
                            "wall"
                        } else {
                            "flush"
                        })
                        .collect::<Vec<_>>());
                    if let Some(soup) = soup {
                        row["soup"] = json!(soup);
                    }
                }
                row
            }
            (Found::Lip(lip), made) => {
                let made = made.as_ref().expect("a lip is built");
                let mut row = json!({
                    "edge": lip.edge,
                    "case": "lip",
                    "path": if cut { "ramp" } else { "gusset" },
                    "material": if cut { "cut" } else { "add" },
                    "firstEdge": lip.first,
                    "farFace": lip.under,
                    "nearFace": lip.front,
                    "farDeg": round(lip.under_deg),
                    "nearDeg": round(lip.front_deg),
                    "normal": lip.normal.map(round6),
                    "angleToLayersDeg": round(to_layers(lip.normal, b)),
                    "depthMm": round(lip.depth),
                    "reachMm": round(lip.depth),
                    "nearReachMm": round(made.near_reach),
                    "heightMm": round(made.height),
                    "volumeMm3": round(made.volume),
                    "soup": made.soup,
                });
                if cut {
                    row["leftMm"] = json!(round(made.left.unwrap_or(0.0)));
                    row["floorMm"] = json!(floor);
                } else {
                    row["landingMm"] = json!(round(made.landing));
                }
                row
            }
        })
        .collect::<Vec<Value>>();
    // A step whose every edge was found a lip is stored as one, so its history row names lips and a rebuild after an
    // edit above keeps reading them so.
    let all_lips = found.iter().all(|f| matches!(f, Found::Lip(_)));
    let mut stored = op.clone();
    if let Op::Transition { build, case, .. } = &mut stored {
        *build = b;
        if case.is_none() && all_lips {
            *case = Some(TransitionCase::Lip);
        }
    }
    Ok(Built {
        op: stored,
        kept,
        other: None,
        pieces: Vec::new(),
        pins: None,
        numbered: None,
        joined: None,
        skipped: 0,
        sides,
    })
}

fn round(value: f64) -> f64 {
    (value * 1000.0).round() / 1000.0
}

fn round6(value: f64) -> f64 {
    (value * 1e6).round() / 1e6
}
