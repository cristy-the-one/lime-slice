use super::*;

/// The direction rows run in a solid island on a layer. Every row ends in a
/// turn, and Klipper takes a turn at the speed its junction deviation allows,
/// about 5 mm/s for a corner, so the fewest rows is the fastest fill. The
/// island is tried along the X axis, at 45 degrees, and along its longest
/// extent, and takes the pair of directions (a layer and the next, a quarter
/// turn apart) with the fewest rows: another direction must beat an axis by
/// a twentieth to be used. Layers alternate between the two, so no layer's
/// lines run along the last one's.
pub(super) fn solid_row_angle(island: &[Loop], spacing: f64, layer_index: usize) -> f64 {
    use std::f64::consts::{FRAC_PI_2, FRAC_PI_4};
    let rows = |angle: f64| -> usize {
        [angle, angle + FRAC_PI_2]
            .into_iter()
            .map(|a| {
                horizontal_chords(&rotate_loops(island, -a), spacing, None)
                    .iter()
                    .map(|(_, spans)| spans.len())
                    .sum::<usize>()
            })
            .sum()
    };
    let (mut angle, mut fewest) = (0.0, rows(0.0));
    for candidate in [FRAC_PI_4, long_axis(island)] {
        let count = rows(candidate);
        if (count as f64) < fewest as f64 * 0.95 {
            (angle, fewest) = (candidate, count);
        }
    }
    if layer_index % 2 == 0 {
        angle
    } else {
        angle + FRAC_PI_2
    }
}

/// The direction of the island's longest extent: the turn of its bounding
/// box that is narrowest across, in steps of three degrees.
pub(super) fn long_axis(island: &[Loop]) -> f64 {
    let mut best = (f64::MAX, 0.0);
    for k in 0..60 {
        let angle = std::f64::consts::PI * k as f64 / 60.0;
        if let Some((lo, hi)) = loop_bounds(&rotate_loops(island, -angle)) {
            if hi[1] - lo[1] < best.0 - 1e-9 {
                best = (hi[1] - lo[1], angle);
            }
        }
    }
    best.1
}

/// Rows shorter than this end before the head reaches its feed, and each
/// turn costs about as much as the row.
pub(super) const SOLID_ROW_MM: f64 = 10.0;

/// Solid rows over `loops`, at `base` where they run long. A stretch only a
/// few beads wide, like the wall of a cover, would take a turn every few
/// millimetres at `base`, so it prints along its length: the longest edges of
/// the region name those directions, and each takes the rows of at least
/// `SOLID_ROW_MM` it finds in what the last left. Rows that all run long
/// print as one region at `base`.
pub(super) fn solid_rows(loops: &[Loop], spacing: f64, base: f64) -> Vec<Vec<[f64; 2]>> {
    let mut rest = loops.to_vec();
    let mut paths = Vec::new();
    for angle in std::iter::once(base).chain(long_edge_angles(loops, base)) {
        let chords = horizontal_chords(&rotate_loops(&rest, -angle), spacing, None);
        let (mut long, mut short) = (0.0, 0.0);
        for (x0, x1) in chords.iter().flat_map(|(_, spans)| spans) {
            if x1 - x0 >= SOLID_ROW_MM {
                long += x1 - x0;
            } else {
                short += x1 - x0;
            }
        }
        if long == 0.0 {
            continue;
        }
        if short == 0.0 {
            let (pitch, through) = fit_bounds(&rest, angle, spacing);
            paths.extend(clip_infill(solid_fill(&rest, pitch, angle, through), &rest));
            return paths;
        }
        let half = spacing * 0.5;
        let mut rows = Vec::new();
        for (y, spans) in &chords {
            for &(x0, x1) in spans.iter().filter(|(x0, x1)| x1 - x0 >= SOLID_ROW_MM) {
                rows.push(
                    [
                        [x0, y - half],
                        [x1, y - half],
                        [x1, y + half],
                        [x0, y + half],
                    ]
                    .map(|p| rot(p, angle))
                    .to_vec(),
                );
            }
        }
        // Grown by a row, so the bare edge a stretch's rows leave is its own.
        let taken = boolean_intersect(&offset_loops(&resolve_nonzero(rows), spacing), &rest);
        let whole = rest.clone();
        rest = drop_slivers(boolean_diff(&rest, &taken), SKIN_SLIVER_MM2);
        for piece in island_loops(&taken) {
            let (pitch, through) = fit_rows(&piece, &whole, angle, spacing);
            paths.extend(clip_infill(
                solid_fill(&piece, pitch, angle, through),
                &piece,
            ));
        }
    }
    if !rest.is_empty() {
        let (pitch, through) = fit_bounds(&rest, base, spacing);
        paths.extend(clip_infill(solid_fill(&rest, pitch, base, through), &rest));
    }
    paths
}

