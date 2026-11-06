//! Resolving an op before it builds: edge and face picks turned into indexes on the solid at hand.

use std::collections::HashMap;
use std::os::raw::c_int;

use super::NodeId;
use super::ops::{EdgeFilter, EdgePick, EdgeRef, FaceMove, FacePick, FaceRef, Op};
use super::same::{same_edge, same_face};
use super::shape::Shape;

/// The edges each step a blend takes edges from made, by that step's id.
pub(super) type Steps = HashMap<NodeId, Vec<EdgeRef>>;

pub(super) const NOT_ABOVE: &str = "A blend can only take edges from this step's parent or a step above it.";

/// Whether `op` takes edges from an earlier step, which must be read before it builds.
pub(super) fn picks_steps(op: &Op) -> bool {
    let mut wanted = Vec::new();
    blend_step_picks(op, &mut wanted);
    !wanted.is_empty()
}

/// --- A1 group: the steps a blend, or a blend inside a group, takes edges from. ---
pub(super) fn blend_step_picks(op: &Op, out: &mut Vec<NodeId>) {
    match op {
        Op::Fillet { edges, .. } | Op::Chamfer { edges, .. } | Op::Transition { edges, .. } => {
            for pick in edges {
                if let EdgePick::Step(step) = pick {
                    out.push(step.from_node);
                }
            }
        }
        Op::Group { steps, .. } => {
            for step in steps {
                blend_step_picks(step, out);
            }
        }
        _ => {}
    }
}

/// An op as the tree stores it, and the kernel indexes it is built with: a blend's edges or a shell's open faces,
/// on the solid it is built from.
pub(super) struct Resolved {
    pub(super) op: Op,
    pub(super) picks: Vec<c_int>,
}

/// Turn every edge or face pick into a reference on `from`: the index when its midpoint and size still
/// agree, else the one that matches them. A step's edges are found on `from` by midpoint and length and
/// kept by `filter`; the op keeps the step pick as sent. Other ops pass through.
pub(super) fn resolve(from: &mut Shape, op: &Op, steps: &Steps) -> Result<Resolved, String> {
    match op {
        Op::Fillet { edges, size } => {
            let (refs, picks) = resolve_blend(from, edges, "fillet", steps)?;
            Ok(Resolved {
                op: Op::Fillet {
                    edges: refs,
                    size: *size,
                },
                picks,
            })
        }
        Op::Chamfer {
            edges,
            size,
            size2,
            angle_deg,
            flip,
        } => {
            if size2.is_some() && angle_deg.is_some() {
                return Err("Give a chamfer a second distance or an angle, not both.".into());
            }
            let (refs, picks) = resolve_blend(from, edges, "chamfer", steps)?;
            Ok(Resolved {
                op: Op::Chamfer {
                    edges: refs,
                    size: *size,
                    size2: *size2,
                    angle_deg: *angle_deg,
                    flip: *flip,
                },
                picks,
            })
        }
        Op::Shell {
            thickness,
            open_faces,
        } => resolve_shell(from, open_faces, *thickness),
        // --- Print transitions.
        Op::Transition { edges, .. } => {
            let (refs, picks) = resolve_blend(from, edges, "give a print transition", steps)?;
            let mut op = op.clone();
            if let Op::Transition { edges, .. } = &mut op {
                *edges = refs;
            }
            Ok(Resolved { op, picks })
        }
        // K3. A plain extrude has no face to resolve and falls through below.
        Op::Extrude {
            up_to: Some(_), ..
        } => resolve_extrude_face(from, op),
        // K4.
        Op::FaceExtrude {
            face,
            distance,
            draft_deg,
            up_to,
        } => resolve_face_extrude(from, *face, *distance, *draft_deg, *up_to),
        Op::MoveFaces { faces } => resolve_move_faces(from, faces),
        _ => Ok(Resolved {
            op: op.clone(),
            picks: Vec::new(),
        }),
    }
}

