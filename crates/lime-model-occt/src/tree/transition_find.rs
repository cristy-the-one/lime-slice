//! --- Print transitions, auto-find (docs/plan-belt-transitions.md, section 5 and step 5): the edges that would start in
//! the air, read from the solid's own faces and edges against the build direction `b` and the support limit. Nothing is
//! sliced and nothing is built here; each row's fix is then probed as the op it would be (`tree.rs`, `transition_find`).
//!
//! - **Corners:** straight concave edges between flat faces, where the steeper face (the near face) holds its own rows
//!   and the flatter one (the far face) is past the limit or within 3° of it.
//! - **Lips:** straight convex edges between flat faces, above the belt or the bed, where both faces rise away from the
//!   edge in build order (the edge is their lowest point there, so its first rows stand on nothing) and the flatter face
//!   is at or past the limit. A lip that starts past a hole in a larger face is one.
//!
//! Edges on the belt or the bed, edges that climb through the layers at least as steeply as the limit (every face
//! through them holds), seams, and edges shorter than 0.2 mm are left out. A point, such as a cone's tip, is no edge.
//! Curved edges, and edges on a curved face, are judged from their middle and only listed by index, for a later version.
//! Open CASCADE reads the curve and the surface as stored, so a flat face a STEP file stores as a B-spline counts here.

use std::os::raw::c_int;

use super::{lime_tree_face_span, Shape};

type V3 = [f64; 3];

/// The far face of a corner this close above the limit is still listed: the housing's flat roof sits exactly on it.
const CORNER_MARGIN_DEG: f64 = 3.0;
/// A lip's flatter face counts as at the limit within this much.
const LIP_MARGIN_DEG: f64 = 0.5;
/// Shorter edges are left out, as the op refuses them.
const MIN_EDGE_MM: f64 = 0.2;
/// An edge this close to the solid's lowest point along the plate's up lies on the belt or the bed.
const ON_PLATE_MM: f64 = 0.05;
/// A curved face reaching this little below an edge along `b` still has the edge as its lowest point.
const LOWEST_MM: f64 = 0.01;
/// A face leaving an edge this little downward along `b` (the cosine of 89.9°) still counts as rising from it.
const RISE_COS: f64 = 1.745e-3;

/// One edge that starts in the air.
pub(super) struct Found {
    pub edge: c_int,
    pub case: &'static str,
    pub length_mm: f64,
    pub mid: V3,
    pub far: c_int,
    pub near: c_int,
    pub far_deg: f64,
    pub near_deg: f64,
}

/// What the finder read: the rows, longest first, and the curved edges that would have been looked at more closely.
pub(super) struct Finding {
    pub rows: Vec<Found>,
    pub curved: Vec<c_int>,
}

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

fn unit(a: V3) -> Option<V3> {
    let length = dot(a, a).sqrt();
    (length.is_finite() && length > 1e-9).then(|| a.map(|v| v / length))
}