/// Row pitch and grid for rows at `angle` over `loops`: a whole number of rows
/// laid edge to edge across the region's extent, so the far edge is not left
/// bare by the part of a row that did not fit. The pitch stays within a half row
/// of `spacing` over the rows' count.
pub(super) fn fit_bounds(loops: &[Loop], angle: f64, spacing: f64) -> (f64, Option<[f64; 2]>) {
    let Some((lo, hi)) = loop_bounds(&rotate_loops(loops, -angle)) else {
        return (spacing, None);
    };
    let height = hi[1] - lo[1];
    let rows = (height / spacing).round().max(1.0);
    let pitch = height / rows;
    (pitch, Some(rot([lo[0], lo[1] + pitch * 0.5], angle)))
}

/// A solid island nowhere farther than this many beads from its edge is a
/// strip, like the wall of a cover, and prints as beads along its edge.
pub(super) const STRIP_REACH_BEADS: f64 = 3.0;

/// The widest a single bead may be down the middle of a strip, in line
/// widths. Wider than that takes two.
pub(super) const STRIP_BEAD_MAX: f64 = 1.5;

/// Fills each strip of `region` with beads along its edge and returns the
/// rest, for rows. A strip takes loops a half bead in from its edge and then
/// a bead apiece, so a band round a part is a few closed loops that bend with
/// it, straight sides and corners alike. Loops stop where two beads from
/// opposite sides would overlap; what lies between them is one bead down the
/// middle, or two when it is wider than one bead can be, each as wide as the
/// strip there. So a strip is filled to its area, and a sliver the beads
/// leave narrower than the narrowest bead, a hairline at a corner or a
/// pinch, is no bead's and goes to `hairlines`, so the gap fill does not
/// cross the layer to a corner for it. A band joined to ribs and bosses is
/// split from them first (see `split_strips`): its strips take loops, and the
/// wide parts they meet go to rows, edge to edge. With no strip, the rest is
/// `region` itself.
pub(super) fn fill_strips(
    paths: &mut Vec<Extrusion>,
    region: &[Loop],
    strategy: &ResolvedStrategy,
    line_width: f64,
    seam_hint: &mut [f64; 2],
    hairlines: &mut Vec<Loop>,
) -> Vec<Loop> {
    let kind = infill_kind(strategy, ShellBand::Bottom);
    let mut rest: Vec<Loop> = Vec::new();
    let mut found = false;
    for island in island_loops(region) {
        let (strip, wide) = split_strips(&island, line_width);
        rest.extend(wide);
        if strip.is_empty() {
            continue;
        }
        found = true;
        let first = paths.len();
        let mut core = paths_from_loops(&strip);
        loop {
            let deeper = offset_paths(&core, -line_width);
            if loops_from_paths(deeper.clone()).is_empty() {
                break;
            }
            let loops = loops_from_paths(offset_paths(&core, -line_width * 0.5));
            push_rings(paths, loops, kind, strategy, line_width, seam_hint);
            core = deeper;
        }
        let cover = bead_cover(&paths[first..]);
        let left = if cover.is_empty() {
            strip.clone()
        } else {
            drop_slivers(boolean_diff(&strip, &cover), SKIN_SLIVER_MM2)
        };
        for piece in island_loops(&left) {
            fill_between(paths, &piece, kind, strategy, line_width, seam_hint);
        }
        let cover = bead_cover(&paths[first..]);
        let bare = if cover.is_empty() {
            strip
        } else {
            drop_slivers(boolean_diff(&strip, &cover), SKIN_SLIVER_MM2)
        };
        hairlines.extend(
            island_loops(&bare)
                .into_iter()
                .filter(|piece| mean_width(piece) < min_bead(line_width))
                .flatten(),
        );
    }
    if found {
        rest
    } else {
        region.to_vec()
    }
}

