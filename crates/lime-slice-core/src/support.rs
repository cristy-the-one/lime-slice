use rayon::prelude::*;

use crate::adaptive::LayerBand;
use crate::poly::{
    boolean_diff, boolean_union, distance_to_outline, drop_slivers, in_solid, local_diff,
    local_union, loop_bounds, offset_loops, point_in_loop, signed_area, Loop,
};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum SupportStyle {
    Grid,
    #[default]
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
    /// How many fresh tips one tip-sized cross-section may carry.
    /// `0` derives from `density`. Higher lets one trunk swallow more neighbours.
    /// Capacity then grows with cross-section and falls as the branch gets long.
    pub load_factor: f64,
    /// Farthest a dropped tip may sit from the neighbour that carries its interface, mm.
    /// `0` derives a pitch from `branch_spacing` and `density`. Wider means fewer tips.
    pub max_tip_spacing: f64,
    /// Project steep overhangs. Off skips the angle test and still holds floating islands.
    pub overhangs: bool,
    /// Support a same-layer component that does not rest on material below.
    pub islands: bool,
    /// Stop the walk early when this slice has been superseded.
    pub job: crate::cancel::Job,
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
            load_factor: 0.0,
            max_tip_spacing: 0.0,
            overhangs: true,
            islands: true,
            job: crate::cancel::Job::default(),
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
    // Fine grid finds concave overhangs. `keep_spacing` is the pitch we actually
    // leave standing: extra samples are packed onto a neighbour that can carry them.
    let fine_spacing = (opts.branch_spacing / (0.55 + 0.9 * density)).clamp(2.2, 9.0);
    let keep_spacing = tip_spacing(opts, fine_spacing);
    // A tighter knob than the fine grid has to actually sample tighter.
    let sample_spacing = fine_spacing.min(keep_spacing);
    let load_factor = load_factor_of(opts);
    let tip_r = (opts.tip_diameter * 0.5).clamp(0.25, 1.6);
    let trunk_r = (opts.trunk_diameter * 0.5).max(tip_r + 0.3).clamp(0.6, 8.0);
    let lean = opts.branch_angle_deg.clamp(10.0, 65.0).to_radians().tan();
    let tip_cap = tip_capacity(tip_r, 0.0, tip_r, load_factor);
    let pitch = Pitch {
        fine: sample_spacing,
        keep: keep_spacing,
        capacity: tip_cap,
    };
    let part_bb: Vec<Option<([f64; 2], [f64; 2])>> =
        contours.iter().map(|c| loop_bounds(c)).collect();

    for i in (0..n).rev() {
        if opts.job.cancelled() {
            break;
        }
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
                for (p, load, to_bed) in sample_tips(
                    seeds,
                    &pitch,
                    &Land {
                        layer: i,
                        freeze: iface_n,
                        lean,
                        bands,
                        contours,
                        bounds: &part_bb,
                    },
                ) {
                    nodes.push(Node {
                        id: next_id,
                        xy: p,
                        radius: tip_r,
                        dist: 0.0,
                        freeze: iface_n,
                        load,
                        to_bed,
                    });
                    next_id += 1;
                }
            }
            gens.insert(0, (born, iface_n));
        }

        let gap = &gaps[i];
        let iface_area = union_all(gens.iter().map(|(r, _)| r.as_slice()));
        let iface_print = drop_slivers(boolean_diff(&iface_area, gap), 0.05);
        if tree {
            // Tips frozen at birth stay put while the part silhouette moves.
            // A patch that slid off every tip needs its own trunk, starting
            // on the very next layer, or the interface prints over air.
            seed_uncovered_interface(
                &iface_print,
                &mut nodes,
                &mut next_id,
                tip_r,
                &pitch,
                &Land {
                    layer: i,
                    freeze: 1,
                    lean,
                    bands,
                    contours,
                    bounds: &part_bb,
                },
            );
        }
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
                    load_factor,
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
    if tree {
        settle_disks(&mut out, bands, contours, lean);
    }
    // A trunk that cannot stand is dropped above. The interface that was
    // waiting on it would otherwise stay as a raft in the air.
    drop_unfooted_interface(&mut out, contours);
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
/// Clipper slop when an interface patch is tested against the layer under it.
const INTERFACE_FOOT_MM: f64 = 0.35;
/// Thinnest trunk disk drawn beside the part.
const MIN_DISK_R: f64 = 0.3;