/// A blend's edges as the op stores them, and their indexes on `from`. A fresh index pick is stored with its
/// signature, and a stored reference keeps the one it had: an edge stored without one is stored as it was.
fn resolve_blend(
    from: &mut Shape,
    edges: &[EdgePick],
    verb: &str,
    steps: &Steps,
) -> Result<(Vec<EdgePick>, Vec<c_int>), String> {
    let mut refs: Vec<EdgePick> = Vec::with_capacity(edges.len());
    let mut picks: Vec<c_int> = Vec::new();
    // Every edge of `from`, read once, the first time a step pick needs to look for one.
    let mut every: Option<Vec<EdgeRef>> = None;
    for pick in edges {
        let found = match *pick {
            EdgePick::Index(index) if index < 0 && edges.len() == 1 => {
                return Err(format!("Pick an edge to {verb}."))
            }
            EdgePick::Index(index) => from.edge(index).map(|mut have| {
                have.sig = from.edge_sig(index).map(|(sig, _)| sig);
                have
            }),
            EdgePick::Ref(want) => {
                let have = match from.edge(want.index) {
                    Some(have) if same_edge(&have, &want) => Some(have),
                    _ => match (from.find_edge(&want)?, want.sig) {
                        (Some(have), _) => Some(have),
                        (None, Some(sig)) => from.find_edge_like(&want, &sig)?,
                        (None, None) => None,
                    },
                };
                have.map(|mut have| {
                    if want.sig.is_some() {
                        have.sig = from.edge_sig(have.index).map(|(sig, _)| sig).or(want.sig);
                    }
                    have
                })
            }
            EdgePick::Step(step) => {
                let made = steps.get(&step.from_node).ok_or(NOT_ABOVE)?;
                let every = every.get_or_insert_with(|| from.all_edges());
                let mut found: Vec<c_int> = Vec::new();
                for want in made {
                    let at = usize::try_from(want.index).ok();
                    match at.and_then(|at| every.get(at)) {
                        Some(have) if same_edge(have, want) => found.push(have.index),
                        _ => found.extend(
                            every
                                .iter()
                                .filter(|have| same_edge(have, want))
                                .map(|have| have.index),
                        ),
                    }
                }
                found.sort_unstable();
                found.dedup();
                let kinds = from.edge_kinds(&found)?;
                let filter = step.filter.unwrap_or_default();
                let mut any = false;
                for (index, kind) in found.into_iter().zip(kinds) {
                    let keep = match filter {
                        EdgeFilter::All => kind != 0,
                        EdgeFilter::Convex => kind == 1,
                        EdgeFilter::Concave => kind == 2,
                    };
                    if keep {
                        any = true;
                        if !picks.contains(&index) {
                            picks.push(index);
                        }
                    }
                }
                if !any {
                    let which = match filter {
                        EdgeFilter::All => "sharp",
                        EdgeFilter::Convex => "convex",
                        EdgeFilter::Concave => "concave",
                    };
                    return Err(format!(
                        "Step {} left no {which} edges on this solid to {verb}.",
                        step.from_node
                    ));
                }
                if !refs.contains(pick) {
                    refs.push(*pick);
                }
                continue;
            }
        };
        let found = found.ok_or_else(|| "That edge is not on this solid".to_string())?;
        if !found.mid.iter().all(|value| value.is_finite()) || !found.length_mm.is_finite() {
            return Err("Open CASCADE could not measure that edge".into());
        }
        if !refs
            .iter()
            .any(|have| matches!(have, EdgePick::Ref(have) if have.index == found.index))
        {
            refs.push(EdgePick::Ref(found));
        }
        if !picks.contains(&found.index) {
            picks.push(found.index);
        }
    }
    if picks.is_empty() {
        return Err(format!("Pick an edge to {verb}."));
    }
    Ok((refs, picks))
}

/// For a chamfer by two distances or a distance and an angle: for each edge, the face its first distance runs along
/// (the upper of its two faces, or the other with `flip`), and that face's outward normal there.
pub(super) fn chamfer_sides(from: &mut Shape, picks: &[c_int], flip: bool) -> Result<Vec<(c_int, [f64; 3])>, String> {
    let mut sides = Vec::with_capacity(picks.len());
    for &index in picks {
        let (sig, faces) = from
            .edge_sig(index)
            .ok_or("Open CASCADE could not read that edge's faces")?;
        if faces[1] < 0 || sig.kinds[1] == 9 {
            return Err("A chamfer by two sizes needs an edge between two faces.".into());
        }
        let [a, b] = sig.normals;
        let upper = |a: [f64; 3], b: [f64; 3]| {
            for k in [2, 0, 1] {
                if (a[k] - b[k]).abs() > 1e-6 {
                    return a[k] > b[k];
                }
            }
            true
        };
        let first_is_a = upper(a, b) != flip;
        sides.push(if first_is_a { (faces[0], a) } else { (faces[1], b) });
    }
    Ok(sides)
}

fn resolve_shell(from: &mut Shape, faces: &[FacePick], thickness: f64) -> Result<Resolved, String> {
    let mut refs: Vec<FacePick> = Vec::with_capacity(faces.len());
    let mut picks: Vec<c_int> = Vec::new();
    for pick in faces {
        let found = match *pick {
            FacePick::Index(index) => from.face(index),
            FacePick::Ref(want) => match from.face(want.index) {
                Some(have) if same_face(&have, &want) => Some(have),
                _ => from.find_face(&want)?,
            },
        };
        let found = found.ok_or_else(|| "That face is not on this solid.".to_string())?;
        if !found.mid.iter().all(|value| value.is_finite()) || !found.area_mm2.is_finite() {
            return Err("Open CASCADE could not measure that face".into());
        }
        if !picks.contains(&found.index) {
            picks.push(found.index);
            refs.push(FacePick::Ref(found));
        }
    }
    Ok(Resolved {
        op: Op::Shell {
            thickness,
            open_faces: refs,
        },
        picks,
    })
}

