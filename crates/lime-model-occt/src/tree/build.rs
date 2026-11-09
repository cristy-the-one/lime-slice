//! Building one op on a solid: `Built`, `BuildFail` and the `build` match over the op kinds.

use serde_json::{json, Value};
use std::os::raw::c_int;
use std::ptr::NonNull;

use super::{lettering, transition};
use super::ffi::{
    lime_tree_blend,
    lime_tree_boolean,
    lime_tree_chamfer2,
    lime_tree_extrude,
    lime_tree_extrude_extent,
    lime_tree_face_extrude,
    lime_tree_hole,
    lime_tree_join,
    lime_tree_loft,
    lime_tree_move_faces,
    lime_tree_revolve,
    lime_tree_scale,
    lime_tree_shell,
    lime_tree_split,
    lime_tree_unify,
    RawShape,
};
use super::group::{build_combined, build_group};
use super::joints::{joined_of, keep_built, stored_joints, Joined};
use super::k1::{build_k1_loops, k1_has_loops, push_shape};
use super::ops::{Op, Primitive};
use super::outcome::Failure;
use super::partition::{
    partition_max,
    partition_refusal,
    profile_numbers,
    JointCut,
    Labels,
    Numbered,
};
use super::resolve::{chamfer_sides, Resolved, Steps};
use super::shape::Shape;

pub(super) struct Built {
    pub(super) op: Op,
    pub(super) kept: Shape,
    pub(super) other: Option<Shape>,
    /// --- Split to print: pieces 2, 3, ... in partition order. Empty for any other op.
    pub(super) pieces: Vec<Shape>,
    /// --- Split to print: the pins of its placed dowels, one shape, when there are any.
    pub(super) pins: Option<Shape>,
    /// --- Split to print: where each piece's number was cut, in partition order, when part numbers are on.
    pub(super) numbered: Option<Numbered>,
    /// --- Split to print: what became of each connector, when a cut has them on.
    pub(super) joined: Option<Joined>,
    /// Steps of a group whose tool missed the solid. 0 for any other op.
    pub(super) skipped: u32,
    /// A chamfer by two sizes: for each edge, the face its first distance runs along. Empty for any other op.
    pub(super) sides: Vec<Value>,
    /// I19–I20: what a combined group or an extrude of cells did, sent in the reply as it is. None for any other op.
    pub(super) report: Option<(&'static str, Value)>,
}

/// Why `build` refused. `failed_step` is set for a group, counting from 1.
pub(super) struct BuildFail {
    pub(super) message: String,
    pub(super) max_mm: Option<f64>,
    pub(super) failed_step: Option<u32>,
}

impl BuildFail {
    pub(super) fn plain(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            max_mm: None,
            failed_step: None,
        }
    }
}

impl From<BuildFail> for Failure {
    fn from(fail: BuildFail) -> Self {
        match fail.failed_step {
            Some(failed_step) => Failure::GroupFailed {
                message: fail.message,
                failed_step,
            },
            None => Failure::Message(fail.message),
        }
    }
}

/// Another tree's solid, for one join, as the kernel takes it. Sound for the call it was taken in:
/// nothing is evicted before the call ends, a node that holds its solid keeps that same solid for
/// the whole call, a tool is never the tree being built, and a failure drops the map of these
/// before any is used.
#[derive(Clone, Copy)]
pub(super) struct ToolSolid(pub(super) *const RawShape);

