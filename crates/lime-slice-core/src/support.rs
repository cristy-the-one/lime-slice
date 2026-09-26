use rayon::prelude::*;

use crate::adaptive::LayerBand;
use crate::poly::{
    boolean_diff, boolean_union, distance_to_outline, drop_slivers, in_solid, local_diff,
    local_union, loop_bounds, offset_loops, point_in_loop, signed_area, Loop,
};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum SupportStyle {
    #[default]
    Grid,
    Tree,
}

#[derive(Clone, Debug)]
pub struct SupportLayer {
    pub sparse: Vec<Loop>,
    pub interface: Vec<Loop>,
    /// Organic branch centers. Empty for the grid style.
    pub branches: Vec<[f64; 2]>,
    /// Radius of each branch, paired with `branches`. Empty for the grid style.
    pub radii: Vec<f64>,
}

#[derive(Clone, Copy, Debug)]
pub struct SupportOpts {
    pub angle_deg: f64,
    pub xy_gap: f64,
    pub z_gap: f64,
    pub interface_layers: u32,
    pub style: SupportStyle,
    /// Nominal spacing used to seed tree tips. Toughness density tightens it.
    pub branch_spacing: f64,
    /// Max lean from vertical, degrees. Trunks may curve by this much per layer.
    pub branch_angle_deg: f64,
    /// Diameter of a branch where it meets the interface.
    pub tip_diameter: f64,
    /// Diameter of a trunk at the bed, and the cap after merges.
    pub trunk_diameter: f64,
    /// 0 is the speed blend (fewer tips). 1 is toughness (denser tips).
    pub density: f64,
    /// Project steep overhangs. Off skips the angle test and still holds floating islands.
    pub overhangs: bool,
    /// Support a same-layer component that does not rest on material below.
    pub islands: bool,
}

impl Default for SupportOpts {
    fn default() -> Self {
        Self {
            angle_deg: 45.0,
            xy_gap: 0.55,
            z_gap: 0.2,
            interface_layers: 3,
            style: SupportStyle::Grid,
            branch_spacing: 3.6,
            branch_angle_deg: 40.0,
            tip_diameter: 0.8,
            trunk_diameter: 4.2,
            density: 0.2,
            overhangs: true,
            islands: true,
        }
    }
}