/// Walk the trunks bottom-up and narrow any disk that is wider than what holds
/// it: a disk on the layer below grown by one lean step and half a bead, or
/// the part itself. The top-down walk shrinks disks beside the part, so the
/// disk above a squeezed one would otherwise overhang it. A disk whose room is
/// below the minimum printable radius cannot stand; flooring it to that radius
/// would print a speck in the air, so the disk is dropped and the trunk above
/// it has to find its own footing.
fn settle_disks(
    layers: &mut [SupportLayer],
    bands: &[LayerBand],
    contours: &[Vec<Loop>],
    lean: f64,
) {
    for i in 1..layers.len() {
        let reach = bands[i].height * lean + BEAD_OVERHANG_MM;
        let (lower, upper) = layers.split_at_mut(i);
        let below = &lower[i - 1];
        let part = contours.get(i - 1).map(Vec::as_slice).unwrap_or(&[]);
        let layer = &mut upper[0];
        let mut kept_c = Vec::with_capacity(layer.branches.len());
        let mut kept_r = Vec::with_capacity(layer.radii.len());
        for (c, r) in layer.branches.iter().zip(&layer.radii) {
            let mut room = below
                .branches
                .iter()
                .zip(&below.radii)
                .map(|(b, rb)| rb + reach - (c[0] - b[0]).hypot(c[1] - b[1]))
                .fold(f64::NEG_INFINITY, f64::max);
            if !part.is_empty() && in_solid(part, c[0], c[1]) {
                room = room.max(distance_to_outline(part, *c) + reach);
            }
            if room < MIN_DISK_R {
                continue;
            }
            kept_c.push(*c);
            kept_r.push((*r).min(room));
        }
        layer.branches = kept_c;
        layer.radii = kept_r;
    }
}

struct Node {
    id: u32,
    xy: [f64; 2],
    radius: f64,
    /// Millimetres this branch has already fallen. Longer branches hold less.
    dist: f64,
    freeze: u32,
    /// Fine-grid tips whose interface this branch is carrying.
    load: f64,
    /// This tip cannot lean onto a roof, so it has to reach the bed.
    /// It may merge with other bed tips, not with one that lands on the model.
    to_bed: bool,
}

/// Trunk disks to print on this layer. A disk that would reach into the XY gap
/// is drawn smaller rather than dropped, so the trunk under it never breaks.
/// Flooring that disk through the wall would leave support inside the mesh, so
/// a centre closer than the minimum radius is omitted and the trunk stops.
fn organic_disks(nodes: &[Node], part: &[Loop], xy_gap: f64) -> (Vec<[f64; 2]>, Vec<f64>) {
    let mut pts = Vec::new();
    let mut radii = Vec::new();
    for n in nodes {
        if n.freeze > 0 {
            continue;
        }
        let dist = if part.is_empty() {
            f64::MAX
        } else if in_solid(part, n.xy[0], n.xy[1]) {
            continue;
        } else {
            distance_to_outline(part, n.xy)
        };
        if dist < MIN_DISK_R {
            continue;
        }
        let room = dist - xy_gap;
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
    load_factor: f64,
}

/// Pitch actually left standing. An explicit `max_tip_spacing` wins; otherwise
/// the fine seed grid is opened up, more at speed than at toughness.
fn tip_spacing(opts: &SupportOpts, fine: f64) -> f64 {
    if opts.max_tip_spacing > 0.0 {
        return opts.max_tip_spacing.clamp(2.8, 14.0);
    }
    let density = opts.density.clamp(0.0, 1.0);
    // Speed (density 0.15) opens a ~5 mm grid to ~11 mm. Toughness stays near 3.4 mm.
    let widen = 2.15 - 0.78 * density;
    (fine * widen).clamp(fine, 12.0)
}

/// Tip-units one tip-sized cross-section may carry. An explicit `load_factor` wins.
fn load_factor_of(opts: &SupportOpts) -> f64 {
    if opts.load_factor > 0.0 {
        return opts.load_factor.clamp(0.75, 12.0);
    }
    let density = opts.density.clamp(0.0, 1.0);
    (5.8 - 4.3 * density).clamp(1.05, 8.0)
}

/// How many tip-units a branch of this radius can carry after falling `length` mm.
/// Section area scales with r². Past a short neck, length trims capacity so a
/// long wand does not keep swallowing neighbours the way a short trunk can.
fn tip_capacity(radius: f64, length: f64, tip_r: f64, load_factor: f64) -> f64 {
    let section = (radius / tip_r.max(0.2)).powi(2);
    let slender = 1.0 + (length / 28.0).max(0.0);
    load_factor.max(0.5) * section / slender
}

/// Radius required to carry `load`, before the trunk cap and the stability floor.
fn section_radius(load: f64, tip_r: f64, load_factor: f64) -> f64 {
    let factor = load_factor.max(0.5);
    tip_r * (load.max(1.0) / factor).sqrt()
}

/// Organic thickness: enough section for the load, and a stability floor that
/// grows with fall distance so a lone trunk is not a hair all the way to the bed.
fn branch_radius(load: f64, dist: f64, tip_r: f64, trunk_r: f64, load_factor: f64) -> f64 {
    let loaded = section_radius(load, tip_r, load_factor);
    // Same fall curve as a lone trunk used to grow, so a single branch is not
    // left as a hair. Load stacks on top of that and is capped at the trunk.
    // Speed (high load factor) keeps a lone shaft slimmer so neighbours can join
    // and the path stays short. Toughness keeps the old 7.5 mm flare.
    let tau = (6.2 + 1.5 * load_factor).clamp(7.5, 16.0);
    let stable = tip_r + (trunk_r - tip_r) * (1.0 - (-dist / tau).exp());
    loaded.max(stable).clamp(tip_r, trunk_r)
}

/// Step every unfrozen node down one layer: lean toward nearby trunks, thicken
/// for the load they already carry, merge when one trunk can hold both, and
/// stop on a supported mesh face. Frozen nodes are the interface tips and do not move.
fn propagate_nodes(nodes: Vec<Node>, below: &[Loop], below2: &[Loop], grow: &Grow) -> Vec<Node> {
    let max_step = (grow.height * grow.lean).clamp(0.05, 4.0);
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
        next.push(n);
    }
    let cloud: Vec<[f64; 2]> = next
        .iter()
        .filter(|n| n.freeze == 0)
        .map(|n| n.xy)
        .collect();
    for n in &mut next {
        if n.freeze == 0 {
            n.xy = lean_toward(n.xy, &cloud, max_step);
        }
    }
    let mut kept = Vec::with_capacity(next.len());
    for mut n in next {
        if n.freeze > 0 {
            kept.push(n);
            continue;
        }
        n.dist += grow.height;
        let grown = branch_radius(n.load, n.dist, grow.tip_r, grow.trunk_r, grow.load_factor);
        n.radius = grown.max(n.radius).min(grow.trunk_r);
        n.xy = push_out(n.xy, below, grow.xy_gap + n.radius, max_step);
        if in_solid(below, n.xy[0], n.xy[1]) {
            continue;
        }
        kept.push(n);
    }
    merge_nodes(&mut kept, grow, max_step + BEAD_OVERHANG_MM);
    if grow.next_is_bed {
        for n in &mut kept {
            if n.freeze == 0 {
                n.radius = n.radius.max(grow.trunk_r * 0.95);
            }
        }
    }
    kept
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
    step_toward(xy, [cx, cy], max_step)
}