/// `island` split into the strips that print as loops and the wide part that
/// prints as rows, in that order. A strip is nowhere farther than
/// `STRIP_REACH_BEADS` from the island's edge, so the wide part is what an
/// opening by that reach keeps: the island eroded by it and grown back. The
/// rest is a strip when it is at least a bead wide and larger than a square
/// of that reach; anything smaller, such as the crescent an opening leaves
/// along a round boss, stays with the wide part. The two pieces share their
/// edge, with no gap and no overlap. An island with no wide part is one strip,
/// and one with no strip is all wide.
pub(super) fn split_strips(island: &[Loop], line_width: f64) -> (Vec<Loop>, Vec<Loop>) {
    let reach = line_width * STRIP_REACH_BEADS;
    let core = offset_loops(island, -reach);
    if core.is_empty() {
        return (island.to_vec(), Vec::new());
    }
    let opened = boolean_intersect(&offset_loops(&core, reach), island);
    let strip: Vec<Loop> = island_loops(&boolean_diff(island, &opened))
        .into_iter()
        .filter(|piece| mean_width(piece) >= line_width && net_area(piece) >= reach * reach)
        .flatten()
        .collect();
    if strip.is_empty() {
        return (Vec::new(), island.to_vec());
    }
    let wide = drop_slivers(boolean_diff(island, &strip), SKIN_SLIVER_MM2);
    (strip, wide)
}

/// How wide `piece`, an outline with its holes, is on average.
pub(super) fn mean_width(piece: &[Loop]) -> f64 {
    let perimeter: f64 = piece.iter().map(closed_len).sum();
    2.0 * net_area(piece) / perimeter.max(1e-9)
}

/// The bead or two that fill `piece`, a strip no wider than two beads, to its
/// mean width. A piece too narrow for the narrowest bead or wider than two
/// beads is left.
pub(super) fn fill_between(
    paths: &mut Vec<Extrusion>,
    piece: &[Loop],
    kind: PathKind,
    strategy: &ResolvedStrategy,
    line_width: f64,
    seam_hint: &mut [f64; 2],
) {
    let width = mean_width(piece);
    if width < min_bead(line_width) || width > line_width * 2.0 {
        return;
    }
    if width > line_width * STRIP_BEAD_MAX {
        let loops = offset_loops(piece, -width * 0.25);
        push_rings(paths, loops, kind, strategy, width * 0.5, seam_hint);
        return;
    }
    let spine = match piece {
        [outline] => sliver_spine(outline, line_width).map(|s| thin_polyline(&s, 0.02)),
        _ => ring_spine(piece),
    };
    if let Some(spine) = spine {
        *seam_hint = *spine.last().unwrap();
        paths.push(extrusion(kind, strategy, spine, width));
    }
}

/// `loops` as closed beads `width` wide, nearest first from `seam_hint`, each
/// starting at the vertex nearest the last.
pub(super) fn push_rings(
    paths: &mut Vec<Extrusion>,
    mut loops: Vec<Loop>,
    kind: PathKind,
    strategy: &ResolvedStrategy,
    width: f64,
    seam_hint: &mut [f64; 2],
) {
    loops.retain(|l| l.len() >= 3);
    while !loops.is_empty() {
        let (k, v, _) = loops
            .iter()
            .enumerate()
            .flat_map(|(k, ring)| {
                let at = *seam_hint;
                ring.iter()
                    .enumerate()
                    .map(move |(v, p)| (k, v, dist2(*p, at)))
            })
            .min_by(|a, b| a.2.total_cmp(&b.2))
            .unwrap();
        let ring = loops.swap_remove(k);
        let mut pts: Vec<[f64; 2]> = ring[v..].iter().chain(&ring[..v]).copied().collect();
        pts.push(pts[0]);
        *seam_hint = pts[0];
        paths.push(extrusion(kind, strategy, pts, width));
    }
}

/// `pts` without the vertices that lie within `tol` of the line between the
/// last one kept and the next.
pub(super) fn thin_polyline(pts: &[[f64; 2]], tol: f64) -> Vec<[f64; 2]> {
    let mut out = vec![pts[0]];
    for (p, next) in pts.iter().zip(&pts[1..]).skip(1) {
        if point_seg_dist(*p, *out.last().unwrap(), *next) > tol {
            out.push(*p);
        }
    }
    out.push(*pts.last().unwrap());
    out
}

