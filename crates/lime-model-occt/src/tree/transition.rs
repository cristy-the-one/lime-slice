//! --- Print transitions (docs/plan-belt-transitions.md, step 2): the corner wedge on straight edges.
//!
//! An edge is a corner when it is concave, straight, and between two flat faces, and the flatter of the two (the far
//! face) grows flatter to the layers than the angle asked. The wedge fills the air between the faces: its new face
//! holds the edge's direction and makes the asked angle with the layers, so each of its rows stands on the one before.
//! It runs `size` along the far face, or to that face's end. A wedge that stops short of both faces' ends is a
//! chamfer by a distance and an angle from the far face; one that reaches an end is a triangular prism fused on, since
//! a chamfer cannot use up a face. Every refusal is a sentence, and the solid is not changed.

use std::os::raw::c_int;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::{
    lime_tree_face_span, lime_tree_transition_chamfer, lime_tree_wedges, BuildFail, Built, Op,
    Shape,
};

/// The support angle: a face holds its own rows at 45° to the layers or steeper.
pub(super) fn default_angle() -> f64 {
    45.0
}

/// The wedge's reach along the far face without a typed `size`.
const DEFAULT_SIZE_MM: f64 = 2.0;
/// The largest wedge built without a typed `maxMm`, along either face.
const DEFAULT_MAX_MM: f64 = 20.0;
/// Shorter edges are refused.
const MIN_EDGE_MM: f64 = 0.2;
/// The new face may be off the asked angle by this much, measured on the built solid.
const ANGLE_CHECK_DEG: f64 = 1.0;
/// A wedge closer than this to a face's end is built to the end, as a prism.
const END_MM: f64 = 0.05;

/// How far the wedge reaches along the far face: millimetres, or `"face"`, to that face's end. 2 mm when absent: on the
/// step 2 coupons it held every row a larger wedge held, and from 5 mm up, with Skin on shallow slopes on, a wedge left
/// more rows hanging than no wedge (docs/plan-belt-transitions.md, "As built: step 2").
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

/// `auto` adds, as `add` does, for a corner. `cut` is for a thick lip's underside, which a later step builds.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TransitionMode {
    Auto,
    Add,
    Cut,
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

fn unit(a: V3) -> Option<V3> {
    let length = dot(a, a).sqrt();
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

#[allow(clippy::too_many_arguments)]
fn corner(
    from: &mut Shape,
    index: c_int,
    b: V3,
    angle: f64,
    size: TransitionSize,
    max_mm: f64,
    one: bool,
) -> Result<Corner, BuildFail> {
    let which = |text: String| {
        if one {
            text
        } else {
            format!("Edge {index}: {text}")
        }
    };
    let edge = from
        .edge(index)
        .ok_or_else(|| refuse(which("That edge is not on this solid.".into())))?;
    if edge.length_mm < MIN_EDGE_MM {
        return Err(refuse(which(format!(
            "This edge is {:.2} mm long, under the {MIN_EDGE_MM} mm a print transition needs.",
            edge.length_mm
        ))));
    }
    let (sig, faces) = from.edge_sig(index).ok_or_else(|| {
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
    if sig.curve != 0 || sig.kinds != [0, 0] {
        return Err(refuse(which(
            "A print transition is built on a straight edge between two flat faces for now. Curved edges and faces come in a later step."
                .into(),
        )));
    }
    match from.edge_kinds(&[index]).map_err(refuse)?.first() {
        Some(2) => {}
        Some(1) => {
            return Err(refuse(which(
                "This edge is convex. A corner wedge goes in a concave corner, on the inner side of a bend; a lip under a convex edge comes in a later step."
                    .into(),
            )))
        }
        _ => {
            return Err(refuse(which(
                "The faces at this edge meet with no corner, so there is nothing to fill.".into(),
            )))
        }
    }
    let e = unit(sig.dir).ok_or_else(|| {
        refuse(which(
            "Open CASCADE could not read this edge's direction.".into(),
        ))
    })?;
    let down = scale(b, -1.0);
    // The steepest any face through the edge can lie: when even that is at least the angle asked, every face holds.
    let across = (1.0 - dot(e, b).powi(2)).max(0.0).sqrt();
    if deg(across.clamp(-1.0, 1.0).acos()) >= angle - 1e-6 {
        return Err(refuse(which(format!(
            "This edge already grows at least {angle}° to the layers, so every face through it holds its own rows."
        ))));
    }
    let [a, c] = sig.normals;
    let (far, near, n_far, n_near) = if dot(a, down) >= dot(c, down) {
        (faces[0], faces[1], a, c)
    } else {
        (faces[1], faces[0], c, a)
    };
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
            "Both faces here grow flatter than {angle}° to the layers (the steeper at {near_deg:.1}°), so a wedge would itself start in the air. That is a lip, which a later step fixes; supports or a split work now."
        ))));
    }
    // A steeper face at the angle asked would be the new face itself: the wedge would run along it with no end.
    if near_deg < angle + 0.05 {
        return Err(refuse(which(format!(
            "The steeper face here grows at {near_deg:.1}° to the layers, the {angle}° asked, so a wedge at that angle would run along it. A steeper angle makes one."
        ))));
    }
    // The new face's normal turns from the far face's toward the near face's, about the edge, until it makes the angle
    // asked with the layers. At the far end it is too flat, at the near end steep enough, so the turn is bisected.
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
    let normal = unit(turn(t))
        .ok_or_else(|| refuse(which("This corner has no wedge at that angle.".into())))?;
    let from_far = t * theta;
    // Into each face from the edge: square to the edge, in the face, toward the air side of the other face.
    let into = |n: V3, other: V3| {
        let u = cross(e, n);
        if dot(u, other) >= 0.0 {
            u
        } else {
            scale(u, -1.0)
        }
    };
    let (u_far, u_near) = match (unit(into(n_far, n_near)), unit(into(n_near, n_far))) {
        (Some(f), Some(n)) => (f, n),
        _ => {
            return Err(refuse(which(
                "Open CASCADE could not read this corner's faces.".into(),
            )))
        }
    };
    let gap = dot(u_far, u_near).clamp(-1.0, 1.0).acos();
    let start = add(edge.mid, scale(e, -0.5 * edge.length_mm));
    let far_end = span(from, far, start, u_far)
        .ok_or_else(|| {
            refuse(which(
                "Open CASCADE could not measure the flatter face.".into(),
            ))
        })?
        .1;
    let near_end = span(from, near, start, u_near)
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
    let along = scale(e, edge.length_mm);
    Ok(Corner {
        edge: index,
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
        volume: 0.5 * reach * near_reach * gap.sin() * edge.length_mm,
    })
}

