//! --- Print transitions, auto-find (docs/plan-belt-transitions.md, section 5 and steps 5 and 6): the edges that would
//! start in the air, read from the solid's own faces and edges against the build direction `b` and the support limit.
//! Nothing is sliced and nothing is built here; each row's fix is then probed as the op it would be (`tree.rs`,
//! `transition_find`).
//!
//! - **Corners:** concave edges where the steeper face (the near face) holds its own rows and the flatter one (the far
//!   face) is past the limit or within 3° of it.
//! - **Lips:** convex edges above the belt or the bed, where both faces rise away from the edge in build order (the edge
//!   is their lowest point there, so its first rows stand on nothing) and the flatter face is at or past the limit. A lip
//!   that starts past a hole in a larger face is one. Each underside lists its longest such edge only: one gusset from it
//!   holds every row born with it.
//!
//! A straight edge between flat faces is read once. A curved edge, or an edge on a curved face, is read about every
//! millimetre along its length, and listed when the stretches that start in the air add up to more than 2 mm (plan
//! section 8): a cylinder near the limit would otherwise list every edge it touches. A flat face or a straight edge a
//! STEP file stores as a B-spline reads as flat or straight.
//!
//! Edges on the belt or the bed, edges that climb through the layers at least as steeply as the limit (every face
//! through them holds), seams, and edges shorter than 0.2 mm are left out. A point, such as a cone's tip, is no edge.

use std::os::raw::c_int;

use super::transition::{station_count, stations, Station};
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
/// A face leaving an edge this little downward along `b` (the cosine of 89.9°) still counts as rising from it.
const RISE_COS: f64 = 1.745e-3;
/// A curved edge is listed when the stretches of it that start in the air add up to more than this (plan section 8).
const MIN_RUN_MM: f64 = 2.0;

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
    /// The edge or a face at it is curved: read along its length, `length_mm` is how much of it starts in the air.
    pub curved: bool,
}

/// What the finder read: the rows, longest first, and the curved edges it could not read along.
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

/// How one point of an edge reads: its case there, if it starts in the air, with the far and near faces (as 0 or 1 of
/// the edge's two) and their angles to the layers.
struct Read {
    case: Option<&'static str>,
    far: usize,
    far_deg: f64,
    near_deg: f64,
}

/// One point of an edge of kind `kind` (1 convex, 2 concave), along `t`, its faces' outward normals `n`: the same tests a
/// straight edge between flat faces gets, at that point.
fn read_at(kind: c_int, t: V3, n: [V3; 2], b: V3, limit: f64) -> Read {
    let (far, n_far, n_near) = if to_layers(n[0], b) <= to_layers(n[1], b) {
        (0, n[0], n[1])
    } else {
        (1, n[1], n[0])
    };
    let far_deg = to_layers(n_far, b);
    let near_deg = to_layers(n_near, b);
    let read = |case| Read {
        case,
        far,
        far_deg,
        near_deg,
    };
    // Every face through an edge that climbs at least the limit through the layers holds its own rows.
    let Some(e) = unit(t) else {
        return read(None);
    };
    if dot(e, b).abs().clamp(0.0, 1.0).asin().to_degrees() >= limit - 1e-6 {
        return read(None);
    }
    let case = if kind == 2 {
        (far_deg < limit + CORNER_MARGIN_DEG && near_deg >= limit - 0.05).then_some("corner")
    } else if far_deg <= limit + LIP_MARGIN_DEG {
        // Both faces rise away from the edge in build order: nothing of either face is laid before it there, so its
        // first rows stand on nothing. This also finds a lip that starts past a hole in a larger face.
        let away = |n: V3, other: V3| {
            let u = cross(e, n);
            let u = if dot(u, other) <= 0.0 {
                u
            } else {
                u.map(|v| -v)
            };
            unit(u).is_some_and(|u| dot(u, b) >= -RISE_COS)
        };
        (away(n_far, n_near) && away(n_near, n_far)).then_some("lip")
    } else {
        None
    };
    read(case)
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
        let Some((sig, faces)) = shape.edge_sig_flat(index) else {
            continue;
        };
        if faces[0] < 0 || faces[1] < 0 || faces[0] == faces[1] || sig.kinds.contains(&9) {
            continue;
        }
        let even = sig.curve == 0 && sig.kinds == [0, 0];
        if even {
            let e = unit(sig.dir).unwrap_or([0.0; 3]);
            // The edge's lowest end along the plate's up.
            let low_up = dot(edge.mid, up) - 0.5 * edge.length_mm * dot(e, up).abs();
            if low_up - plate <= ON_PLATE_MM {
                continue;
            }
            let read = read_at(kind, e, sig.normals, b, limit);
            let Some(case) = read.case else {
                continue;
            };
            rows.push(Found {
                edge: index,
                case,
                length_mm: edge.length_mm,
                mid: edge.mid,
                far: faces[read.far],
                near: faces[1 - read.far],
                far_deg: read.far_deg,
                near_deg: read.near_deg,
                curved: false,
            });
            continue;
        }
        let count = station_count(edge.length_mm, false);
        let Some(along) = stations(shape, index, faces, count) else {
            curved.push(index);
            continue;
        };
        let step = edge.length_mm / (count - 1) as f64;
        let reads: Vec<Read> = along
            .iter()
            .map(|s: &Station| {
                if dot(s.p, up) - plate <= ON_PLATE_MM {
                    Read {
                        case: None,
                        far: 0,
                        far_deg: 0.0,
                        near_deg: 0.0,
                    }
                } else {
                    read_at(kind, s.t, s.n, b, limit)
                }
            })
            .collect();
        // The stretches between two stations that both start in the air, and the longest run of them.
        let mut total = 0.0;
        let mut best = (0.0f64, 0usize, 0usize);
        let mut run_start = None;
        for i in 0..reads.len() {
            let on = reads[i].case.is_some();
            if on && i > 0 && reads[i - 1].case.is_some() {
                total += step;
            }
            match (on, run_start) {
                (true, None) => run_start = Some(i),
                (false, Some(start)) => {
                    let run = (i - 1 - start) as f64 * step;
                    if run > best.0 {
                        best = (run, start, i - 1);
                    }
                    run_start = None;
                }
                _ => {}
            }
        }
        if let Some(start) = run_start {
            let run = (reads.len() - 1 - start) as f64 * step;
            if run > best.0 {
                best = (run, start, reads.len() - 1);
            }
        }
        if total <= MIN_RUN_MM {
            continue;
        }
        let at = (best.1 + best.2) / 2;
        let read = &reads[at];
        rows.push(Found {
            edge: index,
            case: read
                .case
                .unwrap_or(if kind == 2 { "corner" } else { "lip" }),
            length_mm: total,
            mid: along[at].p,
            far: faces[read.far],
            near: faces[1 - read.far],
            far_deg: read.far_deg,
            near_deg: read.near_deg,
            curved: true,
        });
    }
    rows.sort_by(|p, q| {
        q.length_mm
            .total_cmp(&p.length_mm)
            .then(p.edge.cmp(&q.edge))
    });
    // One lip per underside: its rows are born at once along every edge of it, and one gusset from its longest edge
    // holds them. The underside's other edges (its sides) are left to a pick by hand.
    let mut undersides = std::collections::HashSet::new();
    rows.retain(|row| row.case != "lip" || undersides.insert(row.far));
    Ok(Finding { rows, curved })
}
