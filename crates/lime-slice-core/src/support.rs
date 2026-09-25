use crate::adaptive::LayerBand;
use crate::contour::{in_solid, loop_bounds, point_in_loop, signed_area, Loop};
use crate::toolpath::{boolean_diff, boolean_union, drop_slivers, offset_loops};

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
    /// Tree trunk centers. Empty for the grid style.
    pub branches: Vec<[f64; 2]>,
}

#[derive(Clone, Copy, Debug)]
pub struct SupportOpts {
    pub angle_deg: f64,
    pub xy_gap: f64,
    pub z_gap: f64,
    pub interface_layers: u32,
    pub style: SupportStyle,
    /// Nominal spacing used to seed tree branches. Density still thins them later.
    pub branch_spacing: f64,
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
        };
        n
    ];
    if n == 0 {
        return out;
    }
    let angle = opts.angle_deg.clamp(15.0, 75.0).to_radians().tan().max(0.2);
    let iface_n = opts.interface_layers.max(1);
    let mut island_regions = vec![Vec::new(); n];
    if opts.islands {
        for i in 1..n {
            let upper = contours.get(i).map(Vec::as_slice).unwrap_or(&[]);
            let lower = contours.get(i - 1).map(Vec::as_slice).unwrap_or(&[]);
            if upper.is_empty() {
                continue;
            }
            let dx = bands[i].height / angle;
            island_regions[i] = unsupported_islands(upper, lower, dx);
        }
    }
    if !opts.overhangs && island_regions.iter().all(|r| r.is_empty()) {
        return out;
    }

    // (contact_z, region) waiting until the air gap has been cleared.
    let mut pending: Vec<(f64, Vec<Loop>)> = Vec::new();
    // Interface shells still ageing, youngest first. `left` is layers still printed dense.
    let mut gens: Vec<(Vec<Loop>, u32)> = Vec::new();
    let mut sparse: Vec<Loop> = Vec::new();
    let mut branches: Vec<Branch> = Vec::new();
    let mut next_id = 1u32;
    let tree = opts.style == SupportStyle::Tree;
    let seed_spacing = opts.branch_spacing.clamp(2.2, 8.0);

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
        if !born.is_empty() {
            let born = drop_slivers(born, 0.05);
            if tree {
                for p in sample_grid(&born, seed_spacing) {
                    branches.push(Branch { id: next_id, xy: p });
                    next_id += 1;
                }
            }
            gens.insert(0, (born, iface_n));
        }

        let part = contours.get(i).map(Vec::as_slice).unwrap_or(&[]);
        let gap = if part.is_empty() {
            Vec::new()
        } else {
            offset_loops(part, opts.xy_gap)
        };
        let iface_area = union_all(gens.iter().map(|(r, _)| r.as_slice()));
        let iface_print = drop_slivers(boolean_diff(&iface_area, &gap), 0.05);
        let sparse_only = boolean_diff(&sparse, &iface_area);
        let sparse_print = drop_slivers(boolean_diff(&sparse_only, &gap), 0.05);
        let (sparse_print, branch_pts) = if tree {
            let alive = boolean_union(&sparse_print, &iface_print);
            branches.retain(|b| in_solid(&alive, b.xy[0], b.xy[1]));
            let pts: Vec<[f64; 2]> = branches
                .iter()
                .filter(|b| in_solid(&sparse_print, b.xy[0], b.xy[1]))
                .map(|b| b.xy)
                .collect();
            (Vec::new(), pts)
        } else {
            (sparse_print, Vec::new())
        };
        out[i] = SupportLayer {
            sparse: sparse_print,
            interface: iface_print,
            branches: branch_pts,
        };

        // A column that has landed on the model stops.
        let mut next_gens = Vec::new();
        for (region, left) in gens {
            let trimmed = drop_slivers(boolean_diff(&region, part), 0.15);
            if trimmed.is_empty() {
                continue;
            }
            if left <= 1 {
                sparse = boolean_union(&sparse, &trimmed);
            } else {
                next_gens.push((trimmed, left - 1));
            }
        }
        gens = next_gens;
        sparse = drop_slivers(boolean_diff(&sparse, part), 0.15);
        if tree {
            let step = bands[i].height * 0.85;
            lean_and_merge(&mut branches, step);
        }

        if i == 0 {
            continue;
        }
        let upper = contours.get(i).map(Vec::as_slice).unwrap_or(&[]);
        let lower = contours.get(i - 1).map(Vec::as_slice).unwrap_or(&[]);
        if upper.is_empty() {
            continue;
        }
        let dx = bands[i].height / angle;
        let angle_overhang = if opts.overhangs {
            let supported = offset_loops(lower, dx);
            drop_slivers(boolean_diff(upper, &supported), 0.35)
        } else {
            Vec::new()
        };
        let islands = island_regions.get(i).map(Vec::as_slice).unwrap_or(&[]);
        let overhang = if islands.is_empty() {
            angle_overhang
        } else {
            // Keep a small island the angle test would drop as a sliver.
            drop_slivers(boolean_union(&angle_overhang, islands), 0.05)
        };
        if overhang.is_empty() {
            continue;
        }
        let underside = bands[i].z - bands[i].height;
        pending.push((underside - opts.z_gap, overhang));
    }
    out
}

struct Branch {
    id: u32,
    xy: [f64; 2],
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

fn lean_and_merge(branches: &mut Vec<Branch>, step: f64) {
    if branches.is_empty() {
        return;
    }
    let n = branches.len() as f64;
    let cx = branches.iter().map(|b| b.xy[0]).sum::<f64>() / n;
    let cy = branches.iter().map(|b| b.xy[1]).sum::<f64>() / n;
    for b in branches.iter_mut() {
        let dx = cx - b.xy[0];
        let dy = cy - b.xy[1];
        let dist = dx.hypot(dy);
        if dist > 0.4 {
            let move_d = step.min(dist * 0.35);
            b.xy[0] += dx / dist * move_d;
            b.xy[1] += dy / dist * move_d;
        }
    }
    branches.sort_by_key(|b| b.id);
    let mut kept: Vec<Branch> = Vec::new();
    for b in branches.drain(..) {
        if let Some(host) = kept.iter_mut().find(|k| {
            let dx = k.xy[0] - b.xy[0];
            let dy = k.xy[1] - b.xy[1];
            dx * dx + dy * dy < 2.4 * 2.4
        }) {
            if b.id < host.id {
                host.id = b.id;
                host.xy = b.xy;
            }
        } else {
            kept.push(b);
        }
    }
    *branches = kept;
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