/// The wedges for every edge of `op`, checked on the built solid: the volume added is the wedges' own, so they touched
/// nothing else, and each new face lies at the angle asked.
pub(super) fn build(from: &mut Shape, op: Op, picks: &[c_int]) -> Result<Built, BuildFail> {
    let Op::Transition {
        build,
        angle_deg,
        size,
        max_mm,
        mode,
        ..
    } = &op
    else {
        unreachable!("matched a transition");
    };
    if mode == &Some(TransitionMode::Cut) {
        return Err(refuse(
            "Cut turns a thick lip's underside into a ramp, and comes with lips in a later step. A corner takes mode add.",
        ));
    }
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
    if picks.is_empty() {
        return Err(refuse("Pick an edge to give a print transition."));
    }
    let one = picks.len() == 1;
    let corners = picks
        .iter()
        .map(|&index| corner(from, index, b, *angle_deg, *size, max_mm, one))
        .collect::<Result<Vec<_>, _>>()?;
    let to_end = |c: &Corner| c.reach > c.far_end - END_MM || c.near_reach > c.near_end - END_MM;
    let prism = corners.iter().any(to_end);
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
    let mut kept = built.map_err(refuse)?;
    let added = kept.fingerprint().volume_mm3 - from.fingerprint().volume_mm3;
    let expected: f64 = corners.iter().map(|c| c.volume).sum();
    if (added - expected).abs() > 0.01 * expected + 0.05 {
        return Err(refuse(format!(
            "The wedge would run into another part of the solid: it adds {added:.1} mm³ where the wedge alone is {expected:.1} mm³. Use a smaller size, or an edge with nothing else between its faces."
        )));
    }
    let made: Vec<[V3; 2]> = kept
        .created_indexes()
        .into_iter()
        .filter_map(|index| kept.edge_sig(index).map(|(sig, _)| sig.normals))
        .collect();
    let tight = ANGLE_CHECK_DEG.to_radians().cos();
    for c in &corners {
        if !made.iter().flatten().any(|n| dot(*n, c.normal) >= tight) {
            return Err(refuse(format!(
                "Open CASCADE built the wedge's face off the {angle_deg}° asked, so it was not kept."
            )));
        }
    }
    let sides = corners
        .iter()
        .map(|c| {
            json!({
                "edge": c.edge,
                "case": "corner",
                "path": if prism { "prism" } else { "chamfer" },
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
            })
        })
        .collect::<Vec<Value>>();
    let mut stored = op.clone();
    if let Op::Transition { build, .. } = &mut stored {
        *build = b;
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