fn step_toward(xy: [f64; 2], target: [f64; 2], max_step: f64) -> [f64; 2] {
    let dx = target[0] - xy[0];
    let dy = target[1] - xy[1];
    let dist = dx.hypot(dy);
    if dist < 1e-6 || dist <= max_step {
        return target;
    }
    let scale = max_step / dist;
    [xy[0] + dx * scale, xy[1] + dy * scale]
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

/// Merge a node into an earlier one when the host can carry the combined load
/// and the merged trunk still holds both parent disks. The trunk is thickened
/// to the radius that cone requires, up to the trunk cap.
fn merge_nodes(nodes: &mut Vec<Node>, grow: &Grow, reach: f64) {
    if nodes.len() < 2 {
        return;
    }
    let slack = reach.min(BEAD_OVERHANG_MM);
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
            // A bed tip and a model tip may join only after they have walked
            // up to each other. A longer jump would drop the overhang that
            // still cannot lean onto the part.
            if k.to_bed != n.to_bed {
                let d = (k.xy[0] - n.xy[0]).hypot(k.xy[1] - n.xy[1]);
                if d > reach {
                    return false;
                }
            }
            (grow.load_factor >= 3.0 && merge_need(k, &n, grow, slack).is_some())
                || legacy_merge(k, &n, grow.trunk_r, reach)
        }) {
            let d = (host.xy[0] - n.xy[0]).hypot(host.xy[1] - n.xy[1]);
            let w = (host.radius + n.radius).max(1e-6);
            let shift_k = d * n.radius / w;
            let shift_n = d * host.radius / w;
            host.xy = [
                (host.xy[0] * host.radius + n.xy[0] * n.radius) / w,
                (host.xy[1] * host.radius + n.xy[1] * n.radius) / w,
            ];
            host.load += n.load;
            host.dist = host.dist.max(n.dist);
            let need = (shift_k + host.radius - slack)
                .max(shift_n + n.radius - slack)
                .max(host.radius)
                .max(n.radius)
                .max(section_radius(host.load, grow.tip_r, grow.load_factor));
            let area = (host.radius.powi(2) + n.radius.powi(2))
                .sqrt()
                .min(grow.trunk_r);
            // Cone thickening is the speed path. Toughness keeps the area-sum
            // radius so a dense grid does not swell into longer perimeters.
            let covered = if grow.load_factor >= 3.0 && need <= grow.trunk_r + 1e-6 {
                need
            } else {
                area
            };
            host.radius = branch_radius(
                host.load,
                host.dist,
                grow.tip_r,
                grow.trunk_r,
                grow.load_factor,
            )
            .max(covered)
            .min(grow.trunk_r);
            if n.id < host.id {
                host.id = n.id;
            }
        } else {
            kept.push(n);
        }
    }
    *nodes = kept;
}

