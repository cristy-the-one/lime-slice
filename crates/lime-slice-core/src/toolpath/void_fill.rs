use super::infill::clip_infill;
use super::island_order::island_loops;
use super::scarf::{point_along, polyline_len};
use super::seams::dist2;
use super::solid_fill::solid_fill;
use super::walls::{fill_remaining, inradius, inradius_until, min_bead};
use super::{extrusion, Extrusion, PathKind};
use crate::poly::{
    boolean_diff, boolean_intersect, drop_slivers, loop_bounds, loops_from_paths, offset_loops,
    paths_from_loops, point_in_loop, principal_axis, signed_area, Loop,
};
use crate::strategy::ResolvedStrategy;
use clipper2::{EndType, FillRule, JoinType, Milli, Paths};
use std::time::Instant;

/// Skin pieces smaller than this are boolean noise along a skin edge, mm².
pub(super) const SKIN_SLIVER_MM2: f64 = 0.05;

/// `area` split into what lies inside `skin` and the rest. A piece of the
/// rest no wider than `narrow` cannot hold a fill of its own and joins the
/// skin, as under a thin fin standing on a roof. An area all inside or all
/// outside keeps its own loops, so a layer that is all skin or has none
/// plans exactly as it did when skin was chosen layer by layer.
pub(super) fn carve(area: &[Loop], skin: &[Loop], narrow: f64) -> (Vec<Loop>, Vec<Loop>) {
    if area.is_empty() || skin.is_empty() {
        return (Vec::new(), area.to_vec());
    }
    let cut = drop_slivers(boolean_diff(area, skin), SKIN_SLIVER_MM2);
    let rest: Vec<Loop> = island_loops(&cut)
        .into_iter()
        .filter(|piece| !offset_loops(piece, -narrow * 0.5).is_empty())
        .flatten()
        .collect();
    if rest.is_empty() {
        return (area.to_vec(), Vec::new());
    }
    let inside = drop_slivers(boolean_diff(area, &rest), SKIN_SLIVER_MM2);
    if inside.is_empty() {
        return (Vec::new(), area.to_vec());
    }
    (inside, rest)
}

pub(super) fn ms_since(started: Instant) -> f64 {
    started.elapsed().as_secs_f64() * 1000.0
}

/// Fill contour area that no bead covers, outside `skip`.
/// A flared wing pinches between perimeters; that leftover used to stay empty.
pub(super) fn emit_void_fill(
    paths: &mut Vec<Extrusion>,
    contours: &[Loop],
    skip: &[Loop],
    strategy: &ResolvedStrategy,
    line_width: f64,
    seam_hint: &mut [f64; 2],
) {
    emit_void_fill_over(paths, contours, skip, &[], strategy, line_width, seam_hint);
}

