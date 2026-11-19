//! Vent notches for resin. A pocket is a cell of the rib network on the wall,
//! closed all round by ribs or by a border where a side wall stands.
//!
//! Formlabs, "Preventing suction cups in PreForm": air is trapped "between
//! the part and the resin tank", so the opening that cups faces the tank.
//! `build_axis` points from the platform toward the tank. A pocket cups when
//! the side its ribs stand on points along that axis.
//!
//! The notch is one full-height gap per cupping pocket, [`RESIN_VENT_MM`]
//! wide, at the middle of a rib stretch shared with a cell that drains. A
//! root hole under a continuous rib top is not a section this kernel builds:
//! a height is the whole stretch, and the shortest height is 0.1 mm.

use std::collections::{BTreeMap, VecDeque};

use crate::shell::{RibSide, ShellMesh};
use crate::units::{dot, norm, sub};

use super::surface::Surface;
#[cfg(test)]
use super::surface;
use super::GRib;

/// Formlabs' minimum drain hole, mm. Form 4 design specifications.
pub const RESIN_VENT_MM: f64 = 0.75;

/// A cupping cell that can only reach cells walled in by side walls.
pub const PART_CUPS: &str = "the part itself cups here; ribs cannot vent it";

/// A cupping cell has a way out, but no boundary rib can hold the gap.
pub const TOO_SHORT: &str = "no boundary rib is long enough for a vent";

/// Projection of a folded wall overlaps itself.
pub const FOLDED_NOTE: &str = "This wall's projection overlaps itself, so a rib on one face would land on a rib on another. Venting is left undone.";

const WELD: f64 = 1e-4;
const AREA: f64 = 1e-3;
const CUP: f64 = 1e-6;
const OVERLAP_MM: f64 = 1.0;
const CLEAR_EXTRA: f64 = 0.5;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct VentPocket {
    pub rib: usize,
    pub at: [f64; 3],
    pub size_mm: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct VentUnvented {
    pub at: [f64; 3],
    pub message: String,
}

/// What a resin plan reports. The ribs in the plan are the gapped ones.
#[derive(Clone, Debug, PartialEq)]
pub struct Venting {
    pub size_mm: f64,
    pub factor_before: f64,
    pub factor_after: f64,
    pub pockets: Vec<VentPocket>,
    pub unvented: Vec<VentUnvented>,
    pub note: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct VentPockets {
    /// The ribs' side points along the build axis, so a closed cell cups.
    pub cups: bool,
    /// Geometrically sealed cells, whether or not the direction cups.
    pub closed: usize,
    pub size_mm: f64,
    pub pockets: Vec<VentPocket>,
    pub unvented: Vec<VentUnvented>,
    pub note: Option<String>,
}

/// How a rib end meets the rest of the drawing.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EndKind {
    Closed,
    Free,
    Hold,
    Gap,
}

/// One run. A free end drains the cell. A hold or a gap end does not.
pub struct RibRun<'a> {
    pub points: &'a [[f64; 3]],
    pub ends: [EndKind; 2],
    pub width_mm: f64,
}

/// A wall border. `rises` closes a cell; `open` and `hole` drain it.
pub struct BorderRun<'a> {
    pub points: &'a [[f64; 3]],
    pub kind: BorderKind,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BorderKind {
    Rises,
    Open,
    Hole,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    Rib,
    Rises,
    Open,
    Hole,
}

struct Seg {
    a: [f64; 2],
    b: [f64; 2],
    a3: [f64; 3],
    b3: [f64; 3],
    kind: Kind,
    rib: i32,
    loose_a: bool,
    loose_b: bool,
    gap_a: bool,
    gap_b: bool,
    width: f64,
}

#[derive(Clone)]
struct Half {
    from: usize,
    to: usize,
    edge: usize,
    kind: Kind,
}

struct Edge {
    a: usize,
    b: usize,
    kind: Kind,
    rib: i32,
    a3: [f64; 3],
    b3: [f64; 3],
    width: f64,
}

struct Face {
    id: usize,
    halves: Vec<Half>,
    ring: Vec<usize>,
    open: bool,
    sealed: bool,
    at2: [f64; 2],
    at3: [f64; 3],
}

#[derive(Clone, Copy)]
struct Link {
    face: usize,
    edge: usize,
    rib: i32,
}

struct Graph {
    xy: Vec<[f64; 2]>,
    xyz: Vec<[f64; 3]>,
    edges: Vec<Edge>,
    loose: Vec<bool>,
    gap: Vec<bool>,
    out: Vec<Vec<Half>>,
}

/// At least [`RESIN_VENT_MM`], rounded up to `pixel_mm` when that is positive.
pub fn vent_size_mm(pixel_mm: Option<f64>) -> f64 {
    match pixel_mm {
        Some(px) if px.is_finite() && px > 0.0 => ((RESIN_VENT_MM - 1e-9) / px).ceil() * px,
        _ => RESIN_VENT_MM,
    }
}

fn empty(cups: bool, size_mm: f64, note: Option<String>) -> VentPockets {
    VentPockets { cups, closed: 0, size_mm, pockets: Vec::new(), unvented: Vec::new(), note }
}