fn legacy_merge(host: &Node, guest: &Node, trunk_r: f64, reach: f64) -> bool {
    let d = (host.xy[0] - guest.xy[0]).hypot(host.xy[1] - guest.xy[1]);
    let merged = (host.radius.powi(2) + guest.radius.powi(2))
        .sqrt()
        .min(trunk_r);
    let w = (host.radius + guest.radius).max(1e-6);
    let shift_h = d * guest.radius / w;
    let shift_g = d * host.radius / w;
    shift_h + host.radius <= merged + reach && shift_g + guest.radius <= merged + reach
}

/// Radius the merged trunk needs so both parent disks stay inside the support
/// cone. `None` when that radius would exceed the trunk cap or the load cap.
fn merge_need(a: &Node, b: &Node, grow: &Grow, slack: f64) -> Option<f64> {
    let load = a.load + b.load;
    let length = a.dist.max(b.dist);
    let cap = tip_capacity(grow.trunk_r, length, grow.tip_r, grow.load_factor);
    if load > cap + 1e-6 {
        return None;
    }
    let d = (a.xy[0] - b.xy[0]).hypot(a.xy[1] - b.xy[1]);
    let w = (a.radius + b.radius).max(1e-6);
    let shift_a = d * b.radius / w;
    let shift_b = d * a.radius / w;
    let need = (shift_a + a.radius - slack)
        .max(shift_b + b.radius - slack)
        .max(a.radius)
        .max(b.radius)
        .max(section_radius(load, grow.tip_r, grow.load_factor));
    if need <= grow.trunk_r + 1e-6 {
        Some(need)
    } else {
        None
    }
}

/// Where a fresh tip is born, and the part it might still lean onto.
struct Land<'a> {
    layer: usize,
    freeze: u32,
    lean: f64,
    bands: &'a [LayerBand],
    contours: &'a [Vec<Loop>],
    bounds: &'a [Option<([f64; 2], [f64; 2])>],
}

/// True when a tip at `xy` can walk onto a roof before the bed. Horizontal
/// travel starts after the frozen interface layers, then grows by one lean
/// step per layer. A vertical wall is not a landing: the trunk is pushed
/// out of the mesh and keeps falling. Only a layer that sticks out past the
/// one above (or is the top of a column) can catch it.
fn reaches_model(xy: [f64; 2], land: &Land<'_>) -> bool {
    let first = land.layer.saturating_sub(land.freeze as usize + 1);
    let mut reach = 0.0;
    for j in (0..=first).rev() {
        let from = j + 1;
        if from < land.bands.len() {
            reach += land.bands[from].height * land.lean;
        }
        if !is_roof(j, land) {
            continue;
        }
        let Some((min, max)) = land.bounds.get(j).copied().flatten() else {
            continue;
        };
        if xy[0] < min[0] - reach
            || xy[0] > max[0] + reach
            || xy[1] < min[1] - reach
            || xy[1] > max[1] + reach
        {
            continue;
        }
        let part = land.contours.get(j).map(Vec::as_slice).unwrap_or(&[]);
        if in_solid(part, xy[0], xy[1]) || distance_to_outline(part, xy) <= reach {
            return true;
        }
    }
    false
}

/// A layer whose solid is not just the wall of the layer above.
fn is_roof(layer: usize, land: &Land<'_>) -> bool {
    let Some((min, max)) = land.bounds.get(layer).copied().flatten() else {
        return false;
    };
    let Some((above_min, above_max)) = land.bounds.get(layer + 1).copied().flatten() else {
        return true;
    };
    const EPS: f64 = 0.2;
    min[0] < above_min[0] - EPS
        || max[0] > above_max[0] + EPS
        || min[1] < above_min[1] - EPS
        || max[1] > above_max[1] + EPS
}

struct Pitch {
    fine: f64,
    keep: f64,
    capacity: f64,
}

/// One packed tip per neighbourhood. A grid over the combined bbox, with the
/// bbox centre as a fallback, misses a concave patch (the centre sits in the
/// notch) and misses a second island when the first one already caught a sample.
/// Samples closer than `keep` are dropped when a neighbour still has capacity,
/// so the interface bridges to that neighbour instead of growing a parallel trunk.
/// Tips that can lean onto the model and tips that have to reach the bed pack
/// separately: swallowing the second into the first deletes the bed trunk.
fn sample_tips(region: &[Loop], pitch: &Pitch, land: &Land<'_>) -> Vec<([f64; 2], f64, bool)> {
    let mut pts = Vec::new();
    for comp in components(region) {
        let mut hit = sample_component(&comp, pitch.fine);
        if hit.is_empty() {
            if let Some(p) = point_inside(&comp) {
                hit.push(p);
            }
        }
        pts.extend(pack_by_landing(hit, pitch, land));
    }
    pts
}

