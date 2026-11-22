//! Profile v2 (K1): sketches with loops, arcs and holes build on their own path.

use std::os::raw::c_int;

use super::build::{BuildFail, Built};
use super::ffi::{
    lime_tree_extrude_loops,
    lime_tree_extrude_loops_extent,
    lime_tree_loft_loops,
    lime_tree_loft_v2,
    lime_tree_revolve_loops,
    lime_tree_sweep,
};
use super::group::extrude_cells;
use super::ops::{
    BooleanOp,
    Curve3D,
    Curve3DSegment,
    LoftBoundary,
    LoftSection,
    Op,
    ProfileLoop,
    ProfileSegment,
    SweepMode,
    SweepTransition,
};
use super::resolve::Resolved;
use super::shape::Shape;

/// S3: true when a Loft op uses any Loft v2 control (apex, guides, boundary continuity, closed periodic, smoothing, max degree).
pub(super) fn loft_needs_v2(
    sections: &[LoftSection],
    guides: &[Curve3D],
    start_condition: Option<&LoftBoundary>,
    end_condition: Option<&LoftBoundary>,
    closed: bool,
    smoothing: bool,
    max_degree: Option<u8>,
) -> bool {
    sections.iter().any(|s| s.apex.is_some())
        || !guides.is_empty()
        || start_condition.is_some()
        || end_condition.is_some()
        || closed
        || smoothing
        || max_degree.is_some()
}

/// K1. True when an extrude, revolve, or any plain loft section carries loops (Loft v2 handles its own loops).
pub(super) fn k1_has_loops(op: &Op) -> bool {
    match op {
        Op::Extrude { loops, .. } | Op::Revolve { loops, .. } => !loops.is_empty(),
        Op::Loft {
            sections,
            guides,
            start_condition,
            end_condition,
            closed,
            smoothing,
            max_degree,
            ..
        } => {
            !loft_needs_v2(
                sections,
                guides,
                start_condition.as_ref(),
                end_condition.as_ref(),
                *closed,
                *smoothing,
                *max_degree,
            ) && sections.iter().any(|section| !section.loops.is_empty())
        }
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
                ProfileSegment::Nurbs {
                    poles,
                    weights,
                    degree,
                    knots,
                    mults,
                    to,
                } => {
                    out.extend([3.0, to[0], to[1], poles.len() as f64]);
                    for point in poles {
                        out.push(point[0]);
                        out.push(point[1]);
                    }
                    out.push(f64::from(degree.unwrap_or(0)));
                    out.push(weights.len() as f64);
                    out.push(knots.len().min(mults.len()) as f64);
                    out.extend_from_slice(weights);
                    let nk = knots.len().min(mults.len());
                    out.extend_from_slice(&knots[..nk]);
                    for &m in &mults[..nk] {
                        out.push(f64::from(m));
                    }
                }
            }
        }
    }
}

/// --- Organic surfaces S2: encode `Curve3D` for `decode_curve3d` in kernel.cpp.
pub(super) fn encode_curve3d(curve: &Curve3D, resolved_edges: &[c_int], out: &mut Vec<f64>) -> Result<(), String> {
    match curve {
        Curve3D::Polyline { points } => {
            out.extend([0.0, 0.0, points.len() as f64]);
            for p in points {
                out.extend_from_slice(p);
            }
        }
        Curve3D::Spline { points, closed } => {
            out.extend([1.0, if *closed { 1.0 } else { 0.0 }, points.len() as f64]);
            for p in points {
                out.extend_from_slice(p);
            }
        }
        Curve3D::Nurbs {
            poles,
            weights,
            degree,
            knots,
            mults,
            periodic,
        } => {
            let nk = knots.len().min(mults.len());
            out.extend([
                2.0,
                if *periodic { 1.0 } else { 0.0 },
                f64::from(degree.unwrap_or(0)),
                poles.len() as f64,
                weights.len() as f64,
                nk as f64,
            ]);
            for p in poles {
                out.extend_from_slice(p);
            }
            out.extend_from_slice(weights);
            out.extend_from_slice(&knots[..nk]);
            for &m in &mults[..nk] {
                out.push(f64::from(m));
            }
        }
        Curve3D::Segments { start, segments } => {
            out.extend([3.0, 0.0, start[0], start[1], start[2], segments.len() as f64]);
            for seg in segments {
                match seg {
                    Curve3DSegment::Line { to } => {
                        out.extend([0.0, to[0], to[1], to[2], 0.0]);
                    }
                    Curve3DSegment::Arc { through, to } => {
                        out.extend([1.0, to[0], to[1], to[2], 1.0, through[0], through[1], through[2]]);
                    }
                    Curve3DSegment::Spline { through, to } => {
                        out.extend([2.0, to[0], to[1], to[2], through.len() as f64]);
                        for p in through {
                            out.extend_from_slice(p);
                        }
                    }
                    Curve3DSegment::Nurbs {
                        poles,
                        weights,
                        degree,
                        knots,
                        mults,
                        to,
                    } => {
                        let nk = knots.len().min(mults.len());
                        out.extend([3.0, to[0], to[1], to[2], poles.len() as f64]);
                        for p in poles {
                            out.extend_from_slice(p);
                        }
                        out.extend([f64::from(degree.unwrap_or(0)), weights.len() as f64, nk as f64]);
                        out.extend_from_slice(weights);
                        out.extend_from_slice(&knots[..nk]);
                        for &m in &mults[..nk] {
                            out.push(f64::from(m));
                        }
                    }
                }
            }
        }
        Curve3D::Edges { edges } => {
            if resolved_edges.is_empty() && !edges.is_empty() {
                return Err("An edge spine needs an existing solid.".into());
            }
            out.extend([4.0, 0.0, resolved_edges.len() as f64]);
            for &idx in resolved_edges {
                out.push(f64::from(idx));
            }
        }
    }
    Ok(())
}