/// K3. The face an extrude stops at, stored as `{index, mid, areaMm2}` the way a shell stores an open face.
fn resolve_extrude_face(from: &mut Shape, op: &Op) -> Result<Resolved, String> {
    let Op::Extrude {
        up_to: Some(pick), ..
    } = op
    else {
        return Ok(Resolved {
            op: op.clone(),
            picks: Vec::new(),
        });
    };
    let found = match *pick {
        FacePick::Index(index) => from.face(index),
        FacePick::Ref(want) => match from.face(want.index) {
            Some(have) if same_face(&have, &want) => Some(have),
            _ => {
                let mut matched = None;
                for index in 0..from.fingerprint().faces {
                    let Some(have) = from.face(index) else {
                        continue;
                    };
                    if same_face(&have, &want) {
                        if matched.is_some() {
                            return Err(
                                "Two faces match the one this extrude stops at.".into(),
                            );
                        }
                        matched = Some(have);
                    }
                }
                matched
            }
        },
    };
    let found = found.ok_or_else(|| "That face is not on this solid.".to_string())?;
    if !found.mid.iter().all(|value| value.is_finite()) || !found.area_mm2.is_finite() {
        return Err("Open CASCADE could not measure that face".into());
    }
    let mut stored = op.clone();
    if let Op::Extrude { up_to, .. } = &mut stored {
        *up_to = Some(FacePick::Ref(found));
    }
    Ok(Resolved {
        op: stored,
        picks: vec![found.index],
    })
}

/// K4. The face `pick` names on `from`: the index when its centre and area still agree, else the one that matches them.
pub(super) fn resolve_one_face(from: &mut Shape, pick: FacePick) -> Result<FaceRef, String> {
    let found = match pick {
        FacePick::Index(index) => from.face(index),
        FacePick::Ref(want) => match from.face(want.index) {
            Some(have) if same_face(&have, &want) => Some(have),
            _ => from.find_face(&want)?,
        },
    };
    let found = found.ok_or_else(|| "That face is not on this solid.".to_string())?;
    if !found.mid.iter().all(|value| value.is_finite()) || !found.area_mm2.is_finite() {
        return Err("Open CASCADE could not measure that face".into());
    }
    Ok(found)
}

fn resolve_face_extrude(
    from: &mut Shape,
    face: FacePick,
    distance: f64,
    draft_deg: f64,
    up_to: Option<FacePick>,
) -> Result<Resolved, String> {
    if !distance.is_finite() || distance.abs() <= 1e-6 {
        return Err("A face extrude needs a distance other than 0.".into());
    }
    if !draft_deg.is_finite() || !(-89.0..=89.0).contains(&draft_deg) {
        return Err("The draft angle must be between -89 and 89 degrees.".into());
    }
    let found = resolve_one_face(from, face)?;
    let mut picks = vec![found.index];
    let up_to = match up_to {
        Some(pick) => {
            let until = resolve_one_face(from, pick)?;
            if until.index == found.index {
                return Err("A face cannot stop at itself.".into());
            }
            picks.push(until.index);
            Some(FacePick::Ref(until))
        }
        None => None,
    };
    Ok(Resolved {
        op: Op::FaceExtrude {
            face: FacePick::Ref(found),
            distance,
            draft_deg,
            up_to,
        },
        picks,
    })
}

fn resolve_move_faces(from: &mut Shape, faces: &[FaceMove]) -> Result<Resolved, String> {
    if faces.is_empty() {
        return Err("Pick a face to move.".into());
    }
    // The last distance for a face wins. The order is the order the faces were first named.
    let mut order: Vec<c_int> = Vec::new();
    let mut kept: Vec<(FaceRef, f64)> = Vec::new();
    for row in faces {
        if !row.distance.is_finite() || row.distance.abs() <= 1e-6 {
            return Err("A face move needs a distance other than 0.".into());
        }
        let found = resolve_one_face(from, row.face)?;
        if let Some(at) = order.iter().position(|index| *index == found.index) {
            kept[at] = (found, row.distance);
        } else {
            order.push(found.index);
            kept.push((found, row.distance));
        }
    }
    let picks: Vec<c_int> = kept.iter().map(|(face, _)| face.index).collect();
    let faces = kept
        .into_iter()
        .map(|(face, distance)| FaceMove {
            face: FacePick::Ref(face),
            distance,
        })
        .collect();
    Ok(Resolved {
        op: Op::MoveFaces { faces },
        picks,
    })
}