fn pack_by_landing(
    hit: Vec<[f64; 2]>,
    pitch: &Pitch,
    land: &Land<'_>,
) -> Vec<([f64; 2], f64, bool)> {
    if hit.len() <= 1 {
        return pack_tips(hit, pitch.keep, pitch.capacity)
            .into_iter()
            .map(|(p, load)| (p, load, false))
            .collect();
    }
    let (on_model, to_bed): (Vec<_>, Vec<_>) =
        hit.into_iter().partition(|p| reaches_model(*p, land));
    let mut packed: Vec<_> = pack_tips(on_model, pitch.keep, pitch.capacity)
        .into_iter()
        .map(|(p, load)| (p, load, false))
        .collect();
    packed.extend(
        pack_tips(to_bed, pitch.keep, pitch.capacity)
            .into_iter()
            .map(|(p, load)| (p, load, true)),
    );
    packed
}

/// Greedy pack. Each keeper absorbs later samples inside `reach` until `capacity`
/// tip-units are used. A sample the keepers cannot carry stays, so a patch is
/// never left farther than `reach` from a trunk.
fn pack_tips(mut pts: Vec<[f64; 2]>, reach: f64, capacity: f64) -> Vec<([f64; 2], f64)> {
    if pts.len() <= 1 || reach <= 0.0 {
        return pts.into_iter().map(|p| (p, 1.0)).collect();
    }
    let cap = capacity.max(1.0);
    pts.sort_by(|a, b| a[0].total_cmp(&b[0]).then(a[1].total_cmp(&b[1])));
    let mut kept: Vec<([f64; 2], f64)> = Vec::new();
    for p in pts {
        let mut best: Option<(usize, f64)> = None;
        for (i, (q, load)) in kept.iter().enumerate() {
            if *load + 1.0 > cap + 1e-6 {
                continue;
            }
            let dist = (q[0] - p[0]).hypot(q[1] - p[1]);
            if dist > reach {
                continue;
            }
            if best.map(|(_, bd)| dist < bd).unwrap_or(true) {
                best = Some((i, dist));
            }
        }
        if let Some((i, _)) = best {
            kept[i].1 += 1.0;
        } else {
            kept.push((p, 1.0));
        }
    }
    kept
}

fn sample_component(region: &[Loop], spacing: f64) -> Vec<[f64; 2]> {
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
    pts
}

/// A point that is inside the solid, preferring the middle of the thickest spot
/// so the tip is not parked on an edge the next boolean will shave off.
fn point_inside(comp: &[Loop]) -> Option<[f64; 2]> {
    let outer = comp.iter().max_by(|a, b| {
        signed_area(a)
            .abs()
            .partial_cmp(&signed_area(b).abs())
            .unwrap_or(std::cmp::Ordering::Equal)
    })?;
    let c = centroid(outer);
    if in_solid(comp, c[0], c[1]) {
        return Some(c);
    }
    let (min, max) = loop_bounds(comp)?;
    let w = (max[0] - min[0]).max(1e-6);
    let h = (max[1] - min[1]).max(1e-6);
    let step = ((w * h) / 280.0).sqrt().clamp(0.12, 0.5);
    let mut best: Option<[f64; 2]> = None;
    let mut best_clear = -1.0;
    let mut y = min[1] + step * 0.5;
    while y < max[1] {
        let mut x = min[0] + step * 0.5;
        while x < max[0] {
            if in_solid(comp, x, y) {
                let clear = distance_to_outline(comp, [x, y]);
                if clear > best_clear {
                    best_clear = clear;
                    best = Some([x, y]);
                }
            }
            x += step;
        }
        y += step;
    }
    best
}

fn tip_covers(comp: &[Loop], xy: [f64; 2], reach: f64) -> bool {
    in_solid(comp, xy[0], xy[1]) || distance_to_outline(comp, xy) <= reach
}

/// Give every interface component a tip. `freeze` is 1 so the disk prints on
/// the next layer, directly under this patch, instead of after the whole
/// interface stack.
fn seed_uncovered_interface(
    region: &[Loop],
    nodes: &mut Vec<Node>,
    next_id: &mut u32,
    tip_r: f64,
    pitch: &Pitch,
    land: &Land<'_>,
) {
    if region.is_empty() {
        return;
    }
    for comp in components(region) {
        if nodes.iter().any(|n| tip_covers(&comp, n.xy, tip_r)) {
            continue;
        }
        let mut seeds = sample_component(&comp, pitch.fine);
        if seeds.is_empty() {
            if let Some(p) = point_inside(&comp) {
                seeds.push(p);
            }
        }
        for (xy, load, to_bed) in pack_by_landing(seeds, pitch, land) {
            nodes.push(Node {
                id: *next_id,
                xy,
                radius: tip_r,
                dist: 0.0,
                freeze: 1,
                load,
                to_bed,
            });
            *next_id += 1;
        }
    }
}

fn area_footing(below: &SupportLayer, part: &[Loop]) -> Vec<Loop> {
    let foot = boolean_union(&boolean_union(&below.interface, &below.sparse), part);
    if foot.is_empty() {
        Vec::new()
    } else {
        offset_loops(&foot, INTERFACE_FOOT_MM)
    }
}