/// Closed cells, and one vent each for the cupping cells that can drain through a notch.
pub fn vent_pockets(ribs: &[RibRun<'_>], borders: &[BorderRun<'_>], opening: [f64; 3], build: [f64; 3], min_length: f64) -> VentPockets {
    let size_mm = vent_size_mm(None);
    let Some(opening) = normalize(opening) else { return empty(false, size_mm, None) };
    let Some(build) = normalize(build) else { return empty(false, size_mm, None) };
    let cups = dot(opening, build) > CUP;
    let axis = if opening[0].abs() < 0.9 { [1.0, 0.0, 0.0] } else { [0.0, 1.0, 0.0] };
    let Some(u) = normalize(cross(axis, opening)) else { return empty(cups, size_mm, None) };
    let v = cross(opening, u);
    let origin = first_point(ribs).unwrap_or([0.0, 0.0, 0.0]);
    let project = |p: [f64; 3]| -> [f64; 2] {
        let d = sub(p, origin);
        [dot(d, u), dot(d, v)]
    };
    let mut segs = Vec::new();
    let mut push = |points: &[[f64; 3]], kind: Kind, rib: i32, loose_a: bool, loose_b: bool, gap_a: bool, gap_b: bool, width: f64| {
        for i in 1..points.len() {
            let a3 = points[i - 1];
            let b3 = points[i];
            let a = project(a3);
            let b = project(b3);
            if dist2(a, b) < WELD * WELD {
                continue;
            }
            segs.push(Seg {
                a,
                b,
                a3,
                b3,
                kind,
                rib,
                loose_a: i == 1 && loose_a,
                loose_b: i + 1 == points.len() && loose_b,
                gap_a: i == 1 && gap_a,
                gap_b: i + 1 == points.len() && gap_b,
                width,
            });
        }
    };
    for (i, rib) in ribs.iter().enumerate() {
        push(
            rib.points,
            Kind::Rib,
            i as i32,
            rib.ends[0] == EndKind::Free,
            rib.ends[1] == EndKind::Free,
            rib.ends[0] == EndKind::Gap,
            rib.ends[1] == EndKind::Gap,
            rib.width_mm,
        );
    }
    for border in borders {
        let kind = match border.kind {
            BorderKind::Rises => Kind::Rises,
            BorderKind::Open => Kind::Open,
            BorderKind::Hole => Kind::Hole,
        };
        push(border.points, kind, -1, false, false, false, false, 0.0);
    }
    if segs.is_empty() {
        return empty(cups, size_mm, None);
    }
    if self_overlaps(&segs) {
        return empty(cups, size_mm, Some(FOLDED_NOTE.to_string()));
    }
    join_ends(&mut segs);
    let pieces = split_segs(segs);
    let Some(graph) = build_graph(&pieces) else { return empty(cups, size_mm, None) };
    let mut faces = walk_faces(&graph);
    mark_holes(&mut faces, &graph);
    drain_through_gaps(&mut faces, &graph);
    let sealed: Vec<usize> = faces.iter().filter(|f| f.sealed).map(|f| f.id).collect();
    if !cups {
        return VentPockets { cups: false, closed: sealed.len(), size_mm, pockets: Vec::new(), unvented: Vec::new(), note: None };
    }
    let adj = adjacency(&faces, &graph.edges);
    let open_ids: Vec<usize> = faces.iter().filter(|f| f.open).map(|f| f.id).collect();
    let reach = reachable(&open_ids, &adj);
    let mut parent: Vec<Option<Link>> = vec![None; faces.len()];
    let mut seen = vec![false; faces.len()];
    for &id in &open_ids {
        seen[id] = true;
    }
    let mut order = Vec::new();
    let mut queue: VecDeque<usize> = open_ids.iter().copied().collect();
    while let Some(id) = queue.pop_front() {
        let mut links = adj[id].clone();
        links.sort_by(|a, b| a.rib.cmp(&b.rib).then(a.edge.cmp(&b.edge)));
        for link in links {
            if seen[link.face] {
                continue;
            }
            seen[link.face] = true;
            parent[link.face] = Some(Link { face: id, edge: link.edge, rib: link.rib });
            order.push(link.face);
            queue.push_back(link.face);
        }
    }
    let mut draining = vec![false; faces.len()];
    for &id in &open_ids {
        draining[id] = true;
    }
    let mut vented = vec![false; faces.len()];
    let mut pockets = Vec::new();
    let mut taken: Vec<(i32, [f64; 2])> = Vec::new();
    let mut gaps: Vec<Vec<(f64, f64)>> = vec![Vec::new(); ribs.len()];
    for id in order {
        if !faces[id].sealed {
            continue;
        }
        let pref = parent[id];
        let mut links: Vec<Link> = adj[id].iter().copied().filter(|link| draining[link.face]).collect();
        links.sort_by(|a, b| a.rib.cmp(&b.rib).then(a.edge.cmp(&b.edge)));
        if let Some(pref) = pref.filter(|p| draining[p.face]) {
            if let Some(at) = links.iter().position(|link| link.edge == pref.edge && link.face == pref.face) {
                if at > 0 {
                    let link = links.remove(at);
                    links.insert(0, link);
                }
            }
        }
        for link in links {
            let Some(placed) = place_notch(&graph, link, size_mm, min_length, &taken, &gaps) else { continue };
            pockets.push(VentPocket { rib: placed.rib, at: placed.at, size_mm });
            taken.push((graph.edges[link.edge].rib, placed.flat));
            if placed.rib < gaps.len() {
                gaps[placed.rib].push(placed.span);
            }
            draining[id] = true;
            vented[id] = true;
            break;
        }
    }
    let mut unvented = Vec::new();
    for id in &sealed {
        let face = &faces[*id];
        if !reach[*id] {
            unvented.push(VentUnvented { at: face.at3, message: PART_CUPS.to_string() });
        } else if !vented[*id] {
            unvented.push(VentUnvented { at: face.at3, message: TOO_SHORT.to_string() });
        }
    }
    unvented.sort_by(|a, b| a.at[0].total_cmp(&b.at[0]).then(a.at[1].total_cmp(&b.at[1])).then(a.at[2].total_cmp(&b.at[2])));
    pockets.sort_by(|a, b| a.rib.cmp(&b.rib).then(a.at[0].total_cmp(&b.at[0])).then(a.at[1].total_cmp(&b.at[1])));
    VentPockets { cups: true, closed: sealed.len(), size_mm, pockets, unvented, note: None }
}

/// The side the ribs stand on: the mesh's area-weighted normal, flipped for the negative side.
pub(crate) fn opening_of(mesh: &ShellMesh, side: RibSide) -> Option<[f64; 3]> {
    let sign = match side {
        RibSide::Positive => 1.0,
        RibSide::Negative => -1.0,
        RibSide::Centered => return None,
    };
    let mut n = [0.0, 0.0, 0.0];
    for t in &mesh.triangles {
        let (a, b, c) = (mesh.vertices[t[0] as usize], mesh.vertices[t[1] as usize], mesh.vertices[t[2] as usize]);
        n = add(n, cross(sub(b, a), sub(c, a)));
    }
    let l = norm(n);
    (l >= 1e-12).then_some(scale(n, sign / l))
}