/// --- Organic surfaces S2: build `Op::Sweep` via `lime_tree_sweep` (standalone when `from` is `None`).
#[allow(clippy::too_many_arguments)]
pub(super) fn build_sweep_shape(
    from: Option<&Shape>,
    which: BooleanOp,
    sections: &[LoftSection],
    spine: &Curve3D,
    mode: Option<SweepMode>,
    transition: Option<SweepTransition>,
    scale: &[[f64; 2]],
    twist_deg: Option<f64>,
    aux_spine: Option<&Curve3D>,
    resolved_edges: &[c_int],
) -> Result<Shape, String> {
    if sections.is_empty() {
        return Err("A sweep needs at least one profile section.".into());
    }
    let shape_note = "smooth and corners are for a point profile. A loop uses arc, spline, and nurbs segments.";
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
            return Err(format!("{prefix}A section takes a radius, a profile, or loops, not more than one."));
        }
        if kinds == 0 {
            return Err(format!("{prefix}A section needs a radius, a profile, or loops."));
        }
        if has_loops && (section.smooth || !section.corners.is_empty()) {
            return Err(format!("{prefix}{shape_note}"));
        }
        head.extend_from_slice(&section.origin);
        head.extend_from_slice(&section.turn);
        head.push(section.radius.unwrap_or(0.0));
        head.push(section.radius_v.unwrap_or(0.0));
        head.push(f64::from(u8::from(section.smooth)));
        head.push(section.profile.len() as f64);
        head.push(section.corners.len() as f64);
        if has_loops {
            loop_at.push(blob.len() as c_int);
            encode_loops(&section.loops, &mut blob);
        } else {
            loop_at.push(-1);
            data.extend(section.profile.iter().flatten().copied());
            data.extend(section.corners.iter().map(|&c| f64::from(c)));
        }
    }
    let mut spine_blob = Vec::new();
    encode_curve3d(spine, resolved_edges, &mut spine_blob)?;
    let mut aux_blob = Vec::new();
    if let Some(aux) = aux_spine {
        encode_curve3d(aux, &[], &mut aux_blob)?;
    }
    let (mode_id, binormal) = match mode.unwrap_or_default() {
        SweepMode::CorrectedFrenet => (0, [0.0, 0.0, 1.0]),
        SweepMode::Frenet => (1, [0.0, 0.0, 1.0]),
        SweepMode::FixedBinormal { dir } => (2, dir),
    };
    let trans_id = match transition.unwrap_or_default() {
        SweepTransition::Round => 0,
        SweepTransition::Right => 1,
        SweepTransition::Transformed => 2,
    };
    let scale_flat: Vec<f64> = scale.iter().flatten().copied().collect();
    let raw_from = from.map_or(std::ptr::null(), Shape::raw);
    Shape::made(|error| unsafe {
        lime_tree_sweep(
            raw_from,
            which.name().as_ptr(),
            head.as_ptr(),
            sections.len() as c_int,
            if data.is_empty() { std::ptr::null() } else { data.as_ptr() },
            if blob.is_empty() { std::ptr::null() } else { blob.as_ptr() },
            blob.len() as c_int,
            loop_at.as_ptr(),
            spine_blob.as_ptr(),
            spine_blob.len() as c_int,
            if aux_blob.is_empty() { std::ptr::null() } else { aux_blob.as_ptr() },
            aux_blob.len() as c_int,
            mode_id,
            binormal.as_ptr(),
            trans_id,
            if scale_flat.is_empty() { std::ptr::null() } else { scale_flat.as_ptr() },
            scale_flat.len() as c_int,
            twist_deg.unwrap_or(0.0),
            error,
        )
    })
}