fn branch_foots(comp: &[Loop], branches: &[[f64; 2]], radii: &[f64]) -> bool {
    branches.iter().zip(radii).any(|(c, r)| {
        in_solid(comp, c[0], c[1]) || distance_to_outline(comp, *c) <= *r + INTERFACE_FOOT_MM
    })
}

fn component_is_footed(comp: &[Loop], below: &SupportLayer, foot: &[Loop]) -> bool {
    branch_foots(comp, &below.branches, &below.radii)
        || (!foot.is_empty() && overlaps(comp, foot, 0.02))
}

fn interface_pieces(interface: &[Loop]) -> Vec<Vec<Loop>> {
    components(interface)
        .into_iter()
        .filter(|comp| solid_area(comp) >= 0.05)
        .collect()
}

/// Area of interface components with no trunk, lower interface, or model under them.
pub(crate) fn orphan_interface_area(
    interface: &[Loop],
    below: &SupportLayer,
    part: &[Loop],
) -> f64 {
    if interface.is_empty() {
        return 0.0;
    }
    let mut foot = None;
    let mut area = 0.0;
    for comp in interface_pieces(interface) {
        if branch_foots(&comp, &below.branches, &below.radii) {
            continue;
        }
        let foot = foot.get_or_insert_with(|| area_footing(below, part));
        if !foot.is_empty() && overlaps(&comp, foot, 0.02) {
            continue;
        }
        area += solid_area(&comp);
    }
    area
}