/// Row pitch and grid for a stretch `piece` of `region` that runs along
/// `angle`. A stretch only a few beads wide takes a whole number of rows, laid
/// edge to edge, so it has no bare edge. Wider ones keep `spacing`.
pub(super) fn fit_rows(
    piece: &[Loop],
    region: &[Loop],
    angle: f64,
    spacing: f64,
) -> (f64, Option<[f64; 2]>) {
    let Some((lo, hi)) = loop_bounds(&rotate_loops(piece, -angle)) else {
        return (spacing, None);
    };
    // Across the stretch at its middle: a scan line square to the rows.
    let across = angle + std::f64::consts::FRAC_PI_2;
    let at = (lo[0] + hi[0]) * 0.5;
    let line = horizontal_chords(&rotate_loops(region, -across), 1e9, Some(-at));
    let mid = (lo[1] + hi[1]) * 0.5;
    let Some(&(a, b)) = line
        .iter()
        .flat_map(|(_, spans)| spans)
        .find(|(a, b)| *a <= mid && mid <= *b)
    else {
        return (spacing, None);
    };
    let width = b - a;
    if width >= spacing * 6.0 {
        return (spacing, None);
    }
    let pitch = width / (width / spacing).round().max(1.0);
    (pitch, Some(rot([at, a + pitch * 0.5], angle)))
}

/// Directions of the longest edges of `loops`, at most two, each at least 20
/// degrees from `base` and from each other.
pub(super) fn long_edge_angles(loops: &[Loop], base: f64) -> Vec<f64> {
    use std::f64::consts::PI;
    let mut edges: Vec<(f64, f64)> = loops
        .iter()
        .flat_map(|l| l.iter().zip(l.iter().cycle().skip(1)))
        .map(|(a, b)| {
            let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
            (dx.hypot(dy), dy.atan2(dx).rem_euclid(PI))
        })
        .collect();
    edges.sort_by(|a, b| b.0.total_cmp(&a.0));
    let apart = |a: f64, b: f64| {
        let d = (a - b).rem_euclid(PI);
        d.min(PI - d) >= 20f64.to_radians()
    };
    let mut found: Vec<f64> = Vec::new();
    for (_, angle) in edges {
        if apart(angle, base) && found.iter().all(|f| apart(angle, *f)) {
            found.push(angle);
            if found.len() == 2 {
                break;
            }
        }
    }
    found
}

/// Solid rectilinear in scan order. Alternate rows flip so the next chord
/// starts beside the previous end, and that short link is extruded when it
/// stays inside the region. Rows run at `angle`; one passes through `through`
/// when given, else the first sits half a spacing inside the bounds.
pub(super) fn solid_fill(
    loops: &[Loop],
    spacing: f64,
    angle: f64,
    through: Option<[f64; 2]>,
) -> Vec<Vec<[f64; 2]>> {
    let sample = crate::inner_prof::Sample::start();
    let outline = Outline::new(loops);
    let rotated = rotate_loops(loops, -angle);
    let chords = horizontal_chords(&rotated, spacing, through.map(|p| rot(p, -angle)[1]));
    let mut paths: Vec<Vec<[f64; 2]>> = Vec::new();
    let mut flip = false;
    for (y, spans) in &chords {
        let mut row: Vec<Vec<[f64; 2]>> = spans
            .iter()
            .map(|(x0, x1)| vec![rot([*x0, *y], angle), rot([*x1, *y], angle)])
            .collect();
        if flip {
            for seg in &mut row {
                seg.reverse();
            }
            row.reverse();
        }
        for seg in row {
            let link = paths.last().and_then(|path| {
                let end = *path.last().unwrap();
                let gap = dist2(end, seg[0]).sqrt();
                if gap <= spacing * 1.75 && (gap < 1e-4 || outline.link_stays(end, seg[0])) {
                    Some(gap)
                } else {
                    None
                }
            });
            if link.is_some() {
                let path = paths.last_mut().unwrap();
                if link.unwrap() >= 1e-4 {
                    path.push(seg[0]);
                }
                path.extend(seg.into_iter().skip(1));
            } else {
                paths.push(seg);
            }
        }
        flip = !flip;
    }
    sample.solid();
    paths
}

/// Ordered bits of a finite `f64`, so a `BTreeSet` sorts them numerically.
pub(super) fn ord_f64(v: f64) -> u64 {
    let bits = v.to_bits();
    if bits & (1 << 63) != 0 {
        !bits
    } else {
        bits | (1 << 63)
    }
}