/// [`emit_void_fill`], with `hollow` the interior over nothing. Where a part
/// closes, its interior narrows past a cell's width in a strip whose rows
/// would run from wall to wall along it, over the cell below. That part of
/// the strip bridges across it instead, so no row spans more than the strip
/// is wide, and the rows above stand on the bridge.
pub(super) fn emit_void_fill_over(
    paths: &mut Vec<Extrusion>,
    contours: &[Loop],
    skip: &[Loop],
    hollow: &[Loop],
    strategy: &ResolvedStrategy,
    line_width: f64,
    seam_hint: &mut [f64; 2],
) {
    let sample = crate::inner_prof::Sample::start();
    let cover_sample = crate::inner_prof::Sample::start();
    let cover = bead_cover(paths);
    cover_sample.void_cover(paths.len() as u64);
    let bool_sample = crate::inner_prof::Sample::start();
    let missed = if cover.is_empty() {
        contours.to_vec()
    } else {
        boolean_diff(contours, &cover)
    };
    let mut voids = boolean_diff(&missed, skip);
    if !hollow.is_empty() {
        let spans: Vec<(Vec<Loop>, f64)> = island_loops(&drop_slivers(
            boolean_intersect(&voids, hollow),
            SKIN_SLIVER_MM2,
        ))
        .into_iter()
        .flat_map(|span| match across_long_strip(&span) {
            Some(across) => vec![(span, across)],
            None => narrow_run_tiles(&span),
        })
        .collect();
        if !spans.is_empty() {
            let cut: Vec<Loop> = spans.iter().flat_map(|(span, _)| span.clone()).collect();
            voids = boolean_diff(&voids, &cut);
            for (span, across) in &spans {
                bridge_void_piece(paths, span, *across, strategy, line_width, seam_hint);
            }
        }
    }
    bool_sample.void_bool();
    let island_sample = crate::inner_prof::Sample::start();
    let regions = island_loops(&voids);
    island_sample.void_island();
    let min_w = min_bead(line_width);
    // A void that reaches the outline is the part's skin there, so it is a wall.
    let core = offset_loops(contours, -line_width * 0.25);
    // One index for every void on this layer. A piece only meets the core
    // loops whose boxes overlap it, so the skin test does not rebuild the
    // whole core for each pocket.
    let mut core_near = OverlapIndex::build(&core);
    // Specks smaller than a square bead are clipping noise.
    let speck = min_w * min_w;
    let reach = line_width * 0.5;
    let mut near_bead: Option<Vec<Loop>> = None;
    // A void is an outline with the holes inside it. A ring-shaped void read
    // loop by loop is two discs, and its fill runs straight across the hole.
    for region in regions {
        let area = net_area(&region);
        if area < speck {
            continue;
        }
        let skin_sample = crate::inner_prof::Sample::start();
        let skin = outside_area(&region, &core, &mut core_near) > 0.01;
        skin_sample.void_skin();
        if !skin && area < 0.25 {
            continue;
        }
        // The fill reads the width only through these steps, so the search
        // stops once they agree at both ends of its bracket.
        let reading = |r: f64| (r >= 0.05, r * 2.0 >= min_w, void_rows(r * 2.0, line_width));
        let radius = inradius_until(&region, 8.0, |lo, hi| reading(lo) == reading(hi));
        // Under 0.1 mm the width probe reads nothing. Skin that thin is
        // where two faces cross, and still needs its bead.
        let width = if radius >= 0.05 {
            radius * 2.0
        } else if skin {
            0.0
        } else {
            continue;
        };
        let kind = if skin {
            PathKind::ThinWall
        } else {
            PathKind::GapFill
        };
        if width >= min_w {
            let rows = void_rows(width, line_width);
            fill_void_piece(paths, &region, rows, kind, strategy, line_width, seam_hint);
        } else if skin {
            // Skin thinner than the narrowest bead: a membrane whose faces
            // meet, or a spike tip past its wall. Where no bead is within
            // reach, dropping it opens a hole through the part, so print one
            // bead down its spine, a little proud of the model. The hairline
            // a wall leaves against a curved outline is within reach and stays.
            let near = near_bead.get_or_insert_with(|| offset_loops(&cover, reach));
            for bare in bare_stretches(&region, near, reach) {
                let spine = match bare.as_slice() {
                    [outline] => sliver_spine(outline, min_w),
                    _ => ring_spine(&bare),
                };
                if let Some(spine) = spine {
                    *seam_hint = *spine.last().unwrap();
                    paths.push(extrusion(kind, strategy, spine, line_width));
                }
            }
        }
    }
    sample.void_fill();
}

#[allow(clippy::too_many_arguments)]
pub(super) fn fill_void_piece(
    paths: &mut Vec<Extrusion>,
    region: &[Loop],
    rows: f64,
    kind: PathKind,
    strategy: &ResolvedStrategy,
    line_width: f64,
    seam_hint: &mut [f64; 2],
) {
    // Rows run along the piece, centered on its centroid, so a pinch one bead
    // wide gets one continuous bead down the middle. Cross chords there are
    // short, and where they land follows the void's bounding box, which a 1 µm
    // move can reshape.
    let Some((center, angle)) = principal_axis(&region[0]) else {
        return;
    };
    let shift = if rows % 2.0 == 0.0 {
        line_width * 0.5
    } else {
        0.0
    };
    let through = [
        center[0] - angle.sin() * shift,
        center[1] + angle.cos() * shift,
    ];
    let hatched = clip_infill(solid_fill(region, line_width, angle, Some(through)), region);
    if hatched.is_empty() {
        let width = inradius(region, 8.0) * 2.0;
        fill_remaining(
            paths,
            &paths_from_loops(region),
            kind,
            strategy,
            line_width * 0.45,
            width.max(line_width),
            seam_hint,
        );
        return;
    }
    for pts in hatched {
        if pts.len() >= 2 {
            *seam_hint = *pts.last().unwrap();
            paths.push(extrusion(kind, strategy, pts, line_width));
        }
    }
}

/// A void piece over nothing whose rows along it would span longer than this
/// bridges across it instead. A shorter row holds over the hollow.
pub(super) const VOID_SPAN_MM: f64 = 5.0;
/// Bridge rows across a void piece no longer than this, a little over the six
/// beads a cell takes, so they stay short.
pub(super) const VOID_BRIDGE_MM: f64 = 3.5;

