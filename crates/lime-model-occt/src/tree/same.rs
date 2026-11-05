//! Whether an incoming op asks for what a stored node already built.

use super::*;

/// Whether `incoming` asks for the op `stored` already is. A stored edge matches an index pick by
/// index and a reference by midpoint and length, since a rebuild may have renumbered it.
pub(super) fn same_request(stored: &Op, incoming: &Op) -> bool {
    // --- Split to print. The stored op keeps only the connectors that built (D6), so a retried apply of the op as
    // asked is the same step when what it placed holds what was kept.
    if let (Op::Partition { cuts: kept, .. }, Op::Partition { cuts: asked, .. }) = (stored, incoming) {
        let ids = |cut: &PartitionCut| -> HashSet<String> {
            cut.connectors
                .get("placed")
                .and_then(Value::as_array)
                .map(|rows| {
                    rows.iter()
                        .filter_map(|row| row.get("id").and_then(Value::as_str).map(str::to_owned))
                        .collect()
                })
                .unwrap_or_default()
        };
        if kept.len() == asked.len() && kept.iter().zip(asked).all(|(k, a)| ids(k).is_subset(&ids(a))) {
            let mut trimmed = asked.clone();
            let built: HashSet<String> = kept.iter().flat_map(ids).collect();
            keep_built(&mut trimmed, &built);
            let mut asked_op = incoming.clone();
            if let Op::Partition { cuts, .. } = &mut asked_op {
                *cuts = trimmed;
            }
            return stored == &asked_op;
        }
        return false;
    }
    let (stored_edges, incoming_edges) = match (stored, incoming) {
        (Op::Fillet { edges: a, size: x }, Op::Fillet { edges: b, size: y })
            if x == y && a.len() == b.len() =>
        {
            (a, b)
        }
        (
            Op::Chamfer {
                edges: a,
                size: x,
                size2: x2,
                angle_deg: xa,
                flip: xf,
            },
            Op::Chamfer {
                edges: b,
                size: y,
                size2: y2,
                angle_deg: ya,
                flip: yf,
            },
        ) if x == y && x2 == y2 && xa == ya && xf == yf && a.len() == b.len() => (a, b),
        (Op::Fillet { .. } | Op::Chamfer { .. }, _) => return false,
        // --- Print transitions: the edges as a blend's, the rest as stored.
        (Op::Transition { edges: a, .. }, Op::Transition { edges: b, .. }) => {
            let mut left = stored.clone();
            let mut right = incoming.clone();
            for one in [&mut left, &mut right] {
                if let Op::Transition { edges, .. } = one {
                    edges.clear();
                }
            }
            if left != right || a.len() != b.len() {
                return false;
            }
            (a, b)
        }
        // K3. A stored face matches an index pick by index, and a reference by its centre and area.
        (
            Op::Extrude {
                up_to: Some(stored_face),
                ..
            },
            Op::Extrude {
                up_to: Some(incoming_face),
                ..
            },
        ) => {
            let stored_face = *stored_face;
            let incoming_face = *incoming_face;
            let mut left = stored.clone();
            let mut right = incoming.clone();
            if let Op::Extrude { up_to, .. } = &mut left {
                *up_to = None;
            }
            if let Op::Extrude { up_to, .. } = &mut right {
                *up_to = None;
            }
            return left == right && match (stored_face, incoming_face) {
                (FacePick::Ref(have), FacePick::Index(index)) => have.index == index,
                (FacePick::Ref(have), FacePick::Ref(want)) => same_face(&have, &want),
                (have, want) => have == want,
            };
        }
        // K4: a stored face reference matches an index pick of that face, as a shell's open face does.
        (
            Op::FaceExtrude {
                face: stored_face,
                distance: stored_distance,
                draft_deg: stored_draft,
                up_to: stored_up_to,
            },
            Op::FaceExtrude {
                face: incoming_face,
                distance: incoming_distance,
                draft_deg: incoming_draft,
                up_to: incoming_up_to,
            },
        ) => {
            return stored_distance == incoming_distance
                && stored_draft == incoming_draft
                && same_face_pick(stored_face, incoming_face)
                && match (stored_up_to, incoming_up_to) {
                    (None, None) => true,
                    (Some(stored), Some(incoming)) => same_face_pick(stored, incoming),
                    _ => false,
                }
        }
        (Op::MoveFaces { faces: stored }, Op::MoveFaces { faces: incoming }) => {
            return stored.len() == incoming.len()
                && stored.iter().zip(incoming).all(|(stored, incoming)| {
                    stored.distance == incoming.distance
                        && same_face_pick(&stored.face, &incoming.face)
                })
        }
        (
            Op::Shell {
                thickness: x,
                open_faces: a,
            },
            Op::Shell {
                thickness: y,
                open_faces: b,
            },
        ) => {
            return x == y
                && a.len() == b.len()
                && a.iter().zip(b).all(|pair| match pair {
                    (FacePick::Ref(have), FacePick::Index(index)) => have.index == *index,
                    (FacePick::Ref(have), FacePick::Ref(want)) => same_face(have, want),
                    (have, want) => have == want,
                })
        }
        // --- A1 group: the steps, recursively. `source` is the composite as typed and is not compared. ---
        (Op::Group { steps: a, combine: p, .. }, Op::Group { steps: b, combine: q, .. }) => {
            return p == q && a.len() == b.len() && a.iter().zip(b).all(|(x, y)| same_request(x, y))
        }
        (Op::Group { .. }, _) | (_, Op::Group { .. }) => return false,
        _ => return stored == incoming,
    };
    stored_edges
        .iter()
        .zip(incoming_edges)
        .all(|pair| match pair {
            (EdgePick::Ref(have), EdgePick::Index(index)) => have.index == *index,
            (EdgePick::Ref(have), EdgePick::Ref(want)) => same_edge(have, want),
            (have, want) => have == want,
        })
}