/// Append `seg` to the open path when the short join stays inside `outline`.
pub(super) fn append_linked(
    paths: &mut Vec<Vec<[f64; 2]>>,
    seg: Vec<[f64; 2]>,
    outline: &Outline,
    spacing: f64,
) {
    let link = paths.last().and_then(|path| {
        let end = *path.last().unwrap();
        let gap = dist2(end, seg[0]).sqrt();
        if gap <= spacing * 1.75 && (gap < 1e-4 || outline.link_stays(end, seg[0])) {
            Some(gap)
        } else {
            None
        }
    });
    if let Some(gap) = link {
        let path = paths.last_mut().unwrap();
        if gap >= 1e-4 {
            path.push(seg[0]);
        }
        path.extend(seg.into_iter().skip(1));
    } else {
        paths.push(seg);
    }
}

/// The same chords as [`solid_fill`], every one running from low X to high X
/// in the rotated frame. A chord waits until each overlapping chord on the
/// previous scanline is done, so the fill only steps from -Y to +Y.
pub(super) fn monotonic_fill(
    loops: &[Loop],
    spacing: f64,
    angle: f64,
    through: Option<[f64; 2]>,
) -> Vec<Vec<[f64; 2]>> {
    let sample = crate::inner_prof::Sample::start();
    let outline = Outline::new(loops);
    let rotated = rotate_loops(loops, -angle);
    let anchor = through.map(|p| rot(p, -angle)[1]);
    let chords = horizontal_chords(&rotated, spacing, anchor);
    struct Seg {
        y: f64,
        x0: f64,
        x1: f64,
    }
    let mut segs: Vec<Seg> = Vec::new();
    let mut rows: Vec<std::ops::Range<usize>> = Vec::new();
    for (y, spans) in &chords {
        let start = segs.len();
        for &(x0, x1) in spans {
            segs.push(Seg { y: *y, x0, x1 });
        }
        if segs.len() > start {
            rows.push(start..segs.len());
        }
    }
    if segs.is_empty() {
        sample.solid();
        return Vec::new();
    }
    let mut next: Vec<Vec<usize>> = vec![Vec::new(); segs.len()];
    let mut incoming = vec![0u32; segs.len()];
    let mut row_of = vec![0usize; segs.len()];
    for (r, span) in rows.iter().enumerate() {
        for slot in &mut row_of[span.start..span.end] {
            *slot = r;
        }
    }
    for r in 1..rows.len() {
        let prev = rows[r - 1].start..rows[r - 1].end;
        let here = rows[r].start..rows[r].end;
        for i in here {
            for j in prev.clone() {
                let overlap = segs[i].x0.max(segs[j].x0);
                let end = segs[i].x1.min(segs[j].x1);
                if end - overlap > 1e-3 {
                    next[j].push(i);
                    incoming[i] += 1;
                }
            }
        }
    }
    let key = |i: usize| (row_of[i], ord_f64(segs[i].x0), i);
    let mut ready: BTreeSet<(usize, u64, usize)> = BTreeSet::new();
    for (i, count) in incoming.iter().enumerate() {
        if *count == 0 {
            ready.insert(key(i));
        }
    }
    let mut order = Vec::with_capacity(segs.len());
    let mut taken = vec![false; segs.len()];
    while let Some((_, _, i)) = ready.pop_first() {
        order.push(i);
        taken[i] = true;
        for &k in &next[i] {
            incoming[k] -= 1;
            if incoming[k] == 0 {
                ready.insert(key(k));
            }
        }
    }
    if order.len() != segs.len() {
        for (i, seen) in taken.iter().enumerate() {
            if !seen {
                order.push(i);
            }
        }
    }
    let mut paths = Vec::new();
    for i in order {
        let seg = &segs[i];
        let chord = vec![rot([seg.x0, seg.y], angle), rot([seg.x1, seg.y], angle)];
        append_linked(&mut paths, chord, &outline, spacing);
    }
    sample.solid();
    paths
}

#[cfg(test)]
mod solid_row_tests {
    use super::*;
    use crate::strategy::{pure, StrategyId};
    use std::f64::consts::{FRAC_PI_2, FRAC_PI_4};

    fn rectangle(w: f64, h: f64) -> Vec<Loop> {
        vec![vec![[0.0, 0.0], [w, 0.0], [w, h], [0.0, h]]]
    }

    #[test]
    fn an_axis_aligned_island_alternates_between_the_axes() {
        // The two directions cost the same rows whichever layer has which, so
        // even layers take the X axis.
        for island in [rectangle(30.0, 10.0), rectangle(10.0, 30.0)] {
            assert_eq!(solid_row_angle(&island, 0.45, 0), 0.0);
            assert_eq!(solid_row_angle(&island, 0.45, 1), FRAC_PI_2);
        }
    }