/// Run a resolved op on `from`. With `probe`, a fillet or chamfer that does not fit also reports
/// the largest size that does. A join takes its tool's solid in `tool`. `edge_steps` are the edges
/// a blend, including one inside a group, takes from an earlier step.
pub(super) fn build(
    from: &mut Shape,
    resolved: Resolved,
    probe: bool,
    tool: Option<ToolSolid>,
    edge_steps: &Steps,
) -> Result<Built, BuildFail> {
    // K1: loops build on their own path. An empty `loops` stays on the arms below, unchanged.
    if k1_has_loops(&resolved.op) {
        return build_k1_loops(from, resolved);
    }
    let Resolved { op, picks } = resolved;
    // --- A1 group: built here, so the match below stays the single-op arms. ---
    if matches!(op, Op::Group { .. }) {
        let Op::Group { label, source, steps, combine } = op else {
            unreachable!("matched a group");
        };
        if let Some(which) = combine {
            return build_combined(from, label, source, steps, which);
        }
        return build_group(from, label, source, steps, probe, edge_steps);
    }
    let mut other = None;
    let mut pieces = Vec::new();
    let mut numbered = None;
    let mut pins = None;
    let mut joined = None;
    let mut stored: Option<Op> = None;
    let kept = match &op {
        Op::Join {
            op: which,
            relative,
            ..
        } => {
            let Some(ToolSolid(solid)) = tool else {
                return Err(BuildFail::plain("The tool object's solid is missing"));
            };
            let place = relative.rigid().map_err(BuildFail::plain)?;
            // SAFETY: `solid` is a tool tree's held solid, alive for this call (`ToolSolid`).
            Shape::made(|error| unsafe {
                lime_tree_join(
                    from.raw(),
                    solid,
                    which.name().as_ptr(),
                    place.as_ptr(),
                    error,
                )
            })
        }
        // A gear is built in Rust from loops, then meets the solid as a join's tool does, where it already stands.
        Op::Boolean { op: which, tool, .. } if tool.primitive == Primitive::Gear => {
            let gear = Shape::primitive(tool).map_err(BuildFail::plain)?;
            let place = [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0];
            Shape::made(|error| unsafe {
                lime_tree_join(from.raw(), gear.raw(), which.name().as_ptr(), place.as_ptr(), error)
            })
        }
        Op::Boolean {
            op: which,
            tool,
            merge,
        } => {
            let which = which.name();
            let p = tool.numbers();
            Shape::made(|error| unsafe {
                lime_tree_boolean(
                    from.raw(),
                    which.as_ptr(),
                    tool.primitive.name().as_ptr(),
                    p.as_ptr(),
                    c_int::from(*merge),
                    error,
                )
            })
        }
        Op::Hole {
            origin,
            axis,
            radius,
            depth,
            through,
            counterbore_radius,
            counterbore_depth,
        } => {
            let bore = counterbore_radius.is_some() || counterbore_depth.is_some();
            let p = [
                origin[0],
                origin[1],
                origin[2],
                axis[0],
                axis[1],
                axis[2],
                *radius,
                *depth,
                f64::from(u8::from(*through)),
                f64::from(u8::from(bore)),
                counterbore_radius.unwrap_or(0.0),
                counterbore_depth.unwrap_or(0.0),
            ];
            Shape::made(|error| unsafe { lime_tree_hole(from.raw(), p.as_ptr(), error) })
        }
        Op::Split { origin, normal } => {
            let p = [
                origin[0], origin[1], origin[2], normal[0], normal[1], normal[2],
            ];
            let mut piece: *mut RawShape = std::ptr::null_mut();
            let kept = Shape::made(|error| unsafe {
                lime_tree_split(from.raw(), p.as_ptr(), &mut piece, error)
            });
            other = NonNull::new(piece).map(Shape);
            kept
        }
        // --- Split to print. The node keeps the first piece; the rest go to the apply reply.
        Op::Partition {
            cuts,
            up,
            max_pieces,
            numbers,
            ..
        } => {
            if let Some(why) = partition_refusal(cuts) {
                return Err(BuildFail::plain(why));
            }
            let planes: Vec<[f64; 6]> = cuts
                .iter()
                .map(|cut| {
                    let ([x, y, z], [nx, ny, nz]) = (cut.origin, cut.normal);
                    [x, y, z, nx, ny, nz]
                })
                .collect();
            let labels = numbers.as_ref().map(|numbers| Labels { numbers });
            let joints = stored_joints(cuts).map_err(BuildFail::plain)?;
            let (profiles, chains) = profile_numbers(cuts).map_err(BuildFail::plain)?;
            let cut = JointCut {
                us: cuts.iter().map(|cut| cut.u.unwrap_or([0.0; 3])).collect(),
                joints,
                up: up.unwrap_or([0.0, 0.0, 1.0]),
                profiles,
                chains,
            };
            let partitioned = from
                .partition(&planes, labels.as_ref(), &cut)
                .map_err(BuildFail::plain)?;
            let mut made = partitioned.pieces;
            numbered = partitioned.numbered;
            pins = partitioned.pins;
            if !cut.joints.is_empty() {
                let found = joined_of(&cut.joints, &partitioned.answers);
                let mut trimmed = cuts.clone();
                keep_built(&mut trimmed, &found.kept);
                if &trimmed != cuts {
                    let mut stored_op = op.clone();
                    if let Op::Partition { cuts, .. } = &mut stored_op {
                        *cuts = trimmed;
                    }
                    stored = Some(stored_op);
                }
                joined = Some(found);
            }
            let max = partition_max(*max_pieces);
            if made.len() > max {
                return Err(BuildFail::plain(format!(
                    "This cut makes {} pieces. Max pieces is {max}.",
                    made.len()
                )));
            }
            pieces = made.split_off(1);
            made.pop()
                .ok_or_else(|| "The planes did not split this solid".to_string())
        }
        Op::Chamfer {
            size,
            size2,
            angle_deg,
            flip,
            ..
        } if size2.is_some() || angle_deg.is_some() => {
            let (second, mode) = match (size2, angle_deg) {
                (Some(size2), _) => (*size2, 1),
                (None, Some(angle)) => (*angle, 2),
                (None, None) => unreachable!("matched a second size"),
            };
            let sides = chamfer_sides(from, &picks, *flip).map_err(BuildFail::plain)?;
            let faces: Vec<c_int> = sides.iter().map(|(face, _)| *face).collect();
            let built = Shape::made(|error| unsafe {
                lime_tree_chamfer2(
                    from.raw(),
                    picks.as_ptr(),
                    faces.as_ptr(),
                    picks.len() as c_int,
                    *size,
                    second,
                    mode,
                    error,
                )
            });
            let sides = picks
                .iter()
                .zip(&sides)
                .map(|(edge, (face, normal))| json!({ "edge": edge, "face": face, "normal": normal }))
                .collect();
            return match built {
                Ok(kept) => Ok(Built {
                    op,
                    kept,
                    other: None,
                    pieces: Vec::new(),
                    pins: None,
                    numbered: None,
                    joined: None,
                    skipped: 0,
                    sides,
                    report: None,
                }),
                Err(message) => Err(BuildFail::plain(message)),
            };
        }
        // --- Print transitions.
        Op::Transition { .. } => return transition::build(from, op, &picks),
        // --- Text with real fonts.
        Op::Lettering { .. } => return lettering::build(from, op),
        Op::Fillet { size, .. } | Op::Chamfer { size, .. } => {
            let chamfer = matches!(op, Op::Chamfer { .. });
            let indexes = &picks;
            let mut max_mm = 0.0;
            let max_ptr: *mut f64 = if probe {
                &mut max_mm
            } else {
                std::ptr::null_mut()
            };
            let built = Shape::made(|error| unsafe {
                lime_tree_blend(
                    from.raw(),
                    indexes.as_ptr(),
                    indexes.len() as c_int,
                    *size,
                    c_int::from(chamfer),
                    max_ptr,
                    error,
                )
            });
            return match built {
                Ok(kept) => Ok(Built {
                    op,
                    kept,
                    other: None,
                    pieces: Vec::new(),
                    pins: None,
                    numbered: None,
                    joined: None,
                    skipped: 0,
                    sides: Vec::new(),
                    report: None,
                }),
                Err(message) => Err(BuildFail {
                    message,
                    max_mm: probe.then_some(max_mm),
                    failed_step: None,
                }),
            };
        }
        Op::Scale { factor } => {
            Shape::made(|error| unsafe { lime_tree_scale(from.raw(), *factor, error) })
        }
        Op::Unify => Shape::made(|error| unsafe { lime_tree_unify(from.raw(), error) }),
        Op::Root { solid } => Shape::primitive(solid),
        Op::Extrude {
            op: which,
            origin,
            turn,
            profile,
            depth,
            symmetric,
            smooth,
            corners,
            // K3. None of these: the plain extrude, the same call as before. Loops take the path above.
            depth2,
            draft_deg,
            up_to,
            ..
        } => {
            let mut p = vec![
                origin[0],
                origin[1],
                origin[2],
                turn[0],
                turn[1],
                turn[2],
                *depth,
                f64::from(u8::from(*symmetric)),
            ];
            push_shape(&mut p, *smooth, corners);
            let points: Vec<f64> = profile.iter().flatten().copied().collect();
            if depth2.is_none() && draft_deg.is_none() && up_to.is_none() {
                Shape::made(|error| unsafe {
                    lime_tree_extrude(
                        from.raw(),
                        which.name().as_ptr(),
                        p.as_ptr(),
                        points.as_ptr(),
                        profile.len() as c_int,
                        error,
                    )
                })
            } else {
                let face = picks.first().copied().unwrap_or(-1);
                let mut flags = 0;
                if depth2.is_some() {
                    flags |= 1;
                }
                if draft_deg.is_some() {
                    flags |= 2;
                }
                if up_to.is_some() {
                    flags |= 4;
                }
                let depth2 = depth2.unwrap_or(0.0);
                let draft_deg = draft_deg.unwrap_or(0.0);
                Shape::made(|error| unsafe {
                    lime_tree_extrude_extent(
                        from.raw(),
                        which.name().as_ptr(),
                        p.as_ptr(),
                        points.as_ptr(),
                        profile.len() as c_int,
                        depth2,
                        draft_deg,
                        face,
                        flags,
                        error,
                    )
                })
            }
        }
        Op::Revolve {
            op: which,
            origin,
            turn,
            profile,
            axis_origin,
            axis_dir,
            angle_deg,
            smooth,
            corners,
            loops: _,
        } => {
            let [au, av] = axis_origin.unwrap_or([0.0, 0.0]);
            let [du, dv] = axis_dir.unwrap_or([0.0, 1.0]);
            let mut p = vec![
                origin[0],
                origin[1],
                origin[2],
                turn[0],
                turn[1],
                turn[2],
                au,
                av,
                du,
                dv,
                angle_deg.unwrap_or(360.0),
            ];
            push_shape(&mut p, *smooth, corners);
            let points: Vec<f64> = profile.iter().flatten().copied().collect();
            Shape::made(|error| unsafe {
                lime_tree_revolve(
                    from.raw(),
                    which.name().as_ptr(),
                    p.as_ptr(),
                    points.as_ptr(),
                    profile.len() as c_int,
                    error,
                )
            })
        }
        Op::Loft {
            op: which,
            sections,
            ruled,
        } => {
            let mut head = Vec::with_capacity(sections.len() * 11);
            let mut data = Vec::new();
            for section in sections {
                head.extend_from_slice(&section.origin);
                head.extend_from_slice(&section.turn);
                head.push(section.radius.unwrap_or(0.0));
                head.push(section.radius_v.unwrap_or(0.0));
                head.push(f64::from(u8::from(section.smooth)));
                head.push(section.profile.len() as f64);
                head.push(section.corners.len() as f64);
                data.extend(section.profile.iter().flatten().copied());
                data.extend(section.corners.iter().map(|&c| f64::from(c)));
            }
            Shape::made(|error| unsafe {
                lime_tree_loft(
                    from.raw(),
                    which.name().as_ptr(),
                    head.as_ptr(),
                    sections.len() as c_int,
                    data.as_ptr(),
                    c_int::from(*ruled),
                    error,
                )
            })
        }
        Op::Shell { thickness, .. } => Shape::made(|error| unsafe {
            lime_tree_shell(
                from.raw(),
                picks.as_ptr(),
                picks.len() as c_int,
                *thickness,
                error,
            )
        }),
        // Returned above, before this match.
        Op::Group { .. } => unreachable!("a group is built before this match"),
        // K4.
        Op::FaceExtrude {
            distance,
            draft_deg,
            up_to,
            ..
        } => {
            let face = picks.first().copied().unwrap_or(-1);
            let until = if up_to.is_some() {
                picks.get(1).copied().unwrap_or(-1)
            } else {
                -1
            };
            Shape::made(|error| unsafe {
                lime_tree_face_extrude(from.raw(), face, *distance, *draft_deg, until, error)
            })
        }
        Op::MoveFaces { faces } => {
            let distances: Vec<f64> = faces.iter().map(|row| row.distance).collect();
            Shape::made(|error| unsafe {
                lime_tree_move_faces(
                    from.raw(),
                    picks.as_ptr(),
                    distances.as_ptr(),
                    picks.len() as c_int,
                    error,
                )
            })
        }
    };
    match kept {
        Ok(kept) => Ok(Built {
            op: stored.unwrap_or(op),
            kept,
            other,
            pieces,
            pins,
            numbered,
            joined,
            skipped: 0,
            sides: Vec::new(),
            report: None,
        }),
        Err(message) => Err(BuildFail::plain(message)),
    }
}