/// Whether two resolved ops build the same solid. A join's `keepTool` is the plate's business, and its
/// tool's `object` and `name` only label it.
pub(super) fn same_build(a: &Op, b: &Op) -> bool {
    match (a, b) {
        (
            Op::Join {
                op: x,
                tool: t,
                relative: r,
                ..
            },
            Op::Join {
                op: y,
                tool: u,
                relative: q,
                ..
            },
        ) => x == y && t.key == u.key && t.node == u.node && r == q,
        // --- A1 group: the steps, recursively. `source` and the label build nothing. ---
        (Op::Group { steps: a, combine: p, .. }, Op::Group { steps: b, combine: q, .. }) => {
            p == q && a.len() == b.len() && a.iter().zip(b).all(|(x, y)| same_build(x, y))
        }
        _ => a == b,
    }
}

/// A stored face matches an index pick by index, and a reference by centre and area.
fn same_face_pick(stored: &FacePick, incoming: &FacePick) -> bool {
    match (stored, incoming) {
        (FacePick::Ref(have), FacePick::Index(index)) => have.index == *index,
        (FacePick::Ref(have), FacePick::Ref(want)) => same_face(have, want),
        (have, want) => have == want,
    }
}

pub(super) fn same_face(a: &FaceRef, b: &FaceRef) -> bool {
    let d = (0..3)
        .map(|i| (a.mid[i] - b.mid[i]).powi(2))
        .sum::<f64>()
        .sqrt();
    d <= EDGE_MATCH_MM && (a.area_mm2 - b.area_mm2).abs() <= EDGE_MATCH_MM * a.area_mm2.abs().max(1.0)
}

pub(super) fn same_edge(a: &EdgeRef, b: &EdgeRef) -> bool {
    let d = (0..3)
        .map(|i| (a.mid[i] - b.mid[i]).powi(2))
        .sum::<f64>()
        .sqrt();
    d <= EDGE_MATCH_MM && (a.length_mm - b.length_mm).abs() <= EDGE_MATCH_MM
}