    #[test]
    fn a_diagonal_island_keeps_the_diagonal() {
        let diagonal: Vec<Loop> = rectangle(30.0, 10.0)
            .iter()
            .map(|l| l.iter().map(|&p| rot(p, FRAC_PI_4)).collect())
            .collect();
        assert_eq!(solid_row_angle(&diagonal, 0.45, 0), FRAC_PI_4);
        assert_eq!(solid_row_angle(&diagonal, 0.45, 1), FRAC_PI_4 + FRAC_PI_2);
    }

    #[test]
    fn a_solid_square_has_no_bare_edge_and_the_plastic_of_its_area() {
        let (lw, side) = (0.45, 18.2);
        let mut strategy = pure(StrategyId::Toughness);
        strategy.infill_density = 1.0;
        let features = PathFeatures {
            z: 0.1,
            layer_index: 0,
            ..PathFeatures::default()
        };
        let paths = build_infill(&rectangle(side, side), &strategy, lw, &features);
        // Rows run along X, 40 of them at a pitch of 18.2 / 40 = 0.455.
        let rows: Vec<f64> = paths
            .iter()
            .flat_map(|p| p.windows(2))
            .filter(|w| (w[0][1] - w[1][1]).abs() < 1e-9 && (w[0][0] - w[1][0]).abs() > 1.0)
            .map(|w| w[0][1])
            .collect();
        assert_eq!(rows.len(), 40);
        let (lowest, highest) = rows
            .iter()
            .fold((f64::MAX, f64::MIN), |(lo, hi), &y| (lo.min(y), hi.max(y)));
        assert!((lowest - 0.2275).abs() < 1e-9, "first row at {lowest}");
        assert!((highest - 17.9725).abs() < 1e-9, "last row at {highest}");
        let length: f64 = paths.iter().map(|p| polyline_len(p)).sum();
        let share = length * lw / (side * side);
        assert!(
            (0.99..1.03).contains(&share),
            "covers {share:.3} of the square"
        );
    }

    #[test]
    fn a_bottom_skin_runs_its_rows_along_the_island_and_the_next_layer_across() {
        let region = rectangle(30.0, 10.0);
        let strategy = pure(StrategyId::Speed);
        let skin_rows = |layer_index: usize| -> Vec<[[f64; 2]; 2]> {
            let features = PathFeatures {
                z: 0.1 + 0.2 * layer_index as f64,
                layer_index,
                skin: std::sync::Arc::new(Skin {
                    bottom: vec![vec![[-5.0, -5.0], [35.0, -5.0], [35.0, 15.0], [-5.0, 15.0]]],
                    top: Vec::new(),
                }),
                ..PathFeatures::default()
            };
            let mut hint = [0.0, 0.0];
            plan_region(&region, &strategy, 0.45, &mut hint, &features)
                .iter()
                .filter(|p| p.kind == PathKind::Solid)
                .flat_map(|p| p.points.windows(2).map(|w| [w[0], w[1]]))
                .collect()
        };
        let along_x = skin_rows(0);
        assert!(along_x.iter().any(|s| (s[0][0] - s[1][0]).abs() > 20.0));
        assert!(along_x.iter().all(|s| (s[0][1] - s[1][1]).abs() < 1.0));
        let along_y = skin_rows(1);
        assert!(along_y.iter().any(|s| (s[0][1] - s[1][1]).abs() > 6.0));
        assert!(along_y.iter().all(|s| (s[0][0] - s[1][0]).abs() < 1.0));
    }

    #[test]
    fn a_strip_over_a_hollow_cell_bridges_across_it() {
        // Inside two walls this leaves a strip 2.4 mm across, under the six
        // beads a sparse cell needs, so void fill takes it.
        let region = rectangle(30.0, 4.2);
        let strategy = pure(StrategyId::Speed);
        let rows = |hollow: Option<Vec<Loop>>| -> Vec<(PathKind, [[f64; 2]; 2])> {
            let features = PathFeatures {
                hollow_below: hollow.map(std::sync::Arc::new),
                ..PathFeatures::default()
            };
            let mut hint = [0.0, 0.0];
            plan_region(&region, &strategy, 0.45, &mut hint, &features)
                .iter()
                .filter(|p| matches!(p.kind, PathKind::GapFill | PathKind::Bridge))
                .flat_map(|p| p.points.windows(2).map(|w| (p.kind, [w[0], w[1]])))
                .collect()
        };
        // On solid ground the rows run along the strip.
        let held = rows(None);
        assert!(held.iter().all(|r| r.0 == PathKind::GapFill));
        assert!(held.iter().any(|r| (r.1[0][0] - r.1[1][0]).abs() > 20.0));
        // Over a cell they bridge across it, wall to wall.
        let over = rows(Some(rectangle(40.0, 10.0)));
        assert!(!over.is_empty());
        assert!(over.iter().all(|r| r.0 == PathKind::Bridge));
        assert!(over.iter().all(|r| hypot2(r.1[0], r.1[1]) < 3.0));
        assert!(over.iter().any(|r| (r.1[0][1] - r.1[1][1]).abs() > 2.0));
    }