/// Project overhangs down to the bed as a sparse column plus a few dense interface layers.
pub fn build_supports(
    bands: &[LayerBand],
    contours: &[Vec<Loop>],
    opts: &SupportOpts,
) -> Vec<SupportLayer> {
    let n = bands.len();
    let mut out = vec![
        SupportLayer {
            sparse: Vec::new(),
            interface: Vec::new(),
            branches: Vec::new(),
            radii: Vec::new(),
        };
        n
    ];
    if n == 0 {
        return out;
    }
    // Cantilevers are not islands. Keep scanning when auto support is on.
    if !opts.overhangs && !opts.islands {
        return out;
    }
    let angle = opts.angle_deg.clamp(15.0, 75.0).to_radians().tan().max(0.2);
    let iface_n = opts.interface_layers.max(1);
    // Everything that depends only on the part is found per layer in parallel.
    // The walk below carries the columns down from each overhang.
    let overhangs: Vec<Vec<Loop>> = (0..n)
        .into_par_iter()
        .map(|i| overhang_at(bands, contours, i, angle, opts))
        .collect();
    let gaps: Vec<Vec<Loop>> = contours
        .par_iter()
        .map(|part| {
            if part.is_empty() {
                Vec::new()
            } else {
                offset_loops(part, opts.xy_gap)
            }
        })
        .collect();

    // (contact_z, region) waiting until the air gap has been cleared.
    let mut pending: Vec<(f64, Vec<Loop>)> = Vec::new();
    // Interface shells still ageing, youngest first. `left` is layers still printed dense.
    let mut gens: Vec<(Vec<Loop>, u32)> = Vec::new();
    let mut sparse: Vec<Loop> = Vec::new();
    let mut nodes: Vec<Node> = Vec::new();
    let mut next_id = 1u32;
    let tree = opts.style == SupportStyle::Tree;
    let density = opts.density.clamp(0.0, 1.0);
    let seed_spacing = (opts.branch_spacing / (0.55 + 0.9 * density)).clamp(2.2, 9.0);
    let tip_r = (opts.tip_diameter * 0.5).clamp(0.25, 1.6);
    let trunk_r = (opts.trunk_diameter * 0.5).max(tip_r + 0.3).clamp(0.6, 8.0);
    let lean = opts.branch_angle_deg.clamp(10.0, 65.0).to_radians().tan();

    for i in (0..n).rev() {
        let mut born: Vec<Loop> = Vec::new();
        pending.retain(|(contact_z, region)| {
            if bands[i].z <= *contact_z + 1e-6 {
                born = boolean_union(&born, region);
                false
            } else {
                true
            }
        });
        let part = contours.get(i).map(Vec::as_slice).unwrap_or(&[]);
        if !born.is_empty() {
            let born = drop_slivers(born, 0.05);
            if tree {
                let cleared = if part.is_empty() {
                    born.clone()
                } else {
                    drop_slivers(
                        boolean_diff(&born, &offset_loops(part, opts.xy_gap * 0.35)),
                        0.02,
                    )
                };
                let seeds = if cleared.is_empty() { &born } else { &cleared };
                for p in sample_grid(seeds, seed_spacing) {
                    nodes.push(Node {
                        id: next_id,
                        xy: p,
                        radius: tip_r,
                        dist: 0.0,
                        freeze: iface_n,
                    });
                    next_id += 1;
                }
            }
            gens.insert(0, (born, iface_n));
        }

        let gap = &gaps[i];
        let iface_area = union_all(gens.iter().map(|(r, _)| r.as_slice()));
        let iface_print = drop_slivers(boolean_diff(&iface_area, gap), 0.05);
        let (sparse_print, branch_pts, branch_r) = if tree {
            if i == 0 {
                for n in &mut nodes {
                    if n.freeze == 0 {
                        n.radius = n.radius.max(trunk_r * 0.95);
                    }
                }
            }
            let (pts, rs) = organic_disks(&nodes, part, opts.xy_gap);
            (Vec::new(), pts, rs)
        } else {
            let sparse_only = local_diff(&sparse, &iface_area);
            let sparse_print = drop_slivers(local_diff(&sparse_only, gap), 0.05);
            (sparse_print, Vec::new(), Vec::new())
        };
        out[i] = SupportLayer {
            sparse: sparse_print,
            interface: iface_print,
            branches: branch_pts,
            radii: branch_r,
        };

        // A column that has landed on the model stops.
        let mut next_gens = Vec::new();
        for (region, left) in gens {
            let trimmed = drop_slivers(boolean_diff(&region, part), 0.15);
            if trimmed.is_empty() {
                continue;
            }
            if left <= 1 {
                // Trees print their own trunks; only the grid keeps a column region.
                if !tree {
                    sparse = local_union(&sparse, &trimmed);
                }
            } else {
                next_gens.push((trimmed, left - 1));
            }
        }
        gens = next_gens;
        if !tree {
            sparse = drop_slivers(local_diff(&sparse, part), 0.15);
        }
        if tree && i > 0 {
            let below = contours.get(i - 1).map(Vec::as_slice).unwrap_or(&[]);
            let below2 = if i > 1 {
                contours.get(i - 2).map(Vec::as_slice).unwrap_or(&[])
            } else {
                &[]
            };
            nodes = propagate_nodes(
                nodes,
                below,
                below2,
                &Grow {
                    height: bands[i].height,
                    lean,
                    tip_r,
                    trunk_r,
                    xy_gap: opts.xy_gap,
                    next_is_bed: i == 1,
                },
            );
        }

        let overhang = &overhangs[i];
        if overhang.is_empty() {
            continue;
        }
        let underside = bands[i].z - bands[i].height;
        pending.push((underside - opts.z_gap, overhang.clone()));
    }
    out
}