/// The direction across a void piece that is a long, narrow strip: longer
/// than [`VOID_SPAN_MM`] along its axis and at most [`VOID_BRIDGE_MM`] across.
/// `None` for any other piece, which fills as it did.
pub(super) fn across_long_strip(region: &[Loop]) -> Option<f64> {
    let (_, along) = principal_axis(&region[0])?;
    let extent = |angle: f64| {
        let (c, s) = (angle.cos(), angle.sin());
        let (lo, hi) = region[0]
            .iter()
            .map(|p| p[0] * c + p[1] * s)
            .fold((f64::MAX, f64::MIN), |(lo, hi), d| (lo.min(d), hi.max(d)));
        hi - lo
    };
    let across = along + std::f64::consts::FRAC_PI_2;
    (extent(along) > VOID_SPAN_MM && extent(across) <= VOID_BRIDGE_MM).then_some(across)
}

/// A narrow void piece over nothing that turns is cut into tiles this wide,
/// so no row in a tile spans more than a row that holds over the hollow.
pub(super) const VOID_TILE_MM: f64 = VOID_SPAN_MM;

/// A void piece over nothing that is narrow everywhere and long, but no
/// straight strip: the ring a roof's interior leaves around its top skin, or
/// an L or U where a closing interior turns. Its rows would run along it over
/// the hollow, as far as it goes straight. It is cut into square tiles, and
/// each tile's piece bridges the narrowest way across. Empty for any other
/// piece, which fills as it did.
pub(super) fn narrow_run_tiles(region: &[Loop]) -> Vec<(Vec<Loop>, f64)> {
    let Some((lo, hi)) = loop_bounds(region) else {
        return Vec::new();
    };
    if (hi[0] - lo[0]).max(hi[1] - lo[1]) <= VOID_SPAN_MM
        || !offset_loops(region, -VOID_BRIDGE_MM * 0.5).is_empty()
    {
        return Vec::new();
    }
    let cell = |v: f64| (v / VOID_TILE_MM).floor() as i64;
    let mut out = Vec::new();
    for i in cell(lo[0])..=cell(hi[0]) {
        for j in cell(lo[1])..=cell(hi[1]) {
            let (x0, y0) = (i as f64 * VOID_TILE_MM, j as f64 * VOID_TILE_MM);
            let (x1, y1) = (x0 + VOID_TILE_MM, y0 + VOID_TILE_MM);
            let tile = vec![[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
            let cut = drop_slivers(boolean_intersect(region, &[tile]), SKIN_SLIVER_MM2);
            for piece in island_loops(&cut) {
                let across = narrowest_way(&piece[0]);
                out.push((piece, across));
            }
        }
    }
    out
}

/// The direction, in steps of 15°, along which `ring` is shortest: rows that
/// way are the shortest that cross it.
pub(super) fn narrowest_way(ring: &[[f64; 2]]) -> f64 {
    let extent = |angle: f64| {
        let (c, s) = (angle.cos(), angle.sin());
        let (lo, hi) = ring
            .iter()
            .map(|p| p[0] * c + p[1] * s)
            .fold((f64::MAX, f64::MIN), |(lo, hi), d| (lo.min(d), hi.max(d)));
        hi - lo
    };
    (0..12)
        .map(|k| k as f64 * std::f64::consts::PI / 12.0)
        .min_by(|a, b| extent(*a).total_cmp(&extent(*b)))
        .unwrap_or(0.0)
}

/// Bridge rows at `across` over a void piece over nothing, a bead apart, each
/// from wall to wall across the piece's short way.
pub(super) fn bridge_void_piece(
    paths: &mut Vec<Extrusion>,
    region: &[Loop],
    across: f64,
    strategy: &ResolvedStrategy,
    line_width: f64,
    seam_hint: &mut [f64; 2],
) {
    for pts in clip_infill(solid_fill(region, line_width, across, None), region) {
        if pts.len() >= 2 {
            *seam_hint = *pts.last().unwrap();
            paths.push(extrusion(PathKind::Bridge, strategy, pts, line_width));
        }
    }
}

/// Stretches of `sliver` farther than `reach` from every bead, grown back to
/// full length within the sliver so their bead meets the walls at each end.
/// Each is an outline with its holes.
pub(super) fn bare_stretches(sliver: &[Loop], near_bead: &[Loop], reach: f64) -> Vec<Vec<Loop>> {
    let far = boolean_diff(sliver, near_bead);
    if far.iter().all(|l| signed_area(l).abs() < 1e-4) {
        return Vec::new();
    }
    island_loops(&boolean_intersect(&offset_loops(&far, reach), sliver))
}

/// Closed center line of a sliver that rings a hole: its outline pulled in by
/// half the sliver's mean width.
pub(super) fn ring_spine(ring: &[Loop]) -> Option<Vec<[f64; 2]>> {
    let perimeter: f64 = ring.iter().map(closed_len).sum();
    let half = net_area(ring) / perimeter.max(1e-9);
    let outline = std::slice::from_ref(ring.first()?);
    let mut spine = offset_loops(outline, -half)
        .into_iter()
        .max_by(|a, b| closed_len(a).total_cmp(&closed_len(b)))
        .unwrap_or_else(|| outline[0].clone());
    spine.push(*spine.first()?);
    Some(spine)
}

pub(super) fn closed_len(l: &Loop) -> f64 {
    polyline_len(l)
        + l.first()
            .zip(l.last())
            .map_or(0.0, |(a, b)| dist2(*a, *b).sqrt())
}

/// Area inside an outline and outside its holes.
pub(super) fn net_area(region: &[Loop]) -> f64 {
    region.iter().map(|l| signed_area(l)).sum::<f64>().abs()
}

/// Rows of beads along a void piece `width` across.
pub(super) fn void_rows(width: f64, line_width: f64) -> f64 {
    (width / line_width).round().max(1.0)
}

/// Center line of a sliver: split its outline at its two tips and average the
/// two sides point by point. A straight row would cut the corner of a curved
/// sliver and leave most of it bare.
///
/// A tip is where the outline folds back on itself: a short step either way
/// along it lands on the two faces, one sliver thickness apart. The two points
/// farthest apart are not the tips of a bent sliver. On a V they are one tip
/// and the heel, and averaging the short side with the long way round draws
/// the spine across the gap between the arms.
pub(super) fn sliver_spine(ring: &[[f64; 2]], step: f64) -> Option<Vec<[f64; 2]>> {
    let n = ring.len();
    if n < 3 {
        return None;
    }
    let mut closed = ring.to_vec();
    closed.push(ring[0]);
    let perimeter = polyline_len(&closed);
    let mut at = Vec::with_capacity(n);
    let mut run = 0.0;
    for w in closed.windows(2) {
        at.push(run);
        run += dist2(w[0], w[1]).sqrt();
    }
    let reach = (step * 4.0).min(perimeter / 8.0);
    let on_ring = |s: f64| point_along(&closed, s.rem_euclid(perimeter));
    let fold: Vec<f64> = at
        .iter()
        .map(|&s| dist2(on_ring(s - reach), on_ring(s + reach)))
        .collect();
    let tightest = |allowed: &dyn Fn(usize) -> bool| {
        (0..n)
            .filter(|&k| allowed(k))
            .min_by(|&a, &b| fold[a].total_cmp(&fold[b]).then(a.cmp(&b)))
    };
    let i = tightest(&|_| true)?;
    // The other tip is at least a quarter of the way round, past the tip's own
    // corners.
    let apart = |k: usize| {
        let d = (at[k] - at[i]).abs();
        d.min(perimeter - d) >= perimeter * 0.25
    };
    let j = tightest(&apart)?;
    let walk = |from: usize, to: usize| {
        let mut side = vec![ring[from]];
        let mut k = from;
        while k != to {
            k = (k + 1) % n;
            side.push(ring[k]);
        }
        side
    };
    let a = walk(i, j);
    let mut b = walk(j, i);
    b.reverse();
    let length = polyline_len(&a).max(polyline_len(&b));
    if length < step {
        return None;
    }
    let samples = (length / step).ceil() as usize + 1;
    let (la, lb) = (polyline_len(&a), polyline_len(&b));
    Some(
        (0..samples)
            .map(|k| {
                let t = k as f64 / (samples - 1) as f64;
                let (p, q) = (point_along(&a, la * t), point_along(&b, lb * t));
                [(p[0] + q[0]) * 0.5, (p[1] + q[1]) * 0.5]
            })
            .collect(),
    )
}

/// The interior a sparse layer leaves to its pattern: every part at least six
/// beads across. Void fill takes only what is narrower.
pub(crate) fn void_cells(interior: &[Loop], line_width: f64) -> Vec<Loop> {
    wide_part(interior, line_width * 6.0)
}

/// The part of `region` at least `width` across. The eroded core grows back
/// by sqrt(2) times the erosion, so a right-angle corner stays whole; a sharper
/// corner is a taper tip and stays out.
pub(super) fn wide_part(region: &[Loop], width: f64) -> Vec<Loop> {
    let core = offset_loops(region, -width * 0.5);
    if core.is_empty() {
        return Vec::new();
    }
    boolean_intersect(
        &offset_loops(&core, width * 0.5 * std::f64::consts::SQRT_2),
        region,
    )
}

/// Core loops whose boxes can meet a query box. A loop that misses every
/// cell of the query misses the query, same as scanning every box.
pub(super) struct OverlapIndex {
    cell: f64,
    origin: [f64; 2],
    nx: usize,
    ny: usize,
    /// `None` buckets means the bounds were too wide for a grid, so `hits`
    /// scans `boxes` directly.
    buckets: Option<Vec<Vec<usize>>>,
    boxes: Vec<Option<([f64; 2], [f64; 2])>>,
    seen: Vec<u32>,
    stamp: u32,
}

impl OverlapIndex {
    pub(super) fn build(loops: &[Loop]) -> Self {
        let cell = 8.0;
        let mut boxes = Vec::with_capacity(loops.len());
        let mut lo = [f64::INFINITY; 2];
        let mut hi = [f64::NEG_INFINITY; 2];
        for loop_ in loops {
            let bounds = loop_bounds(std::slice::from_ref(loop_));
            if let Some((a, b)) = bounds {
                lo[0] = lo[0].min(a[0]);
                lo[1] = lo[1].min(a[1]);
                hi[0] = hi[0].max(b[0]);
                hi[1] = hi[1].max(b[1]);
            }
            boxes.push(bounds);
        }
        let n = loops.len();
        if !lo[0].is_finite() {
            return Self {
                cell,
                origin: [0.0; 2],
                nx: 0,
                ny: 0,
                buckets: Some(Vec::new()),
                boxes,
                seen: vec![0; n],
                stamp: 0,
            };
        }
        let nx = (((hi[0] - lo[0]) / cell).floor() as usize).saturating_add(1);
        let ny = (((hi[1] - lo[1]) / cell).floor() as usize).saturating_add(1);
        if nx > 512 || ny > 512 || nx.saturating_mul(ny) > 20_000 {
            return Self {
                cell,
                origin: lo,
                nx: 0,
                ny: 0,
                buckets: None,
                boxes,
                seen: vec![0; n],
                stamp: 0,
            };
        }
        let mut buckets = vec![Vec::new(); nx * ny];
        for (i, bounds) in boxes.iter().enumerate() {
            let Some((a, b)) = bounds else {
                continue;
            };
            let x0 = ((a[0] - lo[0]) / cell).floor() as usize;
            let x1 = ((b[0] - lo[0]) / cell).floor() as usize;
            let y0 = ((a[1] - lo[1]) / cell).floor() as usize;
            let y1 = ((b[1] - lo[1]) / cell).floor() as usize;
            for y in y0..=y1.min(ny - 1) {
                for x in x0..=x1.min(nx - 1) {
                    buckets[y * nx + x].push(i);
                }
            }
        }
        Self {
            cell,
            origin: lo,
            nx,
            ny,
            buckets: Some(buckets),
            boxes,
            seen: vec![0; n],
            stamp: 0,
        }
    }

    /// Clip loops whose box overlaps `min`/`max`, in ascending loop index.
    pub(super) fn hits(&mut self, min: [f64; 2], max: [f64; 2]) -> Vec<usize> {
        self.stamp = self.stamp.wrapping_add(1);
        if self.stamp == 0 {
            self.seen.fill(0);
            self.stamp = 1;
        }
        let stamp = self.stamp;
        let candidates: Vec<usize> = if let Some(buckets) = &self.buckets {
            if self.nx == 0 || buckets.is_empty() {
                Vec::new()
            } else {
                let x0 = (((min[0] - self.origin[0]) / self.cell).floor() as isize)
                    .clamp(0, self.nx as isize - 1) as usize;
                let x1 = (((max[0] - self.origin[0]) / self.cell).floor() as isize)
                    .clamp(0, self.nx as isize - 1) as usize;
                let y0 = (((min[1] - self.origin[1]) / self.cell).floor() as isize)
                    .clamp(0, self.ny as isize - 1) as usize;
                let y1 = (((max[1] - self.origin[1]) / self.cell).floor() as isize)
                    .clamp(0, self.ny as isize - 1) as usize;
                let mut ids = Vec::new();
                for y in y0..=y1 {
                    for x in x0..=x1 {
                        ids.extend_from_slice(&buckets[y * self.nx + x]);
                    }
                }
                ids
            }
        } else {
            (0..self.boxes.len()).collect()
        };
        let mut out = Vec::new();
        for i in candidates {
            let Some((a, b)) = self.boxes[i] else {
                continue;
            };
            if self.seen[i] == stamp {
                continue;
            }
            self.seen[i] = stamp;
            if a[0] <= max[0] && min[0] <= b[0] && a[1] <= max[1] && min[1] <= b[1] {
                out.push(i);
            }
        }
        out.sort_unstable();
        out
    }
}

pub(super) fn edge_box_meets(a: [f64; 2], b: [f64; 2], min: [f64; 2], max: [f64; 2]) -> bool {
    let (ex0, ex1) = if a[0] <= b[0] {
        (a[0], b[0])
    } else {
        (b[0], a[0])
    };
    let (ey0, ey1) = if a[1] <= b[1] {
        (a[1], b[1])
    } else {
        (b[1], a[1])
    };
    ex0 <= max[0] && min[0] <= ex1 && ey0 <= max[1] && min[1] <= ey1
}

/// Area of `piece` outside `clip`. Matches `net_area(boolean_diff(piece, clip))`:
/// a clip loop whose box misses the piece cannot remove any of it, and a piece
/// that meets no clip edge is entirely inside or entirely outside.
pub(super) fn outside_area(piece: &[Loop], clip: &[Loop], index: &mut OverlapIndex) -> f64 {
    let Some((min, max)) = loop_bounds(piece) else {
        return 0.0;
    };
    let hits = index.hits(min, max);
    if hits.is_empty() {
        return net_area(piece);
    }
    let touches = hits.iter().any(|&i| {
        let loop_ = &clip[i];
        let n = loop_.len();
        (0..n).any(|k| edge_box_meets(loop_[k], loop_[(k + 1) % n], min, max))
    });
    if !touches {
        let Some(&p) = piece.iter().find_map(|l| l.first()) else {
            return 0.0;
        };
        let inside = hits
            .iter()
            .filter(|&&i| point_in_loop(&clip[i], p[0], p[1]))
            .count()
            % 2
            == 1;
        return if inside { 0.0 } else { net_area(piece) };
    }
    net_area(&boolean_diff_indexed(piece, clip, &hits))
}

pub(super) fn boolean_diff_indexed(subject: &[Loop], clip: &[Loop], which: &[usize]) -> Vec<Loop> {
    if subject.is_empty() || which.is_empty() {
        return subject.to_vec();
    }
    let raw: Vec<Vec<(f64, f64)>> = which
        .iter()
        .filter_map(|&i| clip.get(i))
        .map(|l| l.iter().map(|p| (p[0], p[1])).collect())
        .collect();
    if raw.is_empty() {
        return subject.to_vec();
    }
    let clip_paths: Paths<Milli> = raw.into();
    match paths_from_loops(subject)
        .to_clipper_subject()
        .add_clip(clip_paths)
        .difference(FillRule::NonZero)
    {
        Ok(paths) => loops_from_paths(paths),
        Err(_) => Vec::new(),
    }
}

pub(crate) fn bead_cover(paths: &[Extrusion]) -> Vec<Loop> {
    let mut acc = Vec::new();
    for path in paths {
        if path.points.len() < 2 || path.width <= 1e-6 {
            continue;
        }
        // Square end-caps stroke the centerline. A polygon offset would fill
        // the loop interior and hide the pinch between walls.
        let raw: Vec<Vec<(f64, f64)>> = vec![path.points.iter().map(|p| (p[0], p[1])).collect()];
        let stroked: Paths<Milli> = raw.into();
        let grown = stroked.inflate(path.width * 0.5, JoinType::Round, EndType::Square, 2.0);
        acc.extend(loops_from_paths(grown));
    }
    union_loops(&acc)
}

pub(super) fn union_loops(loops: &[Loop]) -> Vec<Loop> {
    if loops.is_empty() {
        return Vec::new();
    }
    let empty: Paths<Milli> = Paths::default();
    match paths_from_loops(loops)
        .to_clipper_subject()
        .add_clip(empty)
        .union(FillRule::NonZero)
    {
        Ok(paths) => loops_from_paths(paths),
        Err(_) => loops.to_vec(),
    }
}