/// The angle between a face with outward normal `n` and the layers, as `transition.rs` reads it.
fn to_layers(n: V3, b: V3) -> f64 {
    dot(n, b.map(|v| -v)).clamp(-1.0, 1.0).acos().to_degrees()
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

/// Every edge of `shape` that starts in the air for a solid built along `b`, standing on a plate whose up is `up`, with
/// the support limit `limit` in degrees to the layers.
pub(super) fn find(shape: &mut Shape, b: V3, up: V3, limit: f64) -> Result<Finding, String> {
    let b = unit(b).ok_or("The build direction must be a direction, not zero.")?;
    let up = unit(up).ok_or("The plate's up must be a direction, not zero.")?;
    if !(limit.is_finite() && limit > 0.0 && limit < 90.0) {
        return Err("The support limit must be between 0° and 90° to the layers.".into());
    }
    let counts = shape.fingerprint();
    // The belt or the bed: the solid's lowest point along the plate's up.
    let plate = (0..counts.faces)
        .filter_map(|face| span(shape, face, [0.0; 3], up).map(|(low, _)| low))
        .fold(f64::INFINITY, f64::min);
    if !plate.is_finite() {
        return Err("Open CASCADE could not measure this solid.".into());
    }
    let indexes: Vec<c_int> = (0..counts.edges).collect();
    let kinds = shape.edge_kinds(&indexes)?;
    let mut rows = Vec::new();
    let mut curved = Vec::new();
    for (&index, &kind) in indexes.iter().zip(&kinds) {
        if kind != 1 && kind != 2 {
            continue;
        }
        let Some(edge) = shape.edge(index) else {
            continue;
        };
        if edge.length_mm.is_nan()
            || edge.length_mm < MIN_EDGE_MM
            || !edge.mid.iter().all(|v| v.is_finite())
        {
            continue;
        }
        let Some((sig, faces)) = shape.edge_sig(index) else {
            continue;
        };
        if faces[0] < 0 || faces[1] < 0 || faces[0] == faces[1] || sig.kinds.contains(&9) {
            continue;
        }
        let straight = sig.curve == 0 && sig.kinds == [0, 0];
        let [a, c] = sig.normals;
        let (far, near, n_far, n_near) = if to_layers(a, b) <= to_layers(c, b) {
            (faces[0], faces[1], a, c)
        } else {
            (faces[1], faces[0], c, a)
        };
        let far_deg = to_layers(n_far, b);
        let near_deg = to_layers(n_near, b);
        // The edge's ends along `b` and along the plate's up. A curved edge is judged at its middle.
        let (low_b, low_up) = if straight {
            let e = unit(sig.dir).unwrap_or([0.0; 3]);
            let half = 0.5 * edge.length_mm;
            (
                dot(edge.mid, b) - half * dot(e, b).abs(),
                dot(edge.mid, up) - half * dot(e, up).abs(),
            )
        } else {
            (dot(edge.mid, b), dot(edge.mid, up))
        };
        if low_up - plate <= ON_PLATE_MM {
            continue;
        }
        if straight {
            let e = unit(sig.dir).unwrap_or([0.0; 3]);
            // Every face through an edge that climbs at least the limit through the layers holds its own rows.
            if dot(e, b).abs().clamp(0.0, 1.0).asin().to_degrees() >= limit - 1e-6 {
                continue;
            }
        }
        let case = if kind == 2 {
            (far_deg < limit + CORNER_MARGIN_DEG && near_deg >= limit - 0.05).then_some("corner")
        } else if far_deg <= limit + LIP_MARGIN_DEG {
            let rises = if straight {
                // Both faces rise away from the edge in build order: nothing of either face is laid before it there,
                // so its first rows stand on nothing. This also finds a lip that starts past a hole in a larger face.
                let e = unit(sig.dir).unwrap_or([0.0; 3]);
                let away = |n: V3, other: V3| {
                    let u = cross(e, n);
                    let u = if dot(u, other) <= 0.0 {
                        u
                    } else {
                        u.map(|v| -v)
                    };
                    unit(u).is_some_and(|u| dot(u, b) >= -RISE_COS)
                };
                away(n_far, n_near) && away(n_near, n_far)
            } else {
                let lowest = |shape: &mut Shape, face: c_int| {
                    span(shape, face, [0.0; 3], b)
                        .is_some_and(|(least, _)| least >= low_b - LOWEST_MM)
                };
                lowest(shape, far) && lowest(shape, near)
            };
            rises.then_some("lip")
        } else {
            None
        };
        let Some(case) = case else {
            continue;
        };
        if !straight {
            curved.push(index);
            continue;
        }
        rows.push(Found {
            edge: index,
            case,
            length_mm: edge.length_mm,
            mid: edge.mid,
            far,
            near,
            far_deg,
            near_deg,
        });
    }
    rows.sort_by(|p, q| {
        q.length_mm
            .total_cmp(&p.length_mm)
            .then(p.edge.cmp(&q.edge))
    });
    Ok(Finding { rows, curved })
}