fn drop_unfooted_interface(layers: &mut [SupportLayer], contours: &[Vec<Loop>]) {
    for i in 1..layers.len() {
        if layers[i].interface.is_empty() {
            continue;
        }
        let (lower, upper) = layers.split_at_mut(i);
        let below = &lower[i - 1];
        let interface = upper[0].interface.clone();
        let pieces = interface_pieces(&interface);
        // Most patches sit on a trunk tip. Skip the part-offset unless one does not.
        if pieces
            .iter()
            .all(|comp| branch_foots(comp, &below.branches, &below.radii))
        {
            continue;
        }
        let part = contours.get(i - 1).map(Vec::as_slice).unwrap_or(&[]);
        let foot = area_footing(below, part);
        let mut gone: Vec<Loop> = Vec::new();
        for comp in pieces {
            if !component_is_footed(&comp, below, &foot) {
                gone = boolean_union(&gone, &comp);
            }
        }
        if !gone.is_empty() {
            // Subtract from the original so a kept ring does not lose its hole.
            upper[0].interface = drop_slivers(boolean_diff(&interface, &gone), 0.05);
        }
    }
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adaptive::LayerBand;

    fn rect(x0: f64, y0: f64, x1: f64, y1: f64) -> Loop {
        vec![[x0, y0], [x1, y0], [x1, y1], [x0, y1]]
    }

    /// C opening toward +X. The bbox centre and the single coarse grid sample
    /// both land in the notch, so a whole-region seed misses the solid.
    fn notch() -> Loop {
        vec![
            [0.0, 0.0],
            [4.0, 0.0],
            [4.0, 1.2],
            [1.2, 1.2],
            [1.2, 2.8],
            [4.0, 2.8],
            [4.0, 4.0],
            [0.0, 4.0],
        ]
    }

    fn layers(n: usize) -> Vec<LayerBand> {
        (0..n).map(|i| band(i, (i as f64 + 1.0) * 0.2)).collect()
    }

    fn unfooted_interface(layers: &[SupportLayer], contours: &[Vec<Loop>]) -> Vec<(usize, f64)> {
        let mut bad = Vec::new();
        for i in 1..layers.len() {
            let part = contours.get(i - 1).map(Vec::as_slice).unwrap_or(&[]);
            let area = orphan_interface_area(&layers[i].interface, &layers[i - 1], part);
            if area > 0.0 {
                bad.push((i, area));
            }
        }
        bad
    }

    fn band(index: usize, z: f64) -> LayerBand {
        LayerBand {
            index,
            z,
            height: 0.2,
        }
    }

    #[test]
    fn a_disk_nothing_can_hold_is_dropped() {
        let bands = [band(0, 0.2), band(1, 0.4)];
        let mut layers = vec![
            SupportLayer {
                sparse: Vec::new(),
                interface: Vec::new(),
                branches: vec![[0.0, 0.0]],
                radii: vec![1.2],
            },
            SupportLayer {
                sparse: Vec::new(),
                interface: Vec::new(),
                branches: vec![[0.0, 0.0], [8.0, 0.0]],
                radii: vec![1.2, 1.2],
            },
        ];
        settle_disks(&mut layers, &bands, &[Vec::new(), Vec::new()], 0.8);
        assert_eq!(layers[0].branches.len(), 1);
        assert_eq!(layers[1].branches, vec![[0.0, 0.0]]);
        assert!((layers[1].radii[0] - 1.2).abs() < 1e-9);
    }

    #[test]
    fn a_concave_overhang_missed_by_the_seed_grid_still_grows_a_trunk() {
        // Speed spacing is ~5.3 mm. This notch is 4 mm across, so the only grid
        // sample and the bbox centre both fall in the opening.
        let bands = layers(40);
        let mut contours = vec![Vec::new(); bands.len()];
        for contour in contours.iter_mut().take(40).skip(36) {
            *contour = vec![notch()];
        }
        let opts = SupportOpts {
            style: SupportStyle::Tree,
            density: 0.15,
            interface_layers: 3,
            z_gap: 0.2,
            overhangs: true,
            islands: true,
            ..SupportOpts::default()
        };
        let built = build_supports(&bands, &contours, &opts);
        let bad = unfooted_interface(&built, &contours);
        assert!(bad.is_empty(), "interface with nothing under it: {bad:?}");
        let trunks = built
            .iter()
            .filter(|layer| {
                layer
                    .branches
                    .iter()
                    .any(|c| (0.0..1.3).contains(&c[0]) && (0.2..3.8).contains(&c[1]))
            })
            .count();
        assert!(
            trunks > 8,
            "expected a trunk down the left bar of the notch, disks on {trunks} layers"
        );
        let iface = built
            .iter()
            .filter(|layer| !layer.interface.is_empty())
            .count();
        assert!(
            iface >= 2,
            "the notch should keep its interface, got {iface} layers"
        );
    }

    #[test]
    fn interface_split_off_its_frozen_tip_keeps_a_trunk_on_the_orphan_lobe() {
        // Spacing is clamped at 9 mm, so the only sample lands in the big lobe.
        // The part then cuts the bridge and the ear is no longer on that tip.
        let bands = layers(30);
        let mut contours = vec![Vec::new(); bands.len()];
        // Big lobe, narrow bridge, small ear. The 9 mm grid hits only the lobe.
        let shape = boolean_union(
            &boolean_union(&[rect(0.0, 0.0, 8.0, 8.0)], &[rect(7.9, 3.0, 10.0, 5.0)]),
            &[rect(9.9, 2.5, 13.0, 5.5)],
        );
        contours[29] = shape;
        // Birth is an air gap below the island, so the first interface layer is
        // still the whole shape. The blocker then cuts the bridge.
        let blocker = rect(-1.0, -1.0, 10.4, 9.0);
        for contour in contours.iter_mut().take(27) {
            *contour = vec![blocker.clone()];
        }
        let opts = SupportOpts {
            style: SupportStyle::Tree,
            density: 0.0,
            branch_spacing: 5.0,
            interface_layers: 3,
            z_gap: 0.2,
            overhangs: true,
            islands: true,
            ..SupportOpts::default()
        };
        let built = build_supports(&bands, &contours, &opts);
        let bad = unfooted_interface(&built, &contours);
        assert!(bad.is_empty(), "interface with nothing under it: {bad:?}");
        let right = built.iter().any(|layer| {
            layer
                .branches
                .iter()
                .any(|c| c[0] > 11.0 && (2.4..5.6).contains(&c[1]))
        });
        assert!(right, "the ear that slid off the frozen tip has no trunk");
    }

    #[test]
    fn wide_overhang_packs_tips_and_collapses_toward_fewer_trunks() {
        // 40 × 14 mm plate, 16 mm above the bed. The fine grid wants a row of
        // tips; load capacity should leave fewer of them, and the fall should
        // join those into still fewer bed trunks.
        let bands = layers(80);
        let mut contours = vec![Vec::new(); bands.len()];
        let plate = rect(0.0, 0.0, 40.0, 14.0);
        for contour in contours.iter_mut().skip(76) {
            *contour = vec![plate.clone()];
        }
        let base = SupportOpts {
            style: SupportStyle::Tree,
            density: 0.15,
            interface_layers: 2,
            z_gap: 0.2,
            overhangs: true,
            islands: true,
            ..SupportOpts::default()
        };
        let shared = build_supports(&bands, &contours, &base);
        assert!(
            unfooted_interface(&shared, &contours).is_empty(),
            "packed tips left interface in the air"
        );
        let peak = shared.iter().map(|l| l.branches.len()).max().unwrap_or(0);
        let bed = shared[0].branches.len();
        assert!(peak >= 3, "expected several tips, peak {peak}");
        assert!(bed >= 1, "the plate grew no trunk");
        assert!(
            bed < peak,
            "branches should join on the way down, peak {peak} bed {bed}"
        );
        let sparse = build_supports(
            &bands,
            &contours,
            &SupportOpts {
                load_factor: 8.0,
                max_tip_spacing: 10.0,
                ..base
            },
        );
        let dense = build_supports(
            &bands,
            &contours,
            &SupportOpts {
                load_factor: 0.8,
                max_tip_spacing: 3.2,
                ..base
            },
        );
        assert!(unfooted_interface(&sparse, &contours).is_empty());
        assert!(unfooted_interface(&dense, &contours).is_empty());
        let sparse_peak = sparse.iter().map(|l| l.branches.len()).max().unwrap_or(0);
        let dense_peak = dense.iter().map(|l| l.branches.len()).max().unwrap_or(0);
        assert!(
            sparse_peak < dense_peak,
            "load factor and tip spacing should thin the peak, sparse {sparse_peak} dense {dense_peak}"
        );
        let sparse_load: f64 = sparse.iter().map(|l| l.branches.len() as f64).sum();
        let dense_load: f64 = dense.iter().map(|l| l.branches.len() as f64).sum();
        assert!(
            sparse_load < dense_load * 0.75,
            "sparse disks {sparse_load} should be well under dense {dense_load}"
        );
    }

    #[test]
    fn two_close_tips_become_one_trunk_before_the_bed() {
        let bands = layers(40);
        let mut contours = vec![Vec::new(); bands.len()];
        // Two 4 mm pads, centres 8 mm apart. Each is its own component, so
        // packing cannot delete one; the fall has to join them.
        contours[39] = boolean_union(&[rect(0.0, 0.0, 4.0, 4.0)], &[rect(8.0, 0.0, 12.0, 4.0)]);
        let built = build_supports(
            &bands,
            &contours,
            &SupportOpts {
                style: SupportStyle::Tree,
                density: 0.0,
                load_factor: 0.8,
                max_tip_spacing: 3.0,
                interface_layers: 2,
                z_gap: 0.2,
                overhangs: true,
                islands: true,
                ..SupportOpts::default()
            },
        );
        assert!(unfooted_interface(&built, &contours).is_empty());
        let peak = built.iter().map(|l| l.branches.len()).max().unwrap_or(0);
        let bed = built[0].branches.len();
        let trace: Vec<(usize, usize)> = built
            .iter()
            .enumerate()
            .filter(|(_, l)| !l.branches.is_empty())
            .map(|(i, l)| (i, l.branches.len()))
            .collect();
        assert!(
            peak >= 2,
            "both pads should start a tip, peak {peak} bed {bed} trace {trace:?}"
        );
        assert_eq!(
            bed, 1,
            "close tips should share one trunk, bed {bed} peak {peak} trace {trace:?}"
        );
    }

    #[test]
    fn pack_tips_keeps_a_sample_its_neighbours_cannot_carry() {
        let pts = vec![[0.0, 0.0], [6.0, 0.0], [12.0, 0.0], [3.0, 0.0]];
        let packed = pack_tips(pts, 7.0, 2.0);
        let loads: Vec<f64> = packed.iter().map(|(_, load)| *load).collect();
        assert!(
            packed.len() >= 2,
            "capacity 2 cannot swallow four tips inside 7 mm, got {packed:?}"
        );
        assert!(
            loads.iter().all(|load| *load <= 2.0 + 1e-6),
            "a keeper exceeded capacity: {packed:?}"
        );
        assert!(
            (loads.iter().sum::<f64>() - 4.0).abs() < 1e-6,
            "dropped a tip instead of keeping it, loads {loads:?}"
        );
    }

    #[test]
    fn an_overhang_past_the_lean_cone_keeps_a_bed_trunk() {
        // Head up to z=16, ear from z=28 sticking 16 mm past the head in Y.
        // At 45° the lean cone cannot carry the outer ear back onto the head,
        // so packing must not hand that tip to a neighbour that lands on the head.
        let bands = layers(170);
        let mut contours = vec![Vec::new(); bands.len()];
        let head = rect(0.0, 0.0, 28.0, 20.0);
        for contour in contours.iter_mut().take(80) {
            *contour = vec![head.clone()];
        }
        let ear = rect(6.0, 6.0, 16.0, 36.0);
        for contour in contours.iter_mut().skip(139) {
            *contour = vec![ear.clone()];
        }
        let built = build_supports(
            &bands,
            &contours,
            &SupportOpts {
                style: SupportStyle::Tree,
                density: 0.15,
                load_factor: 8.0,
                max_tip_spacing: 12.0,
                branch_angle_deg: 45.0,
                interface_layers: 3,
                z_gap: 0.2,
                overhangs: true,
                islands: true,
                ..SupportOpts::default()
            },
        );
        assert!(
            unfooted_interface(&built, &contours).is_empty(),
            "outer ear interface was left in the air"
        );
        assert!(
            !built[0].branches.is_empty(),
            "the part of the ear past the lean cone lost its bed trunk"
        );
        let on_head = built.iter().enumerate().any(|(i, layer)| {
            (70..100).contains(&i)
                && layer
                    .branches
                    .iter()
                    .any(|c| (2.0..26.0).contains(&c[0]) && (2.0..19.5).contains(&c[1]))
        });
        assert!(on_head, "the ear over the head lost its footing");
    }
}