    #[test]
    fn a_ring_over_a_hollow_cell_bridges_across_it_in_tiles() {
        // Walls on both sides of a 3 mm frame leave a ring of interior a
        // little over a millimetre wide, under six beads, all the way round.
        let region = vec![
            vec![[0.0, 0.0], [30.0, 0.0], [30.0, 10.0], [0.0, 10.0]],
            vec![[3.0, 3.0], [3.0, 7.0], [27.0, 7.0], [27.0, 3.0]],
        ];
        let strategy = pure(StrategyId::Speed);
        let rows = |hollow: Option<Vec<Loop>>| -> Vec<(PathKind, [[f64; 2]; 2])> {
            let features = PathFeatures {
                hollow_below: hollow.map(std::sync::Arc::new),
                ..PathFeatures::default()
            };
            let mut hint = [0.0, 0.0];
            plan_region(&region, &strategy, 0.45, &mut hint, &features)
                .iter()
                .filter(|p| matches!(p.kind, PathKind::GapFill | PathKind::Bridge))
                .flat_map(|p| p.points.windows(2).map(|w| (p.kind, [w[0], w[1]])))
                .collect()
        };
        // On solid ground the rows run along the ring's sides.
        let held = rows(None);
        assert!(held.iter().any(|r| hypot2(r.1[0], r.1[1]) > 20.0));
        // Over a cell no row runs along it: every one crosses it.
        let over = rows(Some(rectangle(40.0, 20.0)));
        assert!(over.iter().filter(|r| r.0 == PathKind::Bridge).count() > 20);
        assert!(
            over.iter().all(|r| hypot2(r.1[0], r.1[1]) < 3.0),
            "{over:?}"
        );
    }

    fn annulus() -> Vec<Loop> {
        vec![
            vec![[0.0, 0.0], [30.0, 0.0], [30.0, 30.0], [0.0, 30.0]],
            vec![[10.0, 10.0], [10.0, 20.0], [20.0, 20.0], [20.0, 10.0]],
        ]
    }

    /// Long chords in scan order, as (start, end, emission index).
    fn scan_chords(paths: &[Vec<[f64; 2]>], angle: f64) -> Vec<([f64; 2], [f64; 2], usize)> {
        let (s, c) = angle.sin_cos();
        let along = |p: [f64; 2]| p[0] * c + p[1] * s;
        let mut out = Vec::new();
        let mut n = 0usize;
        for path in paths {
            for w in path.windows(2) {
                if (along(w[1]) - along(w[0])).abs() > 2.0 {
                    out.push((w[0], w[1], n));
                    n += 1;
                }
            }
        }
        out
    }

    #[test]
    fn monotonic_chords_share_a_direction_and_step_across_the_scan() {
        let angle = FRAC_PI_4;
        let region = annulus();
        let mono = monotonic_fill(&region, 0.45, angle, None);
        let plain = solid_fill(&region, 0.45, angle, None);
        let (s, c) = angle.sin_cos();
        let along = |p: [f64; 2]| p[0] * c + p[1] * s;
        let across = |p: [f64; 2]| -p[0] * s + p[1] * c;
        let chords = scan_chords(&mono, angle);
        assert!(
            chords.len() > 8,
            "expected several chords, got {}",
            chords.len()
        );
        assert!(
            chords.iter().all(|(a, b, _)| along(*b) > along(*a)),
            "a monotonic chord ran backwards"
        );
        let plain_chords = scan_chords(&plain, angle);
        assert!(
            plain_chords.iter().any(|(a, b, _)| along(*b) < along(*a)),
            "rectilinear should still reverse alternate rows"
        );
        let projected: Vec<(f64, f64, f64, usize)> = chords
            .iter()
            .map(|(a, b, i)| {
                let (x0, x1) = (along(*a), along(*b));
                let y = (across(*a) + across(*b)) * 0.5;
                (x0.min(x1), x0.max(x1), y, *i)
            })
            .collect();
        for (i, a) in projected.iter().enumerate() {
            for b in projected.iter().skip(i + 1) {
                let dy = (a.2 - b.2).abs();
                if !(0.2..0.8).contains(&dy) {
                    continue;
                }
                if a.1.min(b.1) - a.0.max(b.0) < 0.5 {
                    continue;
                }
                if a.2 < b.2 {
                    assert!(a.3 < b.3, "lower scanline {} printed after {}", a.3, b.3);
                } else {
                    assert!(b.3 < a.3, "lower scanline {} printed after {}", b.3, a.3);
                }
            }
        }
    }