/// Area of layer `i` that needs a column under it: past the overhang angle,
/// a floating island, or (with overhangs off) a wing too long to bridge.
fn overhang_at(
    bands: &[LayerBand],
    contours: &[Vec<Loop>],
    i: usize,
    angle: f64,
    opts: &SupportOpts,
) -> Vec<Loop> {
    if i == 0 {
        return Vec::new();
    }
    let upper = contours.get(i).map(Vec::as_slice).unwrap_or(&[]);
    let lower = contours.get(i - 1).map(Vec::as_slice).unwrap_or(&[]);
    if upper.is_empty() {
        return Vec::new();
    }
    let dx = bands[i].height / angle;
    // Islands and one-sided wings both print in air. The overhang toggle
    // still adds short bridge decks, which can span two anchors.
    let supported = offset_loops(lower, dx);
    let angle_overhang = drop_slivers(boolean_diff(upper, &supported), 0.35);
    let islands = if opts.islands {
        unsupported_islands(upper, lower, dx)
    } else {
        Vec::new()
    };
    let overhang = if islands.is_empty() {
        angle_overhang
    } else {
        // Keep a small island the angle test would drop as a sliver.
        drop_slivers(boolean_union(&angle_overhang, &islands), 0.05)
    };
    if opts.overhangs {
        overhang
    } else {
        exclude_short_bridges(&overhang, lower, dx)
    }
}

/// A disk may overhang the one below by about half a bead and still print.
const BEAD_OVERHANG_MM: f64 = 0.22;
/// Thinnest trunk disk drawn beside the part.
const MIN_DISK_R: f64 = 0.3;

struct Node {
    id: u32,
    xy: [f64; 2],
    radius: f64,
    dist: f64,
    freeze: u32,
}

/// Trunk disks to print on this layer. A disk that would reach into the XY gap
/// is drawn smaller rather than dropped, so the trunk under it never breaks.
fn organic_disks(nodes: &[Node], part: &[Loop], xy_gap: f64) -> (Vec<[f64; 2]>, Vec<f64>) {
    let mut pts = Vec::new();
    let mut radii = Vec::new();
    for n in nodes {
        if n.freeze > 0 {
            continue;
        }
        let room = if part.is_empty() {
            f64::MAX
        } else if in_solid(part, n.xy[0], n.xy[1]) {
            continue;
        } else {
            distance_to_outline(part, n.xy) - xy_gap
        };
        pts.push(n.xy);
        radii.push(n.radius.min(room).max(MIN_DISK_R));
    }
    (pts, radii)
}

struct Grow {
    height: f64,
    lean: f64,
    tip_r: f64,
    trunk_r: f64,
    xy_gap: f64,
    next_is_bed: bool,
}

/// Step every unfrozen node down one layer: lean toward siblings, thicken, merge, and
/// stop on a supported mesh face. Frozen nodes are the vertical interface tips.
fn propagate_nodes(nodes: Vec<Node>, below: &[Loop], below2: &[Loop], grow: &Grow) -> Vec<Node> {
    let max_step = (grow.height * grow.lean).clamp(0.05, 4.0);
    let cloud: Vec<[f64; 2]> = nodes
        .iter()
        .filter(|n| n.freeze == 0)
        .map(|n| n.xy)
        .collect();
    let mut next = Vec::with_capacity(nodes.len());
    for mut n in nodes {
        if n.freeze > 0 {
            n.freeze -= 1;
            next.push(n);
            continue;
        }
        if !below.is_empty() && in_solid(below, n.xy[0], n.xy[1]) {
            let supported = below2.is_empty() || in_solid(below2, n.xy[0], n.xy[1]);
            if supported {
                continue;
            }
        }
        n.xy = lean_toward(n.xy, &cloud, max_step);
        n.dist += grow.height;
        let grown = grow.tip_r + (grow.trunk_r - grow.tip_r) * (1.0 - (-n.dist / 7.5).exp());
        n.radius = grown.max(n.radius).min(grow.trunk_r);
        n.xy = push_out(n.xy, below, grow.xy_gap + n.radius, max_step);
        if in_solid(below, n.xy[0], n.xy[1]) {
            continue;
        }
        if grow.next_is_bed {
            n.radius = n.radius.max(grow.trunk_r * 0.95);
        }
        next.push(n);
    }
    merge_nodes(&mut next, grow.trunk_r, max_step + BEAD_OVERHANG_MM);
    next
}

