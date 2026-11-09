//! `Shape::primitive` and the feature builds on a shape (`feature`, `feature_loops`).

use std::os::raw::c_int;

use super::ffi::{
    lime_tree_feature_extrude,
    lime_tree_feature_extrude_extent,
    lime_tree_feature_extrude_loops,
    lime_tree_feature_extrude_loops_extent,
    lime_tree_feature_loft,
    lime_tree_feature_loft_loops,
    lime_tree_feature_revolve,
    lime_tree_feature_revolve_loops,
    lime_tree_primitive,
};
use super::group::extrude_cells;
use super::k1::{encode_loops, extent_flags, k1_has_loops, push_shape};
use super::gear::build_gear;
use super::ops::{Op, Primitive, Solid};
use super::shape::Shape;

impl Shape {
    pub(super) fn primitive(solid: &Solid) -> Result<Shape, String> {
        if solid.primitive == Primitive::Gear {
            return build_gear(solid);
        }
        let p = solid.numbers();
        Shape::made(|error| unsafe {
            lime_tree_primitive(solid.primitive.name().as_ptr(), p.as_ptr(), error)
        })
    }

    /// K2: an extrude, revolve, or loft with no solid under it. The tool is the solid.
    /// Loops take the K1 builders against that empty solid; a point profile stays on the arms below.
    pub(super) fn feature(op: &Op) -> Result<Shape, String> {
        if k1_has_loops(op) {
            return Self::feature_loops(op);
        }
        match op {
            Op::Extrude {
                op: which,
                origin,
                turn,
                profile,
                depth,
                symmetric,
                smooth,
                corners,
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
                // A plain feature extrude stays the call it was. A second depth or a draft builds the same prism with nothing under it.
                if depth2.is_none() && draft_deg.is_none() && up_to.is_none() {
                    Shape::made(|error| unsafe {
                        lime_tree_feature_extrude(
                            which.name().as_ptr(),
                            p.as_ptr(),
                            points.as_ptr(),
                            profile.len() as c_int,
                            error,
                        )
                    })
                } else {
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
                        lime_tree_feature_extrude_extent(
                            which.name().as_ptr(),
                            p.as_ptr(),
                            points.as_ptr(),
                            profile.len() as c_int,
                            depth2,
                            draft_deg,
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
                    lime_tree_feature_revolve(
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
                    lime_tree_feature_loft(
                        which.name().as_ptr(),
                        head.as_ptr(),
                        sections.len() as c_int,
                        data.as_ptr(),
                        c_int::from(*ruled),
                        error,
                    )
                })
            }
            _ => Err("A new solid starts from an extrude, a revolve, or a loft.".into()),
        }
    }

    /// K1 loops as a feature root: the same checks as `build_k1_loops`, against no solid.
    fn feature_loops(op: &Op) -> Result<Shape, String> {
        let shape_note = "smooth and corners are for a point profile. A loop uses arc and spline segments.";
        let refuse = |message: String| Err(message);
        match op {
            Op::Extrude {
                op: which,
                origin,
                turn,
                profile,
                depth,
                symmetric,
                smooth,
                corners,
                depth2,
                draft_deg,
                up_to,
                loops,
                clip,
                corner_radius,
                min_area,
            } => {
                if !profile.is_empty() {
                    return refuse("Give a profile or loops, not both.".into());
                }
                if *smooth || !corners.is_empty() {
                    return refuse(shape_note.into());
                }
                if !clip.is_empty() || corner_radius.is_some() || min_area.is_some() {
                    return extrude_cells(None, op).map(|(shape, _)| shape);
                }
                let p = [
                    origin[0],
                    origin[1],
                    origin[2],
                    turn[0],
                    turn[1],
                    turn[2],
                    *depth,
                    f64::from(u8::from(*symmetric)),
                ];
                let mut blob = Vec::new();
                encode_loops(loops, &mut blob);
                match extent_flags(*depth2, *draft_deg, up_to.as_ref()) {
                    0 => Shape::made(|error| unsafe {
                        lime_tree_feature_extrude_loops(
                            which.name().as_ptr(),
                            p.as_ptr(),
                            blob.as_ptr(),
                            blob.len() as c_int,
                            error,
                        )
                    }),
                    flags => Shape::made(|error| unsafe {
                        lime_tree_feature_extrude_loops_extent(
                            which.name().as_ptr(),
                            p.as_ptr(),
                            blob.as_ptr(),
                            blob.len() as c_int,
                            depth2.unwrap_or(0.0),
                            draft_deg.unwrap_or(0.0),
                            flags,
                            error,
                        )
                    }),
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
                loops,
            } => {
                if !profile.is_empty() {
                    return refuse("Give a profile or loops, not both.".into());
                }
                if *smooth || !corners.is_empty() {
                    return refuse(shape_note.into());
                }
                let [au, av] = axis_origin.unwrap_or([0.0, 0.0]);
                let [du, dv] = axis_dir.unwrap_or([0.0, 1.0]);
                let p = [
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
                let mut blob = Vec::new();
                encode_loops(loops, &mut blob);
                Shape::made(|error| unsafe {
                    lime_tree_feature_revolve_loops(
                        which.name().as_ptr(),
                        p.as_ptr(),
                        blob.as_ptr(),
                        blob.len() as c_int,
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
                let mut blob = Vec::new();
                let mut loop_at = Vec::with_capacity(sections.len());
                for (index, section) in sections.iter().enumerate() {
                    let has_radius = section.radius.unwrap_or(0.0) > 0.0;
                    let has_profile = !section.profile.is_empty();
                    let has_loops = !section.loops.is_empty();
                    let kinds = usize::from(has_radius) + usize::from(has_profile) + usize::from(has_loops);
                    let prefix = format!("Section {index}: ");
                    if kinds > 1 {
                        return refuse(format!("{prefix}A section takes a radius, a profile, or loops, not more than one."));
                    }
                    if kinds == 0 {
                        return refuse(format!("{prefix}A section needs a radius, a profile, or loops."));
                    }
                    if has_loops && (section.smooth || !section.corners.is_empty()) {
                        return refuse(format!("{prefix}{shape_note}"));
                    }
                    head.extend_from_slice(&section.origin);
                    head.extend_from_slice(&section.turn);
                    head.push(section.radius.unwrap_or(0.0));
                    head.push(section.radius_v.unwrap_or(0.0));
                    head.push(f64::from(u8::from(section.smooth)));
                    head.push(section.profile.len() as f64);
                    head.push(section.corners.len() as f64);
                    data.extend(section.profile.iter().flatten().copied());
                    data.extend(section.corners.iter().map(|&corner| f64::from(corner)));
                    if has_loops {
                        loop_at.push(blob.len() as c_int);
                        encode_loops(&section.loops, &mut blob);
                    } else {
                        loop_at.push(-1);
                    }
                }
                let data_ptr = if data.is_empty() { std::ptr::null() } else { data.as_ptr() };
                let blob_ptr = if blob.is_empty() { std::ptr::null() } else { blob.as_ptr() };
                Shape::made(|error| unsafe {
                    lime_tree_feature_loft_loops(
                        which.name().as_ptr(),
                        head.as_ptr(),
                        sections.len() as c_int,
                        data_ptr,
                        c_int::from(*ruled),
                        loop_at.as_ptr(),
                        blob_ptr,
                        blob.len() as c_int,
                        error,
                    )
                })
            }
            _ => refuse("A new solid starts from an extrude, a revolve, or a loft.".into()),
        }
    }
}