    #[test]
    fn concentric_rings_stay_inside_and_step_inward() {
        let region = rectangle(20.0, 20.0);
        let rings = concentric_fill(&region, 0.5);
        assert!(rings.len() >= 4, "got {} rings", rings.len());
        for ring in &rings {
            assert!(dist2(ring[0], *ring.last().unwrap()) < 1e-6, "ring is open");
            for p in ring {
                assert!(
                    (0.0..=20.0).contains(&p[0]) && (0.0..=20.0).contains(&p[1]),
                    "{p:?}"
                );
            }
        }
        let span = |ring: &[[f64; 2]]| {
            let (mut lo, mut hi) = (f64::MAX, f64::MIN);
            for p in ring {
                lo = lo.min(p[0]);
                hi = hi.max(p[0]);
            }
            hi - lo
        };
        assert!(span(&rings[0]) > span(rings.last().unwrap()));
    }

    fn plate() -> Vec<Loop> {
        vec![
            vec![[0.0, 0.0], [30.0, 0.0], [30.0, 30.0], [0.0, 30.0]],
            vec![[12.0, 12.0], [12.0, 18.0], [18.0, 18.0], [18.0, 12.0]],
        ]
    }

    fn wall_x(paths: &[Extrusion], band: impl Fn(f64) -> bool) -> f64 {
        paths
            .iter()
            .filter(|p| matches!(p.kind, PathKind::Outer | PathKind::Wall | PathKind::Inner))
            .flat_map(|p| p.points.iter().map(|q| q[0]))
            .filter(|x| band(*x))
            .fold(f64::MAX, f64::min)
    }

    fn planned(features: PathFeatures) -> Vec<Extrusion> {
        let mut hint = [0.0, 0.0];
        plan_region(
            &plate(),
            &pure(StrategyId::Speed),
            0.45,
            &mut hint,
            &features,
        )
    }

    #[test]
    fn hole_compensation_widens_the_hole_and_contour_compensation_grows_the_part() {
        let plain = planned(PathFeatures::default());
        let hole = planned(PathFeatures {
            xy_hole_mm: 0.4,
            layer_index: 3,
            ..PathFeatures::default()
        });
        let grown = planned(PathFeatures {
            xy_contour_mm: 0.4,
            layer_index: 3,
            ..PathFeatures::default()
        });
        let plain_hole = wall_x(&plain, |x| (8.0..12.0).contains(&x));
        let wide_hole = wall_x(&hole, |x| (8.0..12.0).contains(&x));
        assert!(
            wide_hole < plain_hole - 0.2,
            "hole wall {wide_hole} vs {plain_hole}"
        );
        let plain_outer = wall_x(&plain, |x| x < 2.0);
        let grown_outer = wall_x(&grown, |x| x < 2.0);
        assert!(
            grown_outer < plain_outer - 0.2,
            "outer wall {grown_outer} vs {plain_outer}"
        );
    }

    #[test]
    fn elephants_foot_insets_only_the_first_layer() {
        let plain = wall_x(&planned(PathFeatures::default()), |x| x < 2.0);
        let first = wall_x(
            &planned(PathFeatures {
                elephants_foot_mm: 0.3,
                layer_index: 0,
                ..PathFeatures::default()
            }),
            |x| x < 2.0,
        );
        let later = wall_x(
            &planned(PathFeatures {
                elephants_foot_mm: 0.3,
                layer_index: 2,
                ..PathFeatures::default()
            }),
            |x| x < 2.0,
        );
        assert!(first > plain + 0.15, "first layer {first} vs {plain}");
        assert!(
            (later - plain).abs() < 1e-6,
            "later layer {later} vs {plain}"
        );
    }
}
