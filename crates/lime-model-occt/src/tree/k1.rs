//! Profile v2 (K1): sketches with loops, arcs and holes build on their own path.

use super::*;

/// K1. True when an extrude, revolve, or any loft section carries loops.
pub(super) fn k1_has_loops(op: &Op) -> bool {
    match op {
        Op::Extrude { loops, .. } | Op::Revolve { loops, .. } => !loops.is_empty(),
        Op::Loft { sections, .. } => sections.iter().any(|section| !section.loops.is_empty()),
        _ => false,
    }
}

/// The blob `decode_profile_loops` reads: loop count, then each loop.
pub(super) fn encode_loops(loops: &[ProfileLoop], out: &mut Vec<f64>) {
    out.push(loops.len() as f64);
    for loop_ in loops {
        out.push(loop_.start[0]);
        out.push(loop_.start[1]);
        out.push(loop_.segments.len() as f64);
        for seg in &loop_.segments {
            match seg {
                ProfileSegment::Line { to } => {
                    out.extend([0.0, to[0], to[1], 0.0]);
                }
                ProfileSegment::Arc { through, to } => {
                    out.extend([1.0, to[0], to[1], 1.0, through[0], through[1]]);
                }
                ProfileSegment::Spline { through, to } => {
                    out.extend([2.0, to[0], to[1], through.len() as f64]);
                    for point in through {
                        out.push(point[0]);
                        out.push(point[1]);
                    }
                }
            }
        }
    }
}

/// K3 bits for the C side: bit 0 a second depth, bit 1 a draft, bit 2 a face to stop at. 0 is a plain extrude.
pub(super) fn extent_flags<T>(depth2: Option<f64>, draft_deg: Option<f64>, up_to: Option<T>) -> c_int {
    c_int::from(depth2.is_some()) | (c_int::from(draft_deg.is_some()) << 1) | (c_int::from(up_to.is_some()) << 2)
}

/// K1 profile v2. Separate from the point-profile arms so those stay as they are.
pub(super) fn build_k1_loops(from: &Shape, resolved: Resolved) -> Result<Built, BuildFail> {
    let Resolved { op, picks } = resolved;
    let shape_note = "smooth and corners are for a point profile. A loop uses arc and spline segments.";
    let kept = match &op {
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
                return Err(BuildFail::plain("Give a profile or loops, not both."));
            }
            if *smooth || !corners.is_empty() {
                return Err(BuildFail::plain(shape_note));
            }
            if !clip.is_empty() || corner_radius.is_some() || min_area.is_some() {
                let (kept, cells) = extrude_cells(Some(from), &op).map_err(BuildFail::plain)?;
                let report = Some(("cells", cells));
                return Ok(Built {
                    op,
                    kept,
                    other: None,
                    pieces: Vec::new(),
                    pins: None,
                    numbered: None,
                    joined: None,
                    skipped: 0,
                    sides: Vec::new(),
                    report,
                });
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
                    lime_tree_extrude_loops(
                        from.raw(),
                        which.name().as_ptr(),
                        p.as_ptr(),
                        blob.as_ptr(),
                        blob.len() as c_int,
                        error,
                    )
                }),
                flags => Shape::made(|error| unsafe {
                    lime_tree_extrude_loops_extent(
                        from.raw(),
                        which.name().as_ptr(),
                        p.as_ptr(),
                        blob.as_ptr(),
                        blob.len() as c_int,
                        depth2.unwrap_or(0.0),
                        draft_deg.unwrap_or(0.0),
                        picks.first().copied().unwrap_or(-1),
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
                return Err(BuildFail::plain("Give a profile or loops, not both."));
            }
            if *smooth || !corners.is_empty() {
                return Err(BuildFail::plain(shape_note));
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
                lime_tree_revolve_loops(
                    from.raw(),
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
                    return Err(BuildFail::plain(format!("{prefix}A section takes a radius, a profile, or loops, not more than one.")));
                }
                if kinds == 0 {
                    return Err(BuildFail::plain(format!("{prefix}A section needs a radius, a profile, or loops.")));
                }
                if has_loops && (section.smooth || !section.corners.is_empty()) {
                    return Err(BuildFail::plain(format!("{prefix}{shape_note}")));
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
            Shape::made(|error| unsafe {
                lime_tree_loft_loops(
                    from.raw(),
                    which.name().as_ptr(),
                    head.as_ptr(),
                    sections.len() as c_int,
                    data_ptr,
                    c_int::from(*ruled),
                    loop_at.as_ptr(),
                    blob.as_ptr(),
                    blob.len() as c_int,
                    error,
                )
            })
        }
        _ => return Err(BuildFail::plain("A profile needs a loop.")),
    };
    match kept {
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
        Err(message) => Err(BuildFail::plain(message)),
    }
}

/// A profile's smooth flag, its corner count, and its corners, after an op's own numbers.
pub(super) fn push_shape(p: &mut Vec<f64>, smooth: bool, corners: &[u32]) {
    p.push(f64::from(u8::from(smooth)));
    p.push(corners.len() as f64);
    p.extend(corners.iter().map(|&c| f64::from(c)));
}