fn lean_toward(xy: [f64; 2], cloud: &[[f64; 2]], max_step: f64) -> [f64; 2] {
    let mut sx = 0.0;
    let mut sy = 0.0;
    let mut w = 0.0;
    for p in cloud {
        let dx = p[0] - xy[0];
        let dy = p[1] - xy[1];
        let d = dx.hypot(dy);
        if !(0.2..=22.0).contains(&d) {
            continue;
        }
        let weight = (22.0 - d) / d;
        sx += p[0] * weight;
        sy += p[1] * weight;
        w += weight;
    }
    if w < 1e-6 {
        return xy;
    }
    let cx = sx / w;
    let cy = sy / w;
    let dx = cx - xy[0];
    let dy = cy - xy[1];
    let dist = dx.hypot(dy);
    if dist < 0.15 {
        return xy;
    }
    let step = max_step.min(dist);
    [xy[0] + dx / dist * step, xy[1] + dy / dist * step]
}

/// Step toward the nearest point at least `clearance` from `part`, at most
/// `max_step`. A node that needs a longer move takes it over several layers,
/// so every disk still sits on the one under it.
fn push_out(xy: [f64; 2], part: &[Loop], clearance: f64, max_step: f64) -> [f64; 2] {
    let blocked =
        |p: [f64; 2]| in_solid(part, p[0], p[1]) || distance_to_outline(part, p) < clearance;
    if part.is_empty() || !blocked(xy) {
        return xy;
    }
    let mut best: Option<[f64; 2]> = None;
    let mut best_d = f64::MAX;
    for i in 0..20 {
        let a = i as f64 * std::f64::consts::TAU / 20.0;
        let (c, s) = (a.cos(), a.sin());
        let mut d = 0.35;
        while d <= 36.0 {
            let p = [xy[0] + c * d, xy[1] + s * d];
            if !blocked(p) {
                if d < best_d {
                    best_d = d;
                    best = Some(p);
                }
                break;
            }
            d += 0.55;
        }
    }
    let Some(p) = best else {
        return xy;
    };
    let dx = p[0] - xy[0];
    let dy = p[1] - xy[1];
    let dist = dx.hypot(dy).max(1e-9);
    let travel = max_step.min(dist);
    [xy[0] + dx / dist * travel, xy[1] + dy / dist * travel]
}

/// Merge a node into an earlier one when the merged trunk, centred between them
/// by radius, still covers both disks to within `reach`.
fn merge_nodes(nodes: &mut Vec<Node>, trunk_r: f64, reach: f64) {
    if nodes.len() < 2 {
        return;
    }
    nodes.sort_by_key(|n| n.id);
    let mut kept: Vec<Node> = Vec::new();
    for n in nodes.drain(..) {
        if n.freeze > 0 {
            kept.push(n);
            continue;
        }
        if let Some(host) = kept.iter_mut().find(|k| {
            if k.freeze > 0 {
                return false;
            }
            let d = (k.xy[0] - n.xy[0]).hypot(k.xy[1] - n.xy[1]);
            let merged = (k.radius.powi(2) + n.radius.powi(2)).sqrt().min(trunk_r);
            let w = k.radius + n.radius;
            // Each disk's centre moves toward the other by the other's share of the radius.
            let shift_k = d * n.radius / w;
            let shift_n = d * k.radius / w;
            shift_k + k.radius <= merged + reach && shift_n + n.radius <= merged + reach
        }) {
            let w = host.radius + n.radius;
            host.xy = [
                (host.xy[0] * host.radius + n.xy[0] * n.radius) / w,
                (host.xy[1] * host.radius + n.xy[1] * n.radius) / w,
            ];
            host.radius = (host.radius.powi(2) + n.radius.powi(2)).sqrt().min(trunk_r);
            host.dist = host.dist.max(n.dist);
            if n.id < host.id {
                host.id = n.id;
            }
        } else {
            kept.push(n);
        }
    }
    *nodes = kept;
}

