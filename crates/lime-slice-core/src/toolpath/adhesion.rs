use super::{as_outers, circle, emit_loops, sharp_corners, union_all, Extrusion, PathKind};
use crate::poly::{
    boolean_diff, loops_from_paths, offset_loops, offset_paths, paths_from_loops, signed_area, Loop,
};
use crate::strategy::ResolvedStrategy;

pub fn plan_skirt(
    contours: &[Loop],
    strategy: &ResolvedStrategy,
    line_width: f64,
) -> Vec<Extrusion> {
    let outers: Vec<Loop> = contours
        .iter()
        .filter(|l| signed_area(l) > 0.0)
        .cloned()
        .collect();
    if outers.is_empty() {
        return Vec::new();
    }
    let mut acc = Vec::new();
    let mut hint = [0.0, 0.0];
    for i in 0..strategy.skirt_loops {
        let grown = offset_paths(&paths_from_loops(&outers), line_width * (i as f64 + 1.0));
        let loops = loops_from_paths(grown);
        emit_loops(
            &mut acc,
            &loops,
            PathKind::Skirt,
            strategy,
            line_width,
            &mut hint,
        );
    }
    acc
}

/// Concentric brim loops outside the part and inside its holes.
/// `width_mm` is how far the brim reaches. `gap_mm` is the peel gap.
pub fn plan_brim(
    contours: &[Loop],
    strategy: &ResolvedStrategy,
    line_width: f64,
    width_mm: f64,
    gap_mm: f64,
) -> Vec<Extrusion> {
    if width_mm <= 0.0 || line_width <= 0.0 {
        return Vec::new();
    }
    let outers: Vec<Loop> = contours
        .iter()
        .filter(|l| signed_area(l) > 0.0)
        .cloned()
        .collect();
    let holes: Vec<Loop> = contours
        .iter()
        .filter(|l| signed_area(l) < 0.0)
        .cloned()
        .collect();
    if outers.is_empty() && holes.is_empty() {
        return Vec::new();
    }
    let loops = ((width_mm / line_width).ceil() as u32).clamp(1, 40);
    let mut acc = Vec::new();
    let mut hint = [0.0, 0.0];
    for i in 0..loops {
        let delta = gap_mm.max(0.0) + line_width * (i as f64 + 0.5);
        if !outers.is_empty() {
            let grown = offset_paths(&paths_from_loops(&outers), delta);
            emit_loops(
                &mut acc,
                &loops_from_paths(grown),
                PathKind::Skirt,
                strategy,
                line_width,
                &mut hint,
            );
        }
        if !holes.is_empty() {
            let inner = offset_loops(&as_outers(&holes), -delta);
            let rings: Vec<Loop> = inner.into_iter().filter(|l| signed_area(l) > 0.4).collect();
            emit_loops(
                &mut acc,
                &rings,
                PathKind::Skirt,
                strategy,
                line_width,
                &mut hint,
            );
        }
    }
    acc
}

/// Discs on sharp exterior corners, filled with concentric rings outside the part.
/// `width_mm` is the ear radius, so the disc diameter is twice that.
pub fn plan_mouse_ears(
    contours: &[Loop],
    strategy: &ResolvedStrategy,
    line_width: f64,
    width_mm: f64,
    gap_mm: f64,
) -> Vec<Extrusion> {
    if width_mm <= line_width || line_width <= 0.0 {
        return Vec::new();
    }
    let outers: Vec<Loop> = contours
        .iter()
        .filter(|l| signed_area(l) > 0.0)
        .cloned()
        .collect();
    if outers.is_empty() {
        return Vec::new();
    }
    let corners: Vec<[f64; 2]> = outers.iter().flat_map(sharp_corners).collect();
    if corners.is_empty() {
        return Vec::new();
    }
    let discs: Vec<Loop> = corners
        .iter()
        .map(|center| circle(*center, width_mm, 28))
        .collect();
    let unioned = union_all(&discs);
    let keep_out = offset_loops(&outers, gap_mm.max(0.0));
    let ears = boolean_diff(&unioned, &keep_out);
    let mut acc = Vec::new();
    let mut hint = corners[0];
    let mut region = ears;
    for _ in 0..48 {
        let solid: Vec<Loop> = region
            .into_iter()
            .filter(|l| signed_area(l) > 0.4)
            .collect();
        if solid.is_empty() {
            break;
        }
        let bead = offset_loops(&solid, -line_width * 0.5);
        let rings: Vec<Loop> = bead.into_iter().filter(|l| signed_area(l) > 0.4).collect();
        if rings.is_empty() {
            break;
        }
        emit_loops(
            &mut acc,
            &rings,
            PathKind::Skirt,
            strategy,
            line_width,
            &mut hint,
        );
        region = offset_loops(&solid, -line_width);
    }
    acc
}