/// The same pockets on the planner's ribs. Only a budget loose end drains; a hold or a boss closes.
pub(crate) fn find(ribs: &[GRib], loose: &[(usize, usize)], borders: &[BorderRun<'_>], opening: [f64; 3], build: [f64; 3], min_length: f64) -> VentPockets {
    let runs: Vec<RibRun<'_>> = ribs
        .iter()
        .enumerate()
        .map(|(i, rib)| RibRun {
            points: &rib.points,
            ends: [
                if loose.iter().any(|&(r, e)| r == i && e == 0) { EndKind::Free } else { EndKind::Closed },
                if loose.iter().any(|&(r, e)| r == i && e == 1) { EndKind::Free } else { EndKind::Closed },
            ],
            width_mm: rib.d.width,
        })
        .collect();
    vent_pockets(&runs, borders, opening, build, min_length)
}

/// Cut each vent out of its rib. The new ends are gaps. A pocket's rib index is a piece of the
/// returned list whose end sits on the gap; a pocket that cannot be cut is left out.
pub(crate) fn notch(ribs: &[GRib], pockets: &[VentPocket], min_length: f64) -> (Vec<GRib>, Vec<VentPocket>) {
    let mut cuts: Vec<Vec<[f64; 3]>> = vec![Vec::new(); ribs.len()];
    let mut size_of = vec![RESIN_VENT_MM; ribs.len()];
    for pocket in pockets {
        if pocket.rib < cuts.len() {
            cuts[pocket.rib].push(pocket.at);
            size_of[pocket.rib] = pocket.size_mm;
        }
    }
    let mut out = Vec::new();
    for (i, rib) in ribs.iter().enumerate() {
        if cuts[i].is_empty() {
            out.push(rib.clone());
            continue;
        }
        out.extend(split_rib(rib, &cuts[i], size_of[i], min_length));
    }
    let pockets = pockets
        .iter()
        .filter_map(|p| {
            out.iter().position(|rib| {
                rib.points.first().is_some_and(|a| norm(sub(*a, p.at)) < 1.0) || rib.points.last().is_some_and(|b| norm(sub(*b, p.at)) < 1.0)
            }).map(|rib| VentPocket { rib, at: p.at, size_mm: p.size_mm })
        })
        .collect();
    (out, pockets)
}

/// Slide a gap along its rib until surface embedding still leaves it open.
///
/// Snapping is a tenth of an element edge. A 0.75 mm gap centred on a vertex of a long edge
/// collapses, because both ends snap to that vertex. Sliding both ends together keeps the gap
/// 0.75 mm wide. The seat that survives is the one whose embedded opening is closest to
/// [`RESIN_VENT_MM`]: the first end has to land just outside the snap radius, so the short edge
/// it cuts is too small for the second end to snap onto it. Neither piece is left shorter than
/// `min_length`.
pub(crate) fn seat_gaps(surface: &Surface, ribs: &mut [GRib], min_length: f64) {
    let mut pairs = Vec::new();
    for i in 0..ribs.len() {
        for end_i in 0..2 {
            let Some(pi) = end_point(&ribs[i], end_i) else { continue };
            for j in (i + 1)..ribs.len() {
                for end_j in 0..2 {
                    let Some(pj) = end_point(&ribs[j], end_j) else { continue };
                    let d = norm(sub(pi, pj));
                    // A vent is 0.75 mm. A wider window would slide rib ends that merely sit near each other.
                    if (0.5..1.2).contains(&d) {
                        pairs.push((i, end_i, j, end_j));
                    }
                }
            }
        }
    }
    for (i, end_i, j, end_j) in pairs {
        let Some(a) = end_point(&ribs[i], end_i) else { continue };
        let Some(b) = end_point(&ribs[j], end_j) else { continue };
        let dir = sub(b, a);
        let n = norm(dir);
        if n < 1e-6 {
            continue;
        }
        let axis = scale(dir, 1.0 / n);
        let mut best: Option<(f64, f64)> = None;
        for step in 0..80 {
            let mut hit = false;
            for sign in [1.0_f64, -1.0] {
                if step == 0 && sign < 0.0 {
                    continue;
                }
                let shift = sign * step as f64 * 0.1;
                if shift != 0.0 && !shift_fits(&ribs[i], end_i, &ribs[j], end_j, axis, shift, min_length) {
                    continue;
                }
                let saved = (end_point(&ribs[i], end_i).unwrap(), end_point(&ribs[j], end_j).unwrap());
                if shift != 0.0 {
                    move_end(&mut ribs[i], end_i, axis, shift);
                    move_end(&mut ribs[j], end_j, axis, shift);
                }
                let gap = embedded_opening(surface, ribs, i, end_i, j, end_j);
                set_end(&mut ribs[i], end_i, saved.0);
                set_end(&mut ribs[j], end_j, saved.1);
                let Some(gap) = gap else { continue };
                if gap + 1e-6 < 0.7 {
                    continue;
                }
                let score = (gap - RESIN_VENT_MM).abs();
                if best.is_none_or(|(_, have)| score < have - 1e-9) {
                    best = Some((shift, score));
                }
                if score < 0.05 {
                    hit = true;
                }
            }
            if hit {
                break;
            }
        }
        if let Some((shift, _)) = best {
            if shift != 0.0 {
                move_end(&mut ribs[i], end_i, axis, shift);
                move_end(&mut ribs[j], end_j, axis, shift);
            }
        }
    }
}

/// The opening left after embedding every rib, in order, the same way [`super::embed_design`] does.
fn embedded_opening(surface: &Surface, ribs: &[GRib], i: usize, end_i: usize, j: usize, end_j: usize) -> Option<f64> {
    let mut s = surface.clone();
    let mut got = [None, None];
    for (k, rib) in ribs.iter().enumerate() {
        let Some(id) = s.embed_polyline(&rib.points) else {
            if k == i || k == j {
                return None;
            }
            continue;
        };
        if k != i && k != j {
            continue;
        }
        let chain = &s.chains[id];
        if chain.len() < 2 {
            return None;
        }
        let end = if k == i { end_i } else { end_j };
        let vid = if end == 0 { chain[0] } else { *chain.last().unwrap() };
        got[usize::from(k == j)] = Some(s.pos[vid as usize]);
    }
    Some(norm(sub(got[0]?, got[1]?)))
}

fn end_point(rib: &GRib, end: usize) -> Option<[f64; 3]> {
    if rib.points.len() < 2 {
        return None;
    }
    Some(if end == 0 { rib.points[0] } else { *rib.points.last().unwrap() })
}

fn shift_fits(left: &GRib, end_l: usize, right: &GRib, end_r: usize, axis: [f64; 3], shift: f64, min_length: f64) -> bool {
    // `axis` points from the left gap end toward the right. Moving that way lengthens the piece
    // whose gap end is its last point, and shortens the piece whose gap end is its first.
    let along = |rib: &GRib, end: usize| {
        let other = if end == 0 { *rib.points.last().unwrap() } else { rib.points[0] };
        let away = sub(end_point(rib, end).unwrap(), other);
        let n = norm(away);
        if n < 1e-9 { 0.0 } else { shift * dot(axis, scale(away, 1.0 / n)) }
    };
    poly_length(&left.points) + along(left, end_l) >= min_length - 1e-6 && poly_length(&right.points) + along(right, end_r) >= min_length - 1e-6
}

fn move_end(rib: &mut GRib, end: usize, axis: [f64; 3], shift: f64) {
    set_end(rib, end, add(end_point(rib, end).unwrap(), scale(axis, shift)));
}

fn set_end(rib: &mut GRib, end: usize, p: [f64; 3]) {
    if end == 0 {
        rib.points[0] = p;
    } else {
        let last = rib.points.len() - 1;
        rib.points[last] = p;
    }
}

/// The vertex `insert_in` would snap `p` to, if it snaps to an existing vertex.
#[cfg(test)]
fn snap_target(surface: &Surface, p: [f64; 3]) -> Option<u32> {
    let (t, l) = surface.locate(p);
    let tri = surface.tris[t as usize];
    let small: Vec<usize> = (0..3).filter(|&i| l[i] < surface::SNAP).collect();
    match small.len() {
        0 => None,
        1 => {
            let i = small[0];
            let (a, b) = ((i + 1) % 3, (i + 2) % 3);
            let s = l[b] / (l[a] + l[b]);
            if s < surface::SNAP {
                Some(tri[a])
            } else if s > 1.0 - surface::SNAP {
                Some(tri[b])
            } else {
                None
            }
        }
        _ => {
            let k = (0..3).max_by(|&x, &y| l[x].total_cmp(&l[y]).then(y.cmp(&x))).expect("three corners");
            Some(tri[k])
        }
    }
}

fn self_overlaps(segs: &[Seg]) -> bool {
    for i in 0..segs.len() {
        for j in (i + 1)..segs.len() {
            let Some(hit) = intersect(&segs[i], &segs[j]) else { continue };
            let (t, u) = hit;
            let corner = (t <= 1e-6 || t >= 1.0 - 1e-6) && (u <= 1e-6 || u >= 1.0 - 1e-6);
            if corner {
                continue;
            }
            let p = lerp3(segs[i].a3, segs[i].b3, t);
            let q = lerp3(segs[j].a3, segs[j].b3, u);
            if norm(sub(p, q)) > OVERLAP_MM {
                return true;
            }
        }
    }
    false
}

fn join_ends(segs: &mut [Seg]) {
    for i in 0..segs.len() {
        if segs[i].kind != Kind::Rib {
            continue;
        }
        let reach = segs[i].width / 2.0;
        if reach <= WELD {
            continue;
        }
        for at_start in [true, false] {
            let p = if at_start { segs[i].a } else { segs[i].b };
            let mut best: Option<(f64, [f64; 2], [f64; 3])> = None;
            for j in 0..segs.len() {
                if j == i {
                    continue;
                }
                let hit = closest(p, segs[j].a, segs[j].b);
                if hit.2 > reach || hit.2 <= WELD {
                    continue;
                }
                if best.is_none_or(|(d, _, _)| hit.2 < d) {
                    best = Some((hit.2, hit.0, lerp3(segs[j].a3, segs[j].b3, hit.1)));
                }
            }
            if let Some((_, q, q3)) = best {
                if at_start {
                    segs[i].a = q;
                    segs[i].a3 = q3;
                } else {
                    segs[i].b = q;
                    segs[i].b3 = q3;
                }
            }
        }
    }
}

fn closest(p: [f64; 2], a: [f64; 2], b: [f64; 2]) -> ([f64; 2], f64, f64) {
    let abx = b[0] - a[0];
    let aby = b[1] - a[1];
    let ab2 = abx * abx + aby * aby;
    let t = if ab2 < 1e-18 { 0.0 } else { ((p[0] - a[0]) * abx + (p[1] - a[1]) * aby) / ab2 }.clamp(0.0, 1.0);
    let q = [a[0] + abx * t, a[1] + aby * t];
    (q, t, ((p[0] - q[0]).powi(2) + (p[1] - q[1]).powi(2)).sqrt())
}

fn build_graph(pieces: &[Seg]) -> Option<Graph> {
    if pieces.is_empty() {
        return None;
    }
    let key_of = |q: [f64; 2]| format!("{}:{}", (q[0] / WELD).round() as i64, (q[1] / WELD).round() as i64);
    let mut xy = Vec::new();
    let mut xyz = Vec::new();
    let mut id_of: BTreeMap<String, usize> = BTreeMap::new();
    let vid = |q: [f64; 2], q3: [f64; 3], xy: &mut Vec<[f64; 2]>, xyz: &mut Vec<[f64; 3]>, id_of: &mut BTreeMap<String, usize>| {
        let key = key_of(q);
        if let Some(&id) = id_of.get(&key) {
            return id;
        }
        let id = xy.len();
        xy.push(q);
        xyz.push(q3);
        id_of.insert(key, id);
        id
    };
    let mut loose = Vec::new();
    let mut gap = Vec::new();
    let mut edges = Vec::new();
    let mut seen_edge: BTreeMap<String, ()> = BTreeMap::new();
    for seg in pieces {
        let a = vid(seg.a, seg.a3, &mut xy, &mut xyz, &mut id_of);
        let b = vid(seg.b, seg.b3, &mut xy, &mut xyz, &mut id_of);
        if a == b {
            continue;
        }
        if loose.len() < xy.len() {
            loose.resize(xy.len(), false);
            gap.resize(xy.len(), false);
        }
        if seg.loose_a {
            loose[a] = true;
        }
        if seg.loose_b {
            loose[b] = true;
        }
        if seg.gap_a {
            gap[a] = true;
        }
        if seg.gap_b {
            gap[b] = true;
        }
        let key = if a < b {
            format!("{a}:{b}:{:?}:{}", kind_tag(seg.kind), seg.rib)
        } else {
            format!("{b}:{a}:{:?}:{}", kind_tag(seg.kind), seg.rib)
        };
        if seen_edge.contains_key(&key) {
            continue;
        }
        seen_edge.insert(key, ());
        edges.push(Edge { a, b, kind: seg.kind, rib: seg.rib, a3: xyz[a], b3: xyz[b], width: seg.width });
    }
    loose.resize(xy.len(), false);
    gap.resize(xy.len(), false);
    let mut out = vec![Vec::new(); xy.len()];
    for (i, edge) in edges.iter().enumerate() {
        out[edge.a].push(Half { from: edge.a, to: edge.b, edge: i, kind: edge.kind });
        out[edge.b].push(Half { from: edge.b, to: edge.a, edge: i, kind: edge.kind });
    }
    for list in &mut out {
        list.sort_by(|p, q| {
            let ap = (xy[p.to][1] - xy[p.from][1]).atan2(xy[p.to][0] - xy[p.from][0]);
            let aq = (xy[q.to][1] - xy[q.from][1]).atan2(xy[q.to][0] - xy[q.from][0]);
            ap.total_cmp(&aq).then(p.edge.cmp(&q.edge))
        });
    }
    Some(Graph { xy, xyz, edges, loose, gap, out })
}

fn kind_tag(kind: Kind) -> u8 {
    match kind {
        Kind::Rib => 0,
        Kind::Rises => 1,
        Kind::Open => 2,
        Kind::Hole => 3,
    }
}

fn walk_faces(graph: &Graph) -> Vec<Face> {
    let next_of = |h: &Half| -> Half {
        let list = &graph.out[h.to];
        let i = list.iter().position(|row| row.edge == h.edge).unwrap_or(0);
        list[(i + list.len() - 1) % list.len()].clone()
    };
    let mut used: BTreeMap<(usize, usize), ()> = BTreeMap::new();
    let mut faces = Vec::new();
    for list in &graph.out {
        for start in list {
            let start_key = (start.from, start.edge);
            if used.contains_key(&start_key) {
                continue;
            }
            let mut halves = Vec::new();
            let mut h = start.clone();
            let mut guard = 0;
            let mut closed = false;
            while guard < graph.edges.len() * 2 + 4 {
                guard += 1;
                let key = (h.from, h.edge);
                if used.contains_key(&key) {
                    break;
                }
                used.insert(key, ());
                halves.push(h.clone());
                h = next_of(&h);
                if h.from == start.from && h.edge == start.edge {
                    closed = true;
                    break;
                }
            }
            if !closed || halves.len() < 3 {
                continue;
            }
            let mut area = 0.0;
            for row in &halves {
                let p = graph.xy[row.from];
                let q = graph.xy[row.to];
                area += p[0] * q[1] - q[0] * p[1];
            }
            if area.abs() < AREA {
                continue;
            }
            let ring: Vec<usize> = halves.iter().map(|row| row.from).collect();
            let n = ring.len() as f64;
            let mut at3 = [0.0, 0.0, 0.0];
            let mut sx = 0.0;
            let mut sy = 0.0;
            for &id in &ring {
                sx += graph.xy[id][0];
                sy += graph.xy[id][1];
                at3 = add(at3, graph.xyz[id]);
            }
            at3 = scale(at3, 1.0 / n);
            let bounded = area > 0.0;
            let drains = halves.iter().any(|row| row.kind == Kind::Open || row.kind == Kind::Hole) || halves.iter().any(|row| graph.loose[row.from]);
            let wall = halves.iter().all(|row| row.kind == Kind::Rib || row.kind == Kind::Rises);
            faces.push(Face {
                id: faces.len(),
                halves,
                ring,
                open: !bounded || drains || !wall,
                sealed: bounded && wall && !drains,
                at2: [sx / n, sy / n],
                at3,
            });
        }
    }
    faces
}

fn mark_holes(faces: &mut [Face], graph: &Graph) {
    let holes: Vec<(usize, [f64; 2])> = faces
        .iter()
        .filter(|face| face.halves.len() >= 3 && face.halves.iter().all(|row| row.kind == Kind::Hole))
        .map(|face| (face.id, face.at2))
        .collect();
    for (_, q) in holes {
        for face in faces.iter_mut() {
            if !face.sealed {
                continue;
            }
            let poly: Vec<[f64; 2]> = face.ring.iter().map(|&id| graph.xy[id]).collect();
            if inside(&poly, q) {
                face.sealed = false;
                face.open = true;
            }
        }
    }
}

fn inside(poly: &[[f64; 2]], q: [f64; 2]) -> bool {
    let mut c = false;
    let mut j = poly.len() - 1;
    for i in 0..poly.len() {
        let pi = poly[i];
        let pj = poly[j];
        if (pi[1] > q[1]) != (pj[1] > q[1]) && q[0] < (pj[0] - pi[0]) * (q[1] - pi[1]) / (pj[1] - pi[1]) + pi[0] {
            c = !c;
        }
        j = i;
    }
    c
}

fn drain_through_gaps(faces: &mut [Face], graph: &Graph) {
    let mut users: Vec<Vec<usize>> = vec![Vec::new(); graph.edges.len()];
    for face in faces.iter() {
        let mut seen = vec![false; graph.edges.len()];
        for half in &face.halves {
            if seen[half.edge] {
                continue;
            }
            seen[half.edge] = true;
            users[half.edge].push(face.id);
        }
    }
    let mut adj: Vec<Vec<usize>> = vec![Vec::new(); faces.len()];
    for (index, edge) in graph.edges.iter().enumerate() {
        if !graph.gap[edge.a] && !graph.gap[edge.b] {
            continue;
        }
        let mut ids = users[index].clone();
        ids.sort_unstable();
        ids.dedup();
        for &a in &ids {
            for &b in &ids {
                if a != b {
                    adj[a].push(b);
                }
            }
        }
    }
    let mut open = vec![false; faces.len()];
    let mut queue = VecDeque::new();
    for face in faces.iter() {
        if face.open {
            open[face.id] = true;
            queue.push_back(face.id);
        }
    }
    while let Some(id) = queue.pop_front() {
        for &next in &adj[id] {
            if open[next] {
                continue;
            }
            open[next] = true;
            queue.push_back(next);
        }
    }
    for face in faces.iter_mut() {
        if open[face.id] && face.sealed {
            face.sealed = false;
            face.open = true;
        }
    }
}

fn adjacency(faces: &[Face], edges: &[Edge]) -> Vec<Vec<Link>> {
    let mut users: Vec<Vec<usize>> = vec![Vec::new(); edges.len()];
    for face in faces {
        let mut seen = vec![false; edges.len()];
        for half in &face.halves {
            if seen[half.edge] {
                continue;
            }
            seen[half.edge] = true;
            users[half.edge].push(face.id);
        }
    }
    let mut adj = vec![Vec::new(); faces.len()];
    for (edge, ids) in users.iter().enumerate() {
        if edges[edge].rib < 0 || edges[edge].kind != Kind::Rib {
            continue;
        }
        let mut unique = ids.clone();
        unique.sort_unstable();
        unique.dedup();
        if unique.len() < 2 {
            continue;
        }
        for &a in &unique {
            for &b in &unique {
                if a != b {
                    adj[a].push(Link { face: b, edge, rib: edges[edge].rib });
                }
            }
        }
    }
    adj
}

fn reachable(roots: &[usize], adj: &[Vec<Link>]) -> Vec<bool> {
    let mut seen = vec![false; adj.len()];
    let mut queue = VecDeque::new();
    for &id in roots {
        seen[id] = true;
        queue.push_back(id);
    }
    while let Some(id) = queue.pop_front() {
        for link in &adj[id] {
            if seen[link.face] {
                continue;
            }
            seen[link.face] = true;
            queue.push_back(link.face);
        }
    }
    seen
}

struct Placed {
    rib: usize,
    at: [f64; 3],
    flat: [f64; 2],
    span: (f64, f64),
}

fn place_notch(graph: &Graph, link: Link, size_mm: f64, min_length: f64, taken: &[(i32, [f64; 2])], gaps: &[Vec<(f64, f64)>]) -> Option<Placed> {
    let edge = &graph.edges[link.edge];
    if edge.rib < 0 {
        return None;
    }
    let span = norm(sub(edge.b3, edge.a3));
    let clear = edge.width / 2.0 + CLEAR_EXTRA;
    if span / 2.0 - size_mm / 2.0 < clear - 1e-6 {
        return None;
    }
    let at = lerp3(edge.a3, edge.b3, 0.5);
    let pa = graph.xy[edge.a];
    let pb = graph.xy[edge.b];
    let flat = [(pa[0] + pb[0]) / 2.0, (pa[1] + pb[1]) / 2.0];
    if taken.iter().any(|(rib, cut)| *rib == edge.rib && ((cut[0] - flat[0]).powi(2) + (cut[1] - flat[1]).powi(2)).sqrt() < size_mm) {
        return None;
    }
    let total: f64 = graph.edges.iter().filter(|row| row.rib == edge.rib).map(|row| norm(sub(row.b3, row.a3))).sum();
    let s = arc_to(&graph.edges, link.edge) + span / 2.0;
    let lo = s - size_mm / 2.0;
    let hi = s + size_mm / 2.0;
    let mut existing = if edge.rib >= 0 && (edge.rib as usize) < gaps.len() { gaps[edge.rib as usize].clone() } else { Vec::new() };
    existing.push((lo, hi));
    if !pieces_fit(total, &existing, min_length) {
        return None;
    }
    Some(Placed { rib: edge.rib as usize, at, flat, span: (lo, hi) })
}

fn arc_to(edges: &[Edge], index: usize) -> f64 {
    let rib = edges[index].rib;
    let of_rib: Vec<usize> = edges.iter().enumerate().filter(|(_, row)| row.rib == rib).map(|(i, _)| i).collect();
    if of_rib.len() == 1 {
        return 0.0;
    }
    let key = |p: [f64; 3]| format!("{}:{}:{}", (p[0] / WELD).round() as i64, (p[1] / WELD).round() as i64, (p[2] / WELD).round() as i64);
    let mut by_vert: BTreeMap<String, Vec<(usize, f64)>> = BTreeMap::new();
    for &i in &of_rib {
        let length = norm(sub(edges[i].b3, edges[i].a3));
        for p in [edges[i].a3, edges[i].b3] {
            by_vert.entry(key(p)).or_default().push((i, length));
        }
    }
    let mut ends: Vec<String> = by_vert.iter().filter(|(_, list)| list.len() == 1).map(|(k, _)| k.clone()).collect();
    ends.sort();
    let Some(start) = ends.first().cloned() else { return 0.0 };
    let mut cursor = start;
    let mut run = 0.0;
    let mut seen = vec![false; edges.len()];
    for _ in 0..of_rib.len() + 2 {
        let Some(next) = by_vert.get(&cursor).and_then(|list| list.iter().find(|(i, _)| !seen[*i])).copied() else { break };
        seen[next.0] = true;
        if next.0 == index {
            return run;
        }
        run += next.1;
        let row = &edges[next.0];
        let a = key(row.a3);
        cursor = if a == cursor { key(row.b3) } else { a };
    }
    0.0
}

fn pieces_fit(total: f64, gaps: &[(f64, f64)], min_length: f64) -> bool {
    let mut ordered = gaps.to_vec();
    ordered.sort_by(|a, b| a.0.total_cmp(&b.0));
    let mut merged: Vec<(f64, f64)> = Vec::new();
    for gap in ordered {
        if let Some(last) = merged.last_mut() {
            if gap.0 <= last.1 + WELD {
                last.1 = last.1.max(gap.1);
                continue;
            }
        }
        merged.push(gap);
    }
    let mut cursor = 0.0;
    for gap in &merged {
        if gap.0 - cursor < min_length - 1e-6 {
            return false;
        }
        cursor = gap.1;
    }
    total - cursor >= min_length - 1e-6
}

fn split_segs(segs: Vec<Seg>) -> Vec<Seg> {
    let mut cuts: Vec<Vec<f64>> = vec![Vec::new(); segs.len()];
    for i in 0..segs.len() {
        for j in (i + 1)..segs.len() {
            let Some((t, u)) = intersect(&segs[i], &segs[j]) else { continue };
            if t > 1e-6 && t < 1.0 - 1e-6 {
                cuts[i].push(t);
            }
            if u > 1e-6 && u < 1.0 - 1e-6 {
                cuts[j].push(u);
            }
        }
    }
    let mut out = Vec::new();
    for (i, seg) in segs.iter().enumerate() {
        let mut ts = vec![0.0];
        let mut mid = cuts[i].clone();
        mid.sort_by(|a, b| a.total_cmp(b));
        ts.extend(mid);
        ts.push(1.0);
        for k in 1..ts.len() {
            let (t0, t1) = (ts[k - 1], ts[k]);
            if t1 - t0 < 1e-8 {
                continue;
            }
            let a = [seg.a[0] + (seg.b[0] - seg.a[0]) * t0, seg.a[1] + (seg.b[1] - seg.a[1]) * t0];
            let b = [seg.a[0] + (seg.b[0] - seg.a[0]) * t1, seg.a[1] + (seg.b[1] - seg.a[1]) * t1];
            if dist2(a, b) < WELD * WELD {
                continue;
            }
            out.push(Seg {
                a,
                b,
                a3: lerp3(seg.a3, seg.b3, t0),
                b3: lerp3(seg.a3, seg.b3, t1),
                kind: seg.kind,
                rib: seg.rib,
                loose_a: k == 1 && seg.loose_a,
                loose_b: k + 1 == ts.len() && seg.loose_b,
                gap_a: k == 1 && seg.gap_a,
                gap_b: k + 1 == ts.len() && seg.gap_b,
                width: seg.width,
            });
        }
    }
    out
}

fn intersect(p: &Seg, q: &Seg) -> Option<(f64, f64)> {
    let rx = p.b[0] - p.a[0];
    let ry = p.b[1] - p.a[1];
    let sx = q.b[0] - q.a[0];
    let sy = q.b[1] - q.a[1];
    let den = rx * sy - ry * sx;
    let qx = q.a[0] - p.a[0];
    let qy = q.a[1] - p.a[1];
    if den.abs() < 1e-12 {
        let on = |a: [f64; 2], b: [f64; 2], c: [f64; 2]| -> Option<f64> {
            let abx = b[0] - a[0];
            let aby = b[1] - a[1];
            let acx = c[0] - a[0];
            let acy = c[1] - a[1];
            let ab2 = abx * abx + aby * aby;
            if ab2 < 1e-18 {
                return None;
            }
            let t = (acx * abx + acy * aby) / ab2;
            if t <= 1e-6 || t >= 1.0 - 1e-6 {
                return None;
            }
            let dx = a[0] + abx * t - c[0];
            let dy = a[1] + aby * t - c[1];
            (dx * dx + dy * dy < WELD * WELD).then_some(t)
        };
        if let Some(t) = on(p.a, p.b, q.a) {
            return Some((t, 0.0));
        }
        if let Some(t) = on(p.a, p.b, q.b) {
            return Some((t, 1.0));
        }
        if let Some(u) = on(q.a, q.b, p.a) {
            return Some((0.0, u));
        }
        if let Some(u) = on(q.a, q.b, p.b) {
            return Some((1.0, u));
        }
        return None;
    }
    let t = (qx * sy - qy * sx) / den;
    let u = (qx * ry - qy * rx) / den;
    if !(-1e-6..=1.0 + 1e-6).contains(&t) || !(-1e-6..=1.0 + 1e-6).contains(&u) {
        return None;
    }
    Some((t.clamp(0.0, 1.0), u.clamp(0.0, 1.0)))
}

fn split_rib(rib: &GRib, centers: &[[f64; 3]], size: f64, min_length: f64) -> Vec<GRib> {
    let total = poly_length(&rib.points);
    if total < WELD {
        return Vec::new();
    }
    let mut gaps = Vec::new();
    for at in centers {
        let Some(s) = param_of(&rib.points, *at) else { continue };
        let half = size / 2.0;
        let lo = (s - half).max(0.0);
        let hi = (s + half).min(total);
        if hi - lo >= WELD {
            gaps.push((lo, hi));
        }
    }
    if !pieces_fit(total, &gaps, min_length) {
        return vec![rib.clone()];
    }
    gaps.sort_by(|a, b| a.0.total_cmp(&b.0));
    let mut merged: Vec<(f64, f64)> = Vec::new();
    for gap in gaps {
        if let Some(last) = merged.last_mut() {
            if gap.0 <= last.1 + WELD {
                last.1 = last.1.max(gap.1);
                continue;
            }
        }
        merged.push(gap);
    }
    let mut spans = Vec::new();
    let mut cursor = 0.0;
    for gap in &merged {
        if gap.0 - cursor > WELD {
            spans.push((cursor, gap.0));
        }
        cursor = gap.1;
    }
    if total - cursor > WELD {
        spans.push((cursor, total));
    }
    spans
        .into_iter()
        .map(|(lo, hi)| {
            let (points, heights) = sample_rib(&rib.points, &rib.heights, lo, hi);
            let mut piece = rib.clone();
            piece.points = points;
            piece.heights = heights;
            piece
        })
        .filter(|piece| piece.points.len() >= 2)
        .collect()
}

fn sample_rib(points: &[[f64; 3]], heights: &[f64], lo: f64, hi: f64) -> (Vec<[f64; 3]>, Vec<f64>) {
    let mut out = vec![point_at(points, lo)];
    let mut run = 0.0;
    for i in 1..points.len() {
        let step = norm(sub(points[i], points[i - 1]));
        let next = run + step;
        if next > lo + WELD && next < hi - WELD {
            out.push(points[i]);
        }
        run = next;
    }
    out.push(point_at(points, hi));
    let mut clean = vec![out[0]];
    for p in out.into_iter().skip(1) {
        if norm(sub(p, *clean.last().unwrap())) > WELD {
            clean.push(p);
        }
    }
    let hs: Vec<f64> = clean
        .windows(2)
        .map(|w| {
            let m = [(w[0][0] + w[1][0]) / 2.0, (w[0][1] + w[1][1]) / 2.0, (w[0][2] + w[1][2]) / 2.0];
            height_at(points, heights, param_of(points, m).unwrap_or(0.0))
        })
        .collect();
    (clean, hs)
}

fn height_at(points: &[[f64; 3]], heights: &[f64], s: f64) -> f64 {
    if heights.is_empty() {
        return 1.0;
    }
    let mut run = 0.0;
    for i in 1..points.len() {
        let step = norm(sub(points[i], points[i - 1]));
        if run + step >= s - 1e-9 || i + 1 == points.len() {
            return heights[(i - 1).min(heights.len() - 1)];
        }
        run += step;
    }
    *heights.last().unwrap()
}

fn poly_length(pts: &[[f64; 3]]) -> f64 {
    pts.windows(2).map(|w| norm(sub(w[1], w[0]))).sum()
}

fn param_of(pts: &[[f64; 3]], at: [f64; 3]) -> Option<f64> {
    let mut best = f64::INFINITY;
    let mut at_s = 0.0;
    let mut run = 0.0;
    for w in pts.windows(2) {
        let ab = sub(w[1], w[0]);
        let ab2 = dot(ab, ab);
        let t = if ab2 < 1e-18 { 0.0 } else { (dot(sub(at, w[0]), ab) / ab2).clamp(0.0, 1.0) };
        let q = [w[0][0] + ab[0] * t, w[0][1] + ab[1] * t, w[0][2] + ab[2] * t];
        let d = norm(sub(at, q));
        if d < best {
            best = d;
            at_s = run + ab2.sqrt() * t;
        }
        run += ab2.sqrt();
    }
    (best <= 0.5).then_some(at_s)
}

fn point_at(pts: &[[f64; 3]], s: f64) -> [f64; 3] {
    let mut run = 0.0;
    for i in 1..pts.len() {
        let step = norm(sub(pts[i], pts[i - 1]));
        if run + step >= s - 1e-9 || i + 1 == pts.len() {
            let t = if step < 1e-12 { 0.0 } else { ((s - run) / step).clamp(0.0, 1.0) };
            return [
                pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * t,
                pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t,
                pts[i - 1][2] + (pts[i][2] - pts[i - 1][2]) * t,
            ];
        }
        run += step;
    }
    pts.last().copied().unwrap_or([0.0, 0.0, 0.0])
}

fn first_point(ribs: &[RibRun<'_>]) -> Option<[f64; 3]> {
    ribs.iter().find_map(|rib| rib.points.first().copied())
}

fn normalize(v: [f64; 3]) -> Option<[f64; 3]> {
    let l = norm(v);
    (l >= 1e-12).then_some([v[0] / l, v[1] / l, v[2] / l])
}

fn cross(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

fn add(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}

fn scale(a: [f64; 3], s: f64) -> [f64; 3] {
    [a[0] * s, a[1] * s, a[2] * s]
}

fn lerp3(a: [f64; 3], b: [f64; 3], t: f64) -> [f64; 3] {
    [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
}

fn dist2(a: [f64; 2], b: [f64; 2]) -> f64 {
    let (x, y) = (a[0] - b[0], a[1] - b[1]);
    x * x + y * y
}

#[cfg(test)]
mod tests {
    use super::*;

    fn near(a: f64, b: f64) -> bool {
        (a - b).abs() < 1e-6
    }

    fn same_at(a: [f64; 3], b: &[serde_json::Value]) -> bool {
        b.len() == 3 && near(a[0], b[0].as_f64().unwrap()) && near(a[1], b[1].as_f64().unwrap()) && near(a[2], b[2].as_f64().unwrap())
    }

    #[test]
    fn shared_graphs_match_the_fixture() {
        let raw = include_str!("../../../../../tools/fixtures/vent-graphs.json");
        let fixture: serde_json::Value = serde_json::from_str(raw).expect("fixture");
        let width = fixture["widthMm"].as_f64().unwrap();
        let min_length = fixture["minLengthMm"].as_f64().unwrap();
        let opening = read3(&fixture["opening"]);
        for case in fixture["cases"].as_array().unwrap() {
            let w = case["widthMm"].as_f64().unwrap_or(width);
            let min_l = case["minLengthMm"].as_f64().unwrap_or(min_length);
            let owned: Vec<(Vec<[f64; 3]>, [EndKind; 2])> = case["ribs"].as_array().unwrap().iter().map(|rib| {
                let points = rib["points"].as_array().unwrap().iter().map(read3).collect();
                let ends = match rib["ends"].as_array() {
                    Some(ends) => [kind_of(ends[0].as_str().unwrap()), kind_of(ends[1].as_str().unwrap())],
                    None => [EndKind::Closed, EndKind::Closed],
                };
                (points, ends)
            }).collect();
            let borders_owned: Vec<(Vec<[f64; 3]>, BorderKind)> = case["borders"].as_array().unwrap_or(&Vec::new()).iter().map(|border| {
                let points = border["points"].as_array().unwrap().iter().map(read3).collect();
                let kind = match border["kind"].as_str().unwrap() {
                    "rises" => BorderKind::Rises,
                    "open" => BorderKind::Open,
                    "hole" => BorderKind::Hole,
                    other => panic!("border {other}"),
                };
                (points, kind)
            }).collect();
            let runs: Vec<RibRun<'_>> = owned.iter().map(|(points, ends)| RibRun { points, ends: *ends, width_mm: w }).collect();
            let borders: Vec<BorderRun<'_>> = borders_owned.iter().map(|(points, kind)| BorderRun { points, kind: *kind }).collect();
            let part_cups = case["builds"].as_array().unwrap().iter().find(|build| {
                build["unvented"].as_array().is_some_and(|items| !items.is_empty() && items.iter().all(|item| item["message"].as_str() == Some(PART_CUPS)))
            });
            for build in case["builds"].as_array().unwrap() {
                let axis = read3(&build["axis"]);
                let got = vent_pockets(&runs, &borders, opening, axis, min_l);
                let name = format!("{} {axis:?}", case["name"].as_str().unwrap());
                assert_eq!(got.cups, build["cups"].as_bool().unwrap(), "{name} cups");
                assert_eq!(got.closed, build["closed"].as_u64().unwrap() as usize, "{name} closed");
                let expect_p = build["pockets"].as_array().unwrap();
                assert_eq!(got.pockets.len(), expect_p.len(), "{name} pocket count {:?}", got.pockets);
                for (pocket, expect) in got.pockets.iter().zip(expect_p) {
                    assert_eq!(pocket.rib, expect["rib"].as_u64().unwrap() as usize, "{name}");
                    assert!(near(pocket.size_mm, expect["sizeMm"].as_f64().unwrap()), "{name}");
                    assert!(same_at(pocket.at, expect["at"].as_array().unwrap()), "{name} at {:?} want {:?}", pocket.at, expect["at"]);
                }
                let expect_u = if build["unventedSame"].as_bool() == Some(true) {
                    part_cups.unwrap()["unvented"].as_array().unwrap().clone()
                } else {
                    build["unvented"].as_array().unwrap().clone()
                };
                assert_eq!(got.unvented.len(), expect_u.len(), "{name} unvented {:?}", got.unvented);
                let mut got_u = got.unvented.clone();
                got_u.sort_by(|a, b| a.at[0].total_cmp(&b.at[0]).then(a.at[1].total_cmp(&b.at[1])));
                let mut want = expect_u;
                want.sort_by(|a, b| a["at"][0].as_f64().unwrap().total_cmp(&b["at"][0].as_f64().unwrap()).then(a["at"][1].as_f64().unwrap().total_cmp(&b["at"][1].as_f64().unwrap())));
                for (item, expect) in got_u.iter().zip(&want) {
                    assert_eq!(item.message, expect["message"].as_str().unwrap(), "{name}");
                    assert!(same_at(item.at, expect["at"].as_array().unwrap()), "{name}");
                }
                if build["note"].as_bool() == Some(true) {
                    assert_eq!(got.note.as_deref(), Some(FOLDED_NOTE), "{name}");
                } else {
                    assert!(got.note.is_none(), "{name}");
                }
            }
        }
    }

    #[test]
    fn a_notch_is_a_gap_and_the_square_then_drains() {
        let lines = [
            vec![[0.0, 0.0, 0.0], [10.0, 0.0, 0.0]],
            vec![[10.0, 0.0, 0.0], [10.0, 10.0, 0.0]],
            vec![[10.0, 10.0, 0.0], [0.0, 10.0, 0.0]],
            vec![[0.0, 10.0, 0.0], [0.0, 0.0, 0.0]],
        ];
        let runs: Vec<RibRun<'_>> = lines.iter().map(|p| RibRun { points: p, ends: [EndKind::Closed; 2], width_mm: 2.0 }).collect();
        let cup = vent_pockets(&runs, &[], [0.0, 0.0, 1.0], [0.0, 0.0, 1.0], 2.0);
        assert_eq!(cup.pockets.len(), 1);
        let ribs = notch_plain(&lines, &cup.pockets, 2.0);
        let gap_ends = ribs.iter().filter(|rib| rib.1[0] == EndKind::Gap || rib.1[1] == EndKind::Gap).count();
        let again_runs: Vec<RibRun<'_>> = ribs.iter().map(|(p, e)| RibRun { points: p, ends: *e, width_mm: 2.0 }).collect();
        let again = vent_pockets(&again_runs, &[], [0.0, 0.0, 1.0], [0.0, 0.0, 1.0], 2.0);
        assert_eq!(ribs.len(), 5, "{ribs:?}");
        assert_eq!(gap_ends, 2);
        assert_eq!(again.closed, 0, "{again:?}");
        assert!(again.pockets.is_empty());
        let gap_pts: Vec<[f64; 3]> = ribs.iter().flat_map(|(points, ends)| {
            let mut found = Vec::new();
            if ends[0] == EndKind::Gap {
                found.push(points[0]);
            }
            if ends[1] == EndKind::Gap {
                found.push(*points.last().unwrap());
            }
            found
        }).collect();
        let gap = norm(sub(gap_pts[0], gap_pts[1]));
        assert!(near(gap, RESIN_VENT_MM), "{gap}");
        for (points, _) in &ribs {
            assert!(poly_length(points) + 1e-6 >= 2.0, "{}", poly_length(points));
        }
    }

    fn notch_plain(lines: &[Vec<[f64; 3]>], pockets: &[VentPocket], min_length: f64) -> Vec<(Vec<[f64; 3]>, [EndKind; 2])> {
        let mut out = Vec::new();
        for (i, points) in lines.iter().enumerate() {
            let centers: Vec<[f64; 3]> = pockets.iter().filter(|p| p.rib == i).map(|p| p.at).collect();
            if centers.is_empty() {
                out.push((points.clone(), [EndKind::Closed, EndKind::Closed]));
                continue;
            }
            let total = poly_length(points);
            let mut gaps = Vec::new();
            for at in &centers {
                let s = param_of(points, *at).unwrap();
                gaps.push(((s - RESIN_VENT_MM / 2.0).max(0.0), (s + RESIN_VENT_MM / 2.0).min(total)));
            }
            assert!(pieces_fit(total, &gaps, min_length));
            let mut cursor = 0.0;
            let mut spans = Vec::new();
            for gap in &gaps {
                if gap.0 - cursor > WELD {
                    spans.push((cursor, gap.0));
                }
                cursor = gap.1;
            }
            if total - cursor > WELD {
                spans.push((cursor, total));
            }
            for (k, (lo, hi)) in spans.iter().enumerate() {
                let (pts, _) = sample_rib(points, &[], *lo, *hi);
                let start = if k == 0 { EndKind::Closed } else { EndKind::Gap };
                let end = if k + 1 == spans.len() { EndKind::Closed } else { EndKind::Gap };
                out.push((pts, [start, end]));
            }
        }
        out
    }

    #[test]
    fn a_gap_on_a_coarse_mesh_stays_open() {
        use super::super::profile::RibProfile;
        use super::super::select::DRib;
        let mesh = ShellMesh::rectangle([40.0, 30.0], [2, 2], 2.0);
        let surface = Surface::new(&mesh, None);
        let make = |points: Vec<[f64; 3]>| GRib {
            heights: vec![4.0; points.len() - 1],
            d: DRib::fixed(vec![0, 1], 4.0, 2.0, RibProfile::Rectangular),
            points,
        };
        // The centre vertex is (20, 15). A 0.75 mm gap centred on it snaps both ends onto that vertex.
        let mut ribs = vec![
            make(vec![[0.0, 15.0, 0.0], [19.625, 15.0, 0.0]]),
            make(vec![[20.375, 15.0, 0.0], [40.0, 15.0, 0.0]]),
        ];
        let before = (snap_target(&surface, ribs[0].points[1]), snap_target(&surface, ribs[1].points[0]));
        assert_eq!(before.0, before.1, "the fixture must collapse before seating");
        seat_gaps(&surface, &mut ribs, 2.0);
        let (embedded, design, kept, _) = super::super::embed_design(&surface, &ribs, &[]);
        assert_eq!(kept.len(), 2, "both pieces embed");
        let end = |k: usize, last: bool| {
            let chain = &design[k].chain;
            let id = if last { *chain.last().unwrap() } else { chain[0] };
            embedded.pos[id as usize]
        };
        let gap = norm(sub(end(0, true), end(1, false)));
        assert!(gap + 1e-6 >= 0.7 && gap < 1.0, "embedded gap {gap} mm");
        println!("coarse mesh gap after embed: {gap:.4} mm");
    }

    fn read3(v: &serde_json::Value) -> [f64; 3] {
        let a = v.as_array().unwrap();
        [a[0].as_f64().unwrap(), a[1].as_f64().unwrap(), a[2].as_f64().unwrap()]
    }

    fn kind_of(s: &str) -> EndKind {
        match s {
            "free" => EndKind::Free,
            "hold" => EndKind::Hold,
            "gap" => EndKind::Gap,
            _ => EndKind::Closed,
        }
    }
}