fn sample_grid(region: &[Loop], spacing: f64) -> Vec<[f64; 2]> {
    let Some((min, max)) = loop_bounds(region) else {
        return Vec::new();
    };
    let mut pts = Vec::new();
    let mut y = min[1] + spacing * 0.5;
    while y < max[1] {
        let mut x = min[0] + spacing * 0.5;
        while x < max[0] {
            if in_solid(region, x, y) {
                pts.push([x, y]);
            }
            x += spacing;
        }
        y += spacing;
    }
    if pts.is_empty() {
        if let Some((min, max)) = loop_bounds(region) {
            let c = [(min[0] + max[0]) * 0.5, (min[1] + max[1]) * 0.5];
            if in_solid(region, c[0], c[1]) {
                pts.push(c);
            }
        }
    }
    pts
}

/// A deck this short, held on two opposite sides, can bridge. Longer spans
/// and one-sided wings still get a column.
const BRIDGE_SPAN_MM: f64 = 18.0;

/// Drop air regions that sit between two anchors. A wing that only meets the
/// part on one side stays. `margin` matches the overhang offset.
fn exclude_short_bridges(air: &[Loop], lower: &[Loop], margin: f64) -> Vec<Loop> {
    if air.is_empty() {
        return Vec::new();
    }
    let bed = offset_loops(lower, margin.max(0.0));
    if bed.is_empty() {
        return air.to_vec();
    }
    let mut keep = Vec::new();
    for comp in components(air) {
        if short_bridge(&comp, &bed) {
            continue;
        }
        keep = boolean_union(&keep, &comp);
    }
    drop_slivers(keep, 0.05)
}

fn short_bridge(comp: &[Loop], bed: &[Loop]) -> bool {
    let Some((min, max)) = loop_bounds(comp) else {
        return false;
    };
    let grown = offset_loops(comp, 0.45);
    let contact = intersection(bed, &grown);
    if contact.is_empty() {
        return false;
    }
    let mut left = false;
    let mut right = false;
    let mut bottom = false;
    let mut top = false;
    for piece in components(&contact) {
        let c = centroid(&piece[0]);
        let dl = c[0] - min[0];
        let dr = max[0] - c[0];
        let db = c[1] - min[1];
        let dt = max[1] - c[1];
        let nearest = dl.min(dr).min(db).min(dt);
        if nearest > 2.0 {
            continue;
        }
        if dl <= nearest + 1e-9 {
            left = true;
        } else if dr <= nearest + 1e-9 {
            right = true;
        } else if db <= nearest + 1e-9 {
            bottom = true;
        } else {
            top = true;
        }
    }
    let span_x = max[0] - min[0];
    let span_y = max[1] - min[1];
    (left && right && span_x <= BRIDGE_SPAN_MM) || (bottom && top && span_y <= BRIDGE_SPAN_MM)
}

fn intersection(a: &[Loop], b: &[Loop]) -> Vec<Loop> {
    if a.is_empty() || b.is_empty() {
        return Vec::new();
    }
    let outside = boolean_diff(a, b);
    drop_slivers(boolean_diff(a, &outside), 0.02)
}