fn encode_loft_boundary(cond: Option<&LoftBoundary>, out: &mut [f64; 6]) {
    *out = [0.0, 0.0, 0.0, 0.0, 1.0, 1.0];
    match cond {
        None | Some(LoftBoundary::Free) => {}
        Some(LoftBoundary::Normal { tension }) => {
            out[0] = 1.0;
            out[5] = tension.unwrap_or(1.0);
        }
        Some(LoftBoundary::Tangent { dir, tension }) => {
            out[0] = 2.0;
            out[1] = 1.0;
            out[2] = dir[0];
            out[3] = dir[1];
            out[4] = dir[2];
            out[5] = tension.unwrap_or(1.0);
        }
        Some(LoftBoundary::Curvature { dir, tension }) => {
            out[0] = 3.0;
            if let Some(d) = dir {
                out[1] = 1.0;
                out[2] = d[0];
                out[3] = d[1];
                out[4] = d[2];
            }
            out[5] = tension.unwrap_or(1.0);
        }
    }
}

/// --- Organic surfaces S3: controlled Loft v2 (apex caps, guide rails, boundary tangency/curvature, closed periodic, degree cap).
#[allow(clippy::too_many_arguments)]
pub(super) fn build_loft_v2_shape(
    from: Option<&Shape>,
    which: BooleanOp,
    sections: &[LoftSection],
    ruled: bool,
    guides: &[Curve3D],
    start_condition: Option<&LoftBoundary>,
    end_condition: Option<&LoftBoundary>,
    closed: bool,
    smoothing: bool,
    max_degree: Option<u8>,
) -> Result<Shape, String> {
    let mut head = Vec::with_capacity(sections.len() * 11);
    let mut data = Vec::new();
    let mut blob = Vec::new();
    let mut loop_at = Vec::with_capacity(sections.len());
    let mut apex_flags = Vec::with_capacity(sections.len());
    for (index, section) in sections.iter().enumerate() {
        if let Some(apex) = section.apex {
            head.extend_from_slice(&apex);
            head.extend_from_slice(&[0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0]);
            loop_at.push(-1);
            apex_flags.push(1);
            continue;
        }
        let has_radius = section.radius.unwrap_or(0.0) > 0.0;
        let has_profile = !section.profile.is_empty();
        let has_loops = !section.loops.is_empty();
        let kinds = usize::from(has_radius) + usize::from(has_profile) + usize::from(has_loops);
        if kinds != 1 {
            return Err(format!(
                "Section {index}: A section needs exactly one of radius, profile, loops, or apex."
            ));
        }
        head.extend_from_slice(&section.origin);
        head.extend_from_slice(&section.turn);
        head.push(section.radius.unwrap_or(0.0));
        head.push(section.radius_v.unwrap_or(0.0));
        head.push(f64::from(u8::from(section.smooth)));
        head.push(section.profile.len() as f64);
        head.push(section.corners.len() as f64);
        data.extend(section.profile.iter().flatten().copied());
        data.extend(section.corners.iter().map(|&c| f64::from(c)));
        if has_loops {
            loop_at.push(blob.len() as c_int);
            encode_loops(&section.loops, &mut blob);
        } else {
            loop_at.push(-1);
        }
        apex_flags.push(0);
    }
    let mut guides_blob = Vec::new();
    for g in guides {
        encode_curve3d(g, &[], &mut guides_blob)?;
    }
    let mut s_cond = [0.0; 6];
    let mut e_cond = [0.0; 6];
    encode_loft_boundary(start_condition, &mut s_cond);
    encode_loft_boundary(end_condition, &mut e_cond);
    let conds = [
        s_cond[0], s_cond[1], s_cond[2], s_cond[3], s_cond[4], s_cond[5],
        e_cond[0], e_cond[1], e_cond[2], e_cond[3], e_cond[4], e_cond[5],
    ];
    let raw_from = from.map_or(std::ptr::null(), Shape::raw);
    Shape::made(|error| unsafe {
        lime_tree_loft_v2(
            raw_from,
            which.name().as_ptr(),
            head.as_ptr(),
            sections.len() as c_int,
            if data.is_empty() { std::ptr::null() } else { data.as_ptr() },
            if blob.is_empty() { std::ptr::null() } else { blob.as_ptr() },
            blob.len() as c_int,
            loop_at.as_ptr(),
            apex_flags.as_ptr(),
            c_int::from(ruled),
            c_int::from(closed),
            c_int::from(smoothing),
            c_int::from(max_degree.unwrap_or(0)),
            conds.as_ptr(),
            if guides_blob.is_empty() { std::ptr::null() } else { guides_blob.as_ptr() },
            guides_blob.len() as c_int,
            guides.len() as c_int,
            error,
        )
    })
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
            ..
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