/// A component with no material below it, and no same-layer link to a component
/// that does, cannot be printed in the air. `margin` is the support threshold.
fn unsupported_islands(upper: &[Loop], lower: &[Loop], margin: f64) -> Vec<Loop> {
    let comps = components(upper);
    if comps.is_empty() {
        return Vec::new();
    }
    let mut grounded = vec![false; comps.len()];
    for (i, comp) in comps.iter().enumerate() {
        grounded[i] = rests_on(comp, lower, margin);
    }
    let mut changed = true;
    while changed {
        changed = false;
        for i in 0..comps.len() {
            if grounded[i] {
                continue;
            }
            for j in 0..comps.len() {
                if i == j || !grounded[j] {
                    continue;
                }
                if components_touch(&comps[i], &comps[j], 0.8) {
                    grounded[i] = true;
                    changed = true;
                    break;
                }
            }
        }
    }
    let mut islands = Vec::new();
    for (i, comp) in comps.into_iter().enumerate() {
        if !grounded[i] {
            islands = boolean_union(&islands, &comp);
        }
    }
    drop_slivers(islands, 0.05)
}

fn components(loops: &[Loop]) -> Vec<Vec<Loop>> {
    let mut comps: Vec<Vec<Loop>> = Vec::new();
    let mut outer_area = Vec::new();
    for loop_ in loops {
        let area = signed_area(loop_);
        if area > 0.02 {
            comps.push(vec![loop_.clone()]);
            outer_area.push(area);
        }
    }
    for loop_ in loops {
        if signed_area(loop_) >= 0.0 {
            continue;
        }
        let c = centroid(loop_);
        let mut host: Option<usize> = None;
        let mut host_area = f64::MAX;
        for (i, outer) in comps.iter().enumerate() {
            if point_in_loop(&outer[0], c[0], c[1]) && outer_area[i] < host_area {
                host = Some(i);
                host_area = outer_area[i];
            }
        }
        if let Some(i) = host {
            comps[i].push(loop_.clone());
        }
    }
    comps
}

fn centroid(loop_: &[[f64; 2]]) -> [f64; 2] {
    let mut a = 0.0;
    let mut cx = 0.0;
    let mut cy = 0.0;
    for i in 0..loop_.len() {
        let p = loop_[i];
        let q = loop_[(i + 1) % loop_.len()];
        let cross = p[0] * q[1] - q[0] * p[1];
        a += cross;
        cx += (p[0] + q[0]) * cross;
        cy += (p[1] + q[1]) * cross;
    }
    if a.abs() < 1e-12 {
        let n = loop_.len().max(1) as f64;
        return [
            loop_.iter().map(|p| p[0]).sum::<f64>() / n,
            loop_.iter().map(|p| p[1]).sum::<f64>() / n,
        ];
    }
    [cx / (3.0 * a), cy / (3.0 * a)]
}

fn solid_area(loops: &[Loop]) -> f64 {
    let area = loops.iter().map(|l| signed_area(l)).sum::<f64>();
    area.max(0.0)
}

fn rests_on(comp: &[Loop], lower: &[Loop], margin: f64) -> bool {
    if lower.is_empty() || solid_area(comp) < 0.05 {
        return false;
    }
    let bed = offset_loops(lower, margin.max(0.0));
    overlaps(comp, &bed, 0.05)
}

fn components_touch(a: &[Loop], b: &[Loop], gap: f64) -> bool {
    let grown = offset_loops(a, gap);
    overlaps(&grown, b, 0.02)
}

fn overlaps(a: &[Loop], b: &[Loop], min_area: f64) -> bool {
    if a.is_empty() || b.is_empty() {
        return false;
    }
    let uncovered = boolean_diff(b, a);
    solid_area(b) - solid_area(&uncovered) > min_area
}

fn union_all<'a>(regions: impl Iterator<Item = &'a [Loop]>) -> Vec<Loop> {
    let mut acc: Vec<Loop> = Vec::new();
    for region in regions {
        acc = boolean_union(&acc, region);
    }
    acc
}
