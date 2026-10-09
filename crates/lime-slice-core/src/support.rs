use std::collections::HashMap;

use rayon::prelude::*;
use serde::Serialize;

use crate::adaptive::LayerBand;
use crate::poly::{
    boolean_diff, boolean_intersect, boolean_union, clip_to_rect, distance_to_outline, drop_slivers,
    in_solid, local_diff, local_union, loop_bounds, offset_loops, point_in_loop, resolve_nonzero,
    signed_area, simplify_loops, Loop, LoopIndex,
};

pub(crate) mod edit;
pub(crate) mod paint;
pub(crate) mod skeleton;

use paint::PaintDisk;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum SupportStyle {
    Grid,
    #[default]
    Tree,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct SupportLayer {
    pub sparse: Vec<Loop>,
    pub interface: Vec<Loop>,
    /// Organic branch cross-sections. Empty for the grid style.
    pub disks: Vec<Disk>,
}

/// A tree-support cross-section on one layer. `node` is the walk node that printed it.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Disk {
    pub xy: [f64; 2],
    pub r: f64,
    pub node: NodeId,
}

/// Identity of a node in the tree-support walk.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct NodeId(pub u32);

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
    /// Pitch of the tips left standing, mm. A tip carries the seed samples within
    /// half of it. `0` derives a pitch from `branch_spacing` and `density`. Wider means fewer tips.
    pub max_tip_spacing: f64,
    /// Stop the walk early when this slice has been superseded.
    pub job: crate::cancel::Job,
    /// The tilted belt, when supports land on it instead of on Z 0.
    /// `None` on a cartesian plate, and on a belt that did not ask.
    pub floor: Option<FloorPlane>,
}

/// The belt in the slice frame. Printable material is `y <= y_max(z)`.
/// `None` leaves every support path where it was.
#[derive(Clone, Copy, Debug)]
pub struct FloorPlane {
    tan_a: f64,
    y_shift: f64,
    z_drop: f64,
}

impl FloorPlane {
    pub(crate) fn new(tan_a: f64, y_shift: f64, z_drop: f64) -> Self {
        Self {
            tan_a,
            y_shift,
            z_drop,
        }
    }

    /// Slice Z of the belt at this Y.
    fn z_at(self, y: f64) -> f64 {
        (y + self.y_shift) * self.tan_a - self.z_drop
    }

    /// Largest printable Y on a layer whose top is `z`.
    fn y_max(self, z: f64) -> f64 {
        (z + self.z_drop) / self.tan_a - self.y_shift
    }

    /// Slice Y a support moves toward the belt as it falls `height` in slice
    /// Z. Gravity is normal to the belt, so this keeps a trunk plumb in the lab.
    fn fall(self, height: f64) -> f64 {
        height * self.tan_a
    }

    pub(crate) fn tan_a(self) -> f64 {
        self.tan_a
    }

    pub(crate) fn y_shift(self) -> f64 {
        self.y_shift
    }

    pub(crate) fn z_drop(self) -> f64 {
        self.z_drop
    }
}

/// Drop loops and disks that would print through the belt.
fn clip_support_layer(layer: &mut SupportLayer, y_max: f64) {
    if !layer.interface.is_empty() {
        layer.interface = clip_half(&layer.interface, y_max);
    }
    if !layer.sparse.is_empty() {
        layer.sparse = clip_half(&layer.sparse, y_max);
    }
    clip_disks(&mut layer.disks, y_max);
}

fn clip_printed(layers: &mut [SupportLayer], bands: &[LayerBand], floor: Option<FloorPlane>) {
    let Some(floor) = floor else {
        return;
    };
    for (layer, band) in layers.iter_mut().zip(bands) {
        clip_support_layer(layer, floor.y_max(band.z));
    }
}

/// The half-plane `y <= y_max`. A region already inside is returned as it is,
/// so Clipper does not rewrite a loop that never crossed the belt.
fn clip_half(loops: &[Loop], y_max: f64) -> Vec<Loop> {
    if loops.is_empty() {
        return Vec::new();
    }
    let inside = loops
        .iter()
        .all(|loop_| loop_.iter().all(|p| p[1] <= y_max + 1e-6));
    if inside {
        return loops.to_vec();
    }
    drop_slivers(
        clip_to_rect(loops, [-1.0e5, -1.0e5], [1.0e5, y_max]),
        0.02,
    )
}

/// Each disk becomes the largest circle inside both it and the half-plane.
/// It keeps the disk's upstream edge, so the foot of a trunk that meets the
/// belt still stands on the layer above it.
fn clip_disks(disks: &mut Vec<Disk>, y_max: f64) {
    disks.retain_mut(|disk| {
        let room = y_max - disk.xy[1];
        if room >= disk.r {
            return true;
        }
        let r = (room + disk.r) * 0.5;
        if r < MIN_DISK_R {
            return false;
        }
        disk.xy[1] -= disk.r - r;
        disk.r = r;
        true
    });
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
            job: crate::cancel::Job::default(),
            floor: None,
        }
    }
}

/// Supports planned for one part: the trees grown to hold it, and every
/// layer as it prints.
#[derive(Clone)]
pub(crate) struct Supports {
    pub forest: Forest,
    pub layers: Vec<SupportLayer>,
    /// `layers` before the belt clip, which each layer is stood on. Empty off a belt.
    stood: Vec<SupportLayer>,
    /// Each layer's interface as the part demands it, before any patch with
    /// nothing under it is dropped. Coverage measures `layers` against it.
    demanded: Vec<Vec<Loop>>,
    /// Each layer's overhang reaching its contact there, where the walk bore tips.
    born: Vec<Vec<Loop>>,
    /// Per layer, the area each regrow grew for, by the edit's number. It
    /// undoes the interface clip of tips pruned by earlier edits.
    restored: Vec<Vec<(u32, Vec<Loop>)>>,
    /// Edits applied so far. The next one gets this number.
    edits: u32,
    /// The first limb each regrow grew, ascending. A limb merged into one
    /// before its regrow's first joined a kept limb, whose knots never took
    /// its load.
    regrown: Vec<usize>,
    /// The settings it grew with. Edits re-stand layers with the same lean and pitch.
    opts: SupportOpts,
}

/// Part of the demanded interface that the finished supports do not print,
/// over adjacent layers: a floating overhang loses every interface layer
/// down from its contact, and those layers are one patch.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoverageGap {
    /// `z` of the lowest and the highest layer it spans, as preview layers carry it.
    pub z: [f64; 2],
    /// Largest area left unheld on one of its layers, mm².
    pub area_mm2: f32,
    /// Corners of the box holding it on every layer, mm.
    pub min: [f32; 2],
    pub max: [f32; 2],
    /// The unheld region on its highest layer, simplified, as closed loops.
    pub outline: Vec<Vec<[f32; 2]>>,
}

/// What the part asks of supports on each layer. It reads the part and the
/// support settings and never a tree, so trees can be regrown on it as is.
struct Demand {
    /// Overhang that reaches its contact height on this layer. Tips are born here.
    born: Vec<Vec<Loop>>,
    /// Dense interface before any patch with nothing under it is dropped.
    interface: Vec<Vec<Loop>>,
    /// Grid style only: the column printed under the interface.
    sparse: Vec<Vec<Loop>>,
}

/// The tree-support walk as it ran. `limbs[k]` is the lineage of `NodeId(k + 1)`.
#[derive(Clone, Default)]
pub(crate) struct Forest {
    pub limbs: Vec<Limb>,
    /// `at[i]` lists, in ascending order, the index of every limb with a knot on layer `i`.
    at: Vec<Vec<u32>>,
}

/// One lineage of the walk: born at a tip on layer `top` and carried down
/// until it merges, lands, or reaches the bed. `knots[k]` is its node on layer
/// `top - k` as `organic_disks` saw it; a frozen knot prints no disk. Its birth
/// site is `knots[0].xy` at the top of layer `top`.
#[derive(Clone)]
pub(crate) struct Limb {
    pub top: usize,
    pub knots: Vec<Node>,
    pub end: End,
    /// What edits left of it. Its knots never change.
    pub life: Life,
}

/// A limb as edits leave it. Only a limb whose own tip was pruned is not
/// `Live`, and `by` numbers the edit that pruned it.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum Life {
    Live,
    /// Its tip is pruned, but limbs merged into it survive. It prints its
    /// knots up to layer `to`, where the highest of them joins it.
    Trimmed {
        to: usize,
        by: u32,
    },
    /// Its tip is pruned and nothing merged into it survives.
    Removed {
        by: u32,
    },
}

impl Life {
    fn pruned_by(self) -> Option<u32> {
        match self {
            Life::Live => None,
            Life::Trimmed { by, .. } | Life::Removed { by } => Some(by),
        }
    }
}

/// How a limb stops, stepping down from its last knot.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum End {
    /// Joined `into`, whose knot on the next layer down carries both.
    Merged { into: NodeId },
    /// Stood on the part.
    Landed,
    /// Pushed into the part with nothing under it.
    Pinched,
    /// Still standing when the walk finished layer 0.
    Bed,
}

impl Forest {
    fn new(layers: usize) -> Self {
        Self {
            limbs: Vec::new(),
            at: vec![Vec::new(); layers],
        }
    }

    /// Append each node's state on `layer`. A node with no limb yet was born
    /// on it; its limb counts as reaching the bed until the walk ends it.
    fn record(&mut self, layer: usize, nodes: &[Node]) {
        for n in nodes {
            let k = n.id as usize - 1;
            if k == self.limbs.len() {
                self.limbs.push(Limb {
                    top: layer,
                    knots: Vec::new(),
                    end: End::Bed,
                    life: Life::Live,
                });
            }
            self.limbs[k].knots.push(*n);
            self.at[layer].push(k as u32);
        }
    }
}

impl Limb {
    /// The lowest layer it has a knot on.
    fn bottom(&self) -> usize {
        self.top + 1 - self.knots.len()
    }

    /// The highest layer it still prints a knot on, `None` once removed.
    fn reach(&self) -> Option<usize> {
        match self.life {
            Life::Live => Some(self.top),
            Life::Trimmed { to, .. } => Some(to),
            Life::Removed { .. } => None,
        }
    }
}

impl Supports {
    /// Project overhangs down to the bed as trunks or a sparse column plus a
    /// few dense interface layers. `None` when the job was cancelled.
    #[cfg(test)]
    pub(crate) fn build(
        bands: &[LayerBand],
        contours: &[Vec<Loop>],
        opts: &SupportOpts,
    ) -> Option<Self> {
        Self::build_with(
            bands,
            contours,
            contours,
            &[],
            opts,
            &crate::progress::Watch::idle(),
        )
    }

    /// Supports holding up `own`, the part's contours, as `paint` asks.
    /// `solid` is what the trees avoid and may stand on: the part, and any
    /// other object moved into the part's frame. Alone, it is `own`.
    pub(crate) fn build_with(
        bands: &[LayerBand],
        own: &[Vec<Loop>],
        solid: &[Vec<Loop>],
        paint: &[PaintDisk],
        opts: &SupportOpts,
        watch: &crate::progress::Watch,
    ) -> Option<Self> {
        let mut supports = Self::walk_with(bands, own, solid, paint, opts, watch)?;
        if !project(
            &mut supports.layers,
            1,
            bands,
            solid,
            lean_of(opts),
            opts.floor,
            watch,
            opts.job,
        ) {
            return None;
        }
        if opts.floor.is_some() {
            supports.stood = supports.layers.clone();
        }
        clip_printed(&mut supports.layers, bands, opts.floor);
        Some(supports)
    }

    /// No supports on any of `layers` layers.
    pub(crate) fn none(layers: usize, opts: &SupportOpts) -> Self {
        let empty = vec![Vec::new(); layers];
        Self {
            forest: Forest::default(),
            layers: vec![SupportLayer::default(); layers],
            stood: Vec::new(),
            demanded: empty.clone(),
            born: empty,
            restored: vec![Vec::new(); layers],
            edits: 0,
            regrown: Vec::new(),
            opts: *opts,
        }
    }

    /// The forest, with every layer as the walk leaves it, before `project`.
    #[cfg(test)]
    fn walk(bands: &[LayerBand], contours: &[Vec<Loop>], opts: &SupportOpts) -> Option<Self> {
        Self::walk_with(
            bands,
            contours,
            contours,
            &[],
            opts,
            &crate::progress::Watch::idle(),
        )
    }

    fn walk_with(
        bands: &[LayerBand],
        own: &[Vec<Loop>],
        solid: &[Vec<Loop>],
        paint: &[PaintDisk],
        opts: &SupportOpts,
        watch: &crate::progress::Watch,
    ) -> Option<Self> {
        let demand = Demand::new(bands, own, solid, paint, opts, watch)?;
        let (forest, disks) = if opts.style == SupportStyle::Tree {
            grow(&demand, bands, solid, opts, watch)?
        } else {
            (Forest::default(), vec![Vec::new(); bands.len()])
        };
        let demanded = demand.interface.clone();
        let layers = demand
            .interface
            .into_iter()
            .zip(demand.sparse)
            .zip(disks)
            .map(|((interface, sparse), disks)| SupportLayer {
                sparse,
                interface,
                disks,
            })
            .collect();
        Some(Self {
            forest,
            layers,
            demanded,
            stood: Vec::new(),
            restored: vec![Vec::new(); demand.born.len()],
            born: demand.born,
            edits: 0,
            regrown: Vec::new(),
            opts: *opts,
        })
    }

    /// Each layer's XY box of everything printed: trunk disks at their
    /// radius, sparse columns, and interface. `None` on a layer with none.
    pub(crate) fn reach(&self) -> Vec<Option<([f64; 2], [f64; 2])>> {
        self.layers
            .par_iter()
            .map(|layer| {
                let disks = layer.disks.iter().map(|d| {
                    (
                        [d.xy[0] - d.r, d.xy[1] - d.r],
                        [d.xy[0] + d.r, d.xy[1] + d.r],
                    )
                });
                [loop_bounds(&layer.sparse), loop_bounds(&layer.interface)]
                    .into_iter()
                    .flatten()
                    .chain(disks)
                    .reduce(|(amn, amx), (bmn, bmx)| {
                        (
                            [amn[0].min(bmn[0]), amn[1].min(bmn[1])],
                            [amx[0].max(bmx[0]), amx[1].max(bmx[1])],
                        )
                    })
            })
            .collect()
    }

    /// The demanded interface the finished layers do not print, less the
    /// part, grouped into patches. Pieces on adjacent layers that overlap
    /// join one patch. A patch whose largest layer is under
    /// `COVERAGE_SPECK_MM2` is left out. Largest patch first.
    pub(crate) fn coverage(&self, bands: &[LayerBand], contours: &[Vec<Loop>]) -> Vec<CoverageGap> {
        self.coverage_from(bands, contours, COVERAGE_SPECK_MM2)
    }

    /// Coverage keeping every patch whose largest layer reaches `min_mm2`.
    pub(crate) fn coverage_from(
        &self,
        bands: &[LayerBand],
        contours: &[Vec<Loop>],
        min_mm2: f64,
    ) -> Vec<CoverageGap> {
        let pieces: Vec<Unheld> = (0..self.layers.len())
            .into_par_iter()
            .flat_map_iter(|i| {
                let part = contours.get(i).map(Vec::as_slice).unwrap_or(&[]);
                unheld_on(i, &self.demanded[i], &self.layers[i].interface, part)
            })
            .collect();
        let joined = |lower: &Unheld, upper: &Unheld| {
            boxes_within(Some(lower.bounds), Some(upper.bounds), 0.0)
                && overlaps(&lower.loops, &upper.loops, 0.01)
        };
        let mut gaps: Vec<CoverageGap> = patches(&pieces, joined)
            .into_iter()
            .filter(|patch| patch.area >= min_mm2)
            .map(|patch| patch.report(bands))
            .collect();
        gaps.sort_by(|a, b| {
            b.area_mm2
                .total_cmp(&a.area_mm2)
                .then(a.z[0].total_cmp(&b.z[0]))
        });
        gaps
    }
}

/// Smallest unheld patch worth a warning, by its largest layer, mm². About
/// two tip disks. Across the golden meshes most unheld patches are one tip's
/// worth, 0.3 to 0.75 mm² in a box near 1.4 by 1.8 mm: a scale or a boss the
/// part's own beads span.
const COVERAGE_SPECK_MM2: f64 = 1.0;
/// Pieces this small are boolean noise. `drop_unfooted_interface` never drops one.
const UNHELD_PIECE_MM2: f64 = 0.05;
/// Outline simplification for the reported region, mm.
const COVERAGE_OUTLINE_MM: f64 = 0.05;

/// One connected piece of a layer that nothing holds up: demanded interface
/// the layer does not print, or part that prints over air.
struct Unheld {
    layer: usize,
    loops: Vec<Loop>,
    area: f64,
    bounds: Bounds,
}

fn unheld_on(layer: usize, demanded: &[Loop], printed: &[Loop], part: &[Loop]) -> Vec<Unheld> {
    if demanded.is_empty() || demanded == printed {
        return Vec::new();
    }
    let mut gone = boolean_diff(demanded, printed);
    if !gone.is_empty() && !part.is_empty() {
        gone = boolean_diff(&gone, part);
    }
    pieces_on(layer, &gone)
}

fn pieces_on(layer: usize, loops: &[Loop]) -> Vec<Unheld> {
    components(loops)
        .into_iter()
        .filter_map(|loops| {
            let area = solid_area(&loops);
            let bounds = loop_bounds(&loops)?;
            (area >= UNHELD_PIECE_MM2).then_some(Unheld {
                layer,
                loops,
                area,
                bounds,
            })
        })
        .collect()
}

/// Pieces in layer order grouped into patches. A piece joins a piece on the
/// layer under it when `joined(lower, upper)` holds.
fn patches(pieces: &[Unheld], joined: impl Fn(&Unheld, &Unheld) -> bool) -> Vec<Patch> {
    // `below` holds the pieces of the layer under the current one, empty
    // when that layer has none.
    let mut root: Vec<usize> = (0..pieces.len()).collect();
    let (mut below, mut start) = (0..0, 0);
    for k in 0..pieces.len() {
        if k > 0 && pieces[k].layer != pieces[k - 1].layer {
            below = if pieces[k - 1].layer + 1 == pieces[k].layer {
                start..k
            } else {
                k..k
            };
            start = k;
        }
        for j in below.clone() {
            if joined(&pieces[j], &pieces[k]) {
                let (a, b) = (find(&mut root, j), find(&mut root, k));
                root[a.max(b)] = a.min(b);
            }
        }
    }
    let mut slot = vec![usize::MAX; pieces.len()];
    let mut patches: Vec<Patch> = Vec::new();
    for (k, p) in pieces.iter().enumerate() {
        let r = find(&mut root, k);
        if slot[r] == usize::MAX {
            slot[r] = patches.len();
            patches.push(Patch::new(p));
        } else {
            patches[slot[r]].add(p);
        }
    }
    patches
}

fn find(root: &mut [usize], k: usize) -> usize {
    let mut r = k;
    while root[r] != r {
        r = root[r];
    }
    let mut k = k;
    while root[k] != r {
        let next = root[k];
        root[k] = r;
        k = next;
    }
    r
}

/// Unheld pieces joined across layers, as they accumulate.
struct Patch {
    lowest: usize,
    highest: usize,
    /// Area on `highest`, and the largest on any layer so far.
    on_top: f64,
    area: f64,
    bounds: Bounds,
    /// The pieces on `highest`.
    top: Vec<Loop>,
}

impl Patch {
    fn new(p: &Unheld) -> Self {
        Self {
            lowest: p.layer,
            highest: p.layer,
            on_top: p.area,
            area: p.area,
            bounds: p.bounds,
            top: p.loops.clone(),
        }
    }

    /// Pieces arrive in layer order, so a piece is on the highest layer so far.
    fn add(&mut self, p: &Unheld) {
        if p.layer == self.highest {
            self.on_top += p.area;
            self.top.extend(p.loops.iter().cloned());
        } else {
            self.highest = p.layer;
            self.on_top = p.area;
            self.top = p.loops.clone();
        }
        self.area = self.area.max(self.on_top);
        let ((amn, amx), (bmn, bmx)) = (self.bounds, p.bounds);
        self.bounds = (
            [amn[0].min(bmn[0]), amn[1].min(bmn[1])],
            [amx[0].max(bmx[0]), amx[1].max(bmx[1])],
        );
    }

    fn report(self, bands: &[LayerBand]) -> CoverageGap {
        let f32s = |p: [f64; 2]| [p[0] as f32, p[1] as f32];
        CoverageGap {
            z: [bands[self.lowest].z, bands[self.highest].z],
            area_mm2: self.area as f32,
            min: f32s(self.bounds.0),
            max: f32s(self.bounds.1),
            outline: simplify_loops(self.top, COVERAGE_OUTLINE_MM)
                .into_iter()
                .map(|l| l.into_iter().map(f32s).collect())
                .collect(),
        }
    }
}

impl Demand {
    /// Overhangs come from `own`, painted. Interface keeps clear of
    /// `solid`, and a column that reaches it stops there.
    fn new(
        bands: &[LayerBand],
        own: &[Vec<Loop>],
        solid: &[Vec<Loop>],
        paint: &[PaintDisk],
        opts: &SupportOpts,
        watch: &crate::progress::Watch,
    ) -> Option<Self> {
        let contours = solid;
        let n = bands.len();
        let mut demand = Demand {
            born: vec![Vec::new(); n],
            interface: vec![Vec::new(); n],
            sparse: vec![Vec::new(); n],
        };
        if n == 0 {
            return Some(demand);
        }
        let angle = slope_of(opts.angle_deg);
        let iface_n = opts.interface_layers.max(1);
        let tree = opts.style == SupportStyle::Tree;
        // Everything that depends only on one layer of the part is found in
        // parallel. The pass below carries each overhang down to its contact.
        let overhangs: Vec<Vec<Loop>> = (0..n)
            .into_par_iter()
            .map(|i| paint::paint_layer(paint, bands, own, i, overhang_at(bands, own, i, angle)))
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
        for i in (0..n).rev() {
            if opts.job.cancelled() || watch.cancelled() {
                return None;
            }
            // A column carried from above falls along gravity, and stops
            // where the belt rises through it.
            if let Some(floor) = opts.floor {
                if !sparse.is_empty() {
                    let fall = floor.fall(bands[i + 1].height);
                    for p in sparse.iter_mut().flatten() {
                        p[1] += fall;
                    }
                }
                let cap = floor.y_max(bands[i].z);
                for (region, _) in &mut gens {
                    *region = clip_half(region, cap);
                }
                gens.retain(|(region, _)| !region.is_empty());
                if !sparse.is_empty() {
                    sparse = clip_half(&sparse, cap);
                }
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
                let mut born = drop_slivers(born, 0.05);
                if let Some(floor) = opts.floor {
                    born = clip_half(&born, floor.y_max(bands[i].z));
                }
                if !born.is_empty() {
                    gens.insert(0, (born.clone(), iface_n));
                    demand.born[i] = born;
                }
            }

            let gap = &gaps[i];
            let iface_area = union_all(gens.iter().map(|(r, _)| r.as_slice()));
            demand.interface[i] = drop_slivers(boolean_diff(&iface_area, gap), 0.05);
            if !tree {
                let sparse_only = local_diff(&sparse, &iface_area);
                demand.sparse[i] = drop_slivers(local_diff(&sparse_only, gap), 0.05);
            }
            if let Some(floor) = opts.floor {
                let cap = floor.y_max(bands[i].z);
                if !demand.interface[i].is_empty() {
                    demand.interface[i] = clip_half(&demand.interface[i], cap);
                }
                if !demand.sparse[i].is_empty() {
                    demand.sparse[i] = clip_half(&demand.sparse[i], cap);
                }
            }

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

            if opts.style != SupportStyle::Tree {
                watch.tick();
            }
            let overhang = &overhangs[i];
            if overhang.is_empty() {
                continue;
            }
            let underside = bands[i].z - bands[i].height;
            pending.push((underside - opts.z_gap, overhang.clone()));
        }
        Some(demand)
    }
}

/// Max lean from vertical per millimetre of fall.
fn lean_of(opts: &SupportOpts) -> f64 {
    opts.branch_angle_deg.clamp(10.0, 65.0).to_radians().tan()
}

/// The top-down tree walk: tips are born where the demand says, then lean,
/// thicken, and merge on the way down. Returns the forest it grew and each
/// layer's disks before `project` settles them.
fn grow(
    demand: &Demand,
    bands: &[LayerBand],
    contours: &[Vec<Loop>],
    opts: &SupportOpts,
    watch: &crate::progress::Watch,
) -> Option<(Forest, Vec<Vec<Disk>>)> {
    let n = bands.len();
    let mut walk = Walk::new(bands, contours, &demand.interface, opts, 1);
    let mut forest = Forest::new(n);
    let mut disks = vec![Vec::new(); n];
    let mut none = Fixed::new(Vec::new());
    for i in (0..n).rev() {
        if opts.job.cancelled() || watch.cancelled() {
            return None;
        }
        walk.arrive(i, &demand.born[i], &demand.interface[i]);
        forest.record(i, &walk.nodes);
        disks[i] = organic_disks(&walk.nodes, walk.part(i), opts.xy_gap);
        walk.descend(i, &mut none, &mut forest);
        watch.tick();
    }
    Some((forest, disks))
}

/// The walk between layers: the nodes standing on the current layer and the
/// settings they grow by. A build walks every layer with nothing fixed. A
/// regrow walks the same steps on masked demand, among kept knots.
struct Walk<'a> {
    bands: &'a [LayerBand],
    contours: &'a [Vec<Loop>],
    /// Interface the demand asks for on each layer, before any is dropped.
    demanded: &'a [Vec<Loop>],
    xy_gap: f64,
    iface_n: u32,
    load_factor: f64,
    tip_r: f64,
    trunk_r: f64,
    lean: f64,
    pitch: Pitch,
    part_bb: Vec<Option<Bounds>>,
    /// The belt, when trunks land on it instead of walking to layer 0.
    floor: Option<FloorPlane>,
    nodes: Vec<Node>,
    next_id: u32,
    ended: Vec<(NodeId, End)>,
}

impl<'a> Walk<'a> {
    /// A walk whose first tip gets `next_id`.
    fn new(
        bands: &'a [LayerBand],
        contours: &'a [Vec<Loop>],
        demanded: &'a [Vec<Loop>],
        opts: &SupportOpts,
        next_id: u32,
    ) -> Self {
        let tip_r = tip_radius(opts);
        Self {
            bands,
            contours,
            demanded,
            xy_gap: opts.xy_gap,
            iface_n: opts.interface_layers.max(1),
            load_factor: load_factor_of(opts),
            tip_r,
            trunk_r: (opts.trunk_diameter * 0.5).max(tip_r + 0.3).clamp(0.6, 8.0),
            lean: lean_of(opts),
            pitch: Pitch::of(opts),
            part_bb: contours.iter().map(|c| loop_bounds(c)).collect(),
            floor: opts.floor,
            nodes: Vec::new(),
            next_id,
            ended: Vec::new(),
        }
    }

    fn part(&self, i: usize) -> &'a [Loop] {
        self.contours.get(i).map(Vec::as_slice).unwrap_or(&[])
    }

    /// Bear tips on `born` and give each piece of `interface` no node covers
    /// a tip of its own, on layer `i`. A sample a tip within reach already
    /// carries bears none: see `tip_samples`.
    fn arrive(&mut self, i: usize, born: &[Loop], interface: &[Loop]) {
        let part = self.part(i);
        let demanded = self.demanded;
        // The interface demanded on layer `k`, which a piece's interface stands on.
        let held = |k: Option<usize>| {
            Nearby::new(k.and_then(|k| demanded.get(k)).cloned().unwrap_or_default())
        };
        let mut carriers = Carriers::new(&self.nodes, self.pitch.keep);
        let land = |freeze| Land {
            layer: i,
            freeze,
            lean: self.lean,
            bands: self.bands,
            contours: self.contours,
            bounds: &self.part_bb,
            floor: self.floor,
        };
        if !born.is_empty() {
            let cleared = if part.is_empty() {
                born.to_vec()
            } else {
                drop_slivers(
                    boolean_diff(born, &offset_loops(part, self.xy_gap * 0.35)),
                    0.02,
                )
            };
            let seeds = if cleared.is_empty() { born } else { &cleared };
            // A fresh patch prints `iface_n` layers dense, so the lowest of
            // them stands on the layer below that.
            let under = held(i.checked_sub(self.iface_n as usize));
            let tips = sample_tips(
                seeds,
                &mut carriers,
                &under,
                &self.pitch,
                &land(self.iface_n),
            );
            for (p, load, to_bed) in tips {
                self.nodes.push(Node {
                    id: self.next_id,
                    xy: p,
                    above: p,
                    radius: self.tip_r,
                    dist: 0.0,
                    freeze: self.iface_n,
                    load,
                    to_bed,
                });
                self.next_id += 1;
            }
        }
        // Tips frozen at birth stay put while the part silhouette moves.
        // A patch that slid off every tip needs its own trunk, starting
        // on the very next layer, or the interface prints over air.
        seed_uncovered_interface(
            interface,
            &mut self.nodes,
            &mut self.next_id,
            self.tip_r,
            &mut carriers,
            &held(i.checked_sub(1)),
            &self.pitch,
            &land(1),
        );
        if self.floor.is_none() {
            if i == 0 {
                for n in &mut self.nodes {
                    if n.freeze == 0 {
                        n.radius = n.radius.max(self.trunk_r * 0.95);
                    }
                }
            }
        } else if let Some(floor) = self.floor {
            // The next layer is under the belt at this xy, so this knot is the foot.
            let next_z = if i == 0 {
                None
            } else {
                Some(self.bands[i - 1].z)
            };
            let fall = floor.fall(self.bands[i].height);
            for n in &mut self.nodes {
                if n.freeze != 0 {
                    continue;
                }
                let lands = next_z.is_none_or(|z| z + 1e-9 < floor.z_at(n.xy[1] + fall));
                if lands {
                    n.radius = n.radius.max(self.trunk_r * 0.95);
                }
            }
        }
    }

    /// Step every node from layer `i` down to the next among `fixed`, and
    /// record in `forest` how the limbs that stop here end.
    fn descend(&mut self, i: usize, fixed: &mut Fixed, forest: &mut Forest) {
        if i == 0 {
            return;
        }
        let below2 = if i > 1 { self.part(i - 2) } else { &[] };
        let grow = Grow {
            height: self.bands[i].height,
            lean: self.lean,
            tip_r: self.tip_r,
            trunk_r: self.trunk_r,
            xy_gap: self.xy_gap,
            next_is_bed: i == 1,
            load_factor: self.load_factor,
            floor_y_max: self.floor.map(|floor| floor.y_max(self.bands[i - 1].z)),
            drift: self
                .floor
                .map_or(0.0, |floor| floor.fall(self.bands[i].height)),
        };
        let nodes = std::mem::take(&mut self.nodes);
        self.nodes = propagate_nodes(
            nodes,
            self.part(i - 1),
            below2,
            &grow,
            fixed,
            &mut self.ended,
        );
        for (id, end) in self.ended.drain(..) {
            forest.limbs[id.0 as usize - 1].end = end;
        }
    }
}

/// Kept knots on the layer a regrow steps down to. They never move. A new
/// node may lean toward one and join it when it is already thick enough to
/// carry the node too; otherwise the node keeps its disk clear of it.
/// These are copies: each one's load counts the new nodes that joined its
/// limb on the way down, and the limb's own knot never does.
struct Fixed {
    knots: Vec<Node>,
    grid: CellGrid,
    widest: f64,
    /// The id of every kept knot joined on this step, and the load it took.
    joined: Vec<(NodeId, f64)>,
}

impl Fixed {
    /// `knots` in ascending id order.
    fn new(knots: Vec<Node>) -> Self {
        let mut grid = CellGrid::new(PAIR_CELL_MM);
        for (k, n) in knots.iter().enumerate() {
            grid.insert(k, n.xy);
        }
        let widest = knots.iter().map(|n| n.radius).fold(0.0, f64::max);
        Self {
            knots,
            grid,
            widest,
            joined: Vec::new(),
        }
    }

    fn is_empty(&self) -> bool {
        self.knots.is_empty()
    }

    /// Join `n` to a kept knot on this layer if one takes it: the smallest
    /// id that can carry it and whose disk holds `n`, at its grown radius,
    /// where it printed on the layer above.
    fn join(&mut self, n: &Node, grow: &Grow, max_step: f64) -> Option<NodeId> {
        if self.is_empty() {
            return None;
        }
        let reach = max_step + BEAD_OVERHANG_MM;
        let k = self
            .grid
            .around(n.above, self.widest + reach)
            .filter(|&k| {
                let h = &self.knots[k];
                can_carry(h, n, grow)
                    && (n.above[0] - h.xy[0]).hypot(n.above[1] - h.xy[1]) + n.radius
                        <= h.radius + reach
            })
            .min_by_key(|&k| self.knots[k].id)?;
        let host = &mut self.knots[k];
        host.load += n.load;
        self.joined.push((NodeId(host.id), n.load));
        Some(NodeId(host.id))
    }

    /// True when `n`'s disk at `p` would overlap a kept disk it cannot join.
    fn blocks(&self, p: [f64; 2], n: &Node, grow: &Grow) -> bool {
        !self.is_empty()
            && self.grid.around(p, self.widest + n.radius).any(|k| {
                let h = &self.knots[k];
                (p[0] - h.xy[0]).hypot(p[1] - h.xy[1]) < h.radius + n.radius
                    && !can_carry(h, n, grow)
            })
    }
}

/// True when kept `host` may take `guest` in without changing: both head
/// for the same ground, and the host's section already carries both loads.
fn can_carry(host: &Node, guest: &Node, grow: &Grow) -> bool {
    host.to_bed == guest.to_bed
        && section_radius(host.load + guest.load, grow.tip_r, grow.load_factor) <= host.radius
}

/// Run over rise of the steepest overhang that prints without support.
fn slope_of(angle_deg: f64) -> f64 {
    angle_deg.clamp(15.0, 75.0).to_radians().tan().max(0.2)
}

/// Layer `i`, the one under it, and how far past the lower one it may reach
/// unsupported. `None` on the first layer and on an empty one.
fn layer_pair<'a>(
    bands: &[LayerBand],
    contours: &'a [Vec<Loop>],
    i: usize,
    slope: f64,
) -> Option<(&'a [Loop], &'a [Loop], f64)> {
    let upper = contours.get(i).map(Vec::as_slice).unwrap_or(&[]);
    if i == 0 || upper.is_empty() {
        return None;
    }
    let lower = contours.get(i - 1).map(Vec::as_slice).unwrap_or(&[]);
    Some((upper, lower, bands[i].height / slope))
}

fn past_angle(upper: &[Loop], lower: &[Loop], dx: f64) -> Vec<Loop> {
    drop_slivers(boolean_diff(upper, &offset_loops(lower, dx)), 0.35)
}

/// Area of layer `i` that needs a column under it: past the overhang angle,
/// or a floating island.
fn overhang_at(bands: &[LayerBand], contours: &[Vec<Loop>], i: usize, slope: f64) -> Vec<Loop> {
    let Some((upper, lower, dx)) = layer_pair(bands, contours, i, slope) else {
        return Vec::new();
    };
    let angle_overhang = past_angle(upper, lower, dx);
    let islands = unsupported_islands(upper, lower, dx);
    if islands.is_empty() {
        angle_overhang
    } else {
        // Keep a small island the angle test would drop as a sliver.
        drop_slivers(boolean_union(&angle_overhang, &islands), 0.05)
    }
}

/// What a part sliced without supports prints over air, each region counted
/// once over the layers it joins. A region whose largest layer is under
/// `COVERAGE_SPECK_MM2` is left out, as coverage leaves it out.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
pub struct InAir {
    /// Same-layer islands with nothing under them.
    pub islands: u32,
    /// Overhangs past the support angle that no short bridge spans.
    pub overhangs: u32,
}

/// The islands and unbridged overhangs a part would print over air without
/// supports, for a warning.
pub(crate) fn in_air(bands: &[LayerBand], contours: &[Vec<Loop>], angle_deg: f64) -> InAir {
    let slope = slope_of(angle_deg);
    let (islands, overhangs): (Vec<Vec<Unheld>>, Vec<Vec<Unheld>>) = (0..bands.len())
        .into_par_iter()
        .map(|i| {
            let Some((upper, lower, dx)) = layer_pair(bands, contours, i, slope) else {
                return (Vec::new(), Vec::new());
            };
            let islands = unsupported_islands(upper, lower, dx);
            let wings = past_angle(upper, lower, dx);
            let wings = if islands.is_empty() {
                wings
            } else {
                drop_slivers(boolean_diff(&wings, &islands), 0.05)
            };
            let wings = exclude_short_bridges(&wings, lower, dx);
            (pieces_on(i, &islands), pieces_on(i, &wings))
        })
        .unzip();
    let count = |pieces: Vec<Vec<Unheld>>| {
        let pieces: Vec<Unheld> = pieces.into_iter().flatten().collect();
        // An overhang that steps out every layer leaves a strip per layer,
        // each one layer's reach past the one under it.
        let joined = |lower: &Unheld, upper: &Unheld| {
            let reach = bands[upper.layer].height / slope + 0.2;
            boxes_within(Some(lower.bounds), Some(upper.bounds), reach)
                && overlaps(&offset_loops(&lower.loops, reach), &upper.loops, 0.01)
        };
        patches(&pieces, joined)
            .iter()
            .filter(|patch| patch.area >= COVERAGE_SPECK_MM2)
            .count() as u32
    };
    InAir {
        islands: count(islands),
        overhangs: count(overhangs),
    }
}

/// A disk may overhang the one below by about half a bead and still print.
const BEAD_OVERHANG_MM: f64 = 0.22;
/// Clipper slop when an interface patch is tested against the layer under it.
const INTERFACE_FOOT_MM: f64 = 0.35;
/// Thinnest trunk disk drawn beside the part.
const MIN_DISK_R: f64 = 0.3;

/// Stand every layer from `from` up on the finished layer below it: settle
/// its disks, then drop the interface nothing holds. Each step on layer `i`
/// reads layer `i - 1` and writes only its own part of layer `i`, disks or
/// interface, so the two never see each other's change. Layers under `from`
/// must already be final.
#[allow(clippy::too_many_arguments)]
fn project(
    layers: &mut [SupportLayer],
    from: usize,
    bands: &[LayerBand],
    contours: &[Vec<Loop>],
    lean: f64,
    floor: Option<FloorPlane>,
    watch: &crate::progress::Watch,
    job: crate::cancel::Job,
) -> bool {
    let mut near = Vec::new();
    for i in from.max(1)..layers.len() {
        if watch.stopped(job) {
            return false;
        }
        let (lower, upper) = layers.split_at_mut(i);
        stand(
            &mut upper[0],
            &lower[i - 1],
            i,
            bands,
            contours,
            lean,
            floor,
            &mut near,
        );
    }
    true
}

/// Stand layer `i` on the finished layer below it, or on the belt.
#[allow(clippy::too_many_arguments)]
fn stand(
    layer: &mut SupportLayer,
    below: &SupportLayer,
    i: usize,
    bands: &[LayerBand],
    contours: &[Vec<Loop>],
    lean: f64,
    floor: Option<FloorPlane>,
    near: &mut Vec<usize>,
) {
    let part = contours.get(i - 1).map(Vec::as_slice).unwrap_or(&[]);
    let reach = bands[i].height * lean + BEAD_OVERHANG_MM;
    let belt = floor.map(|floor| floor.y_max(bands[i - 1].z));
    let drift = floor.map_or(0.0, |floor| floor.fall(bands[i].height));
    settle_disks(
        &mut layer.disks,
        &below.disks,
        part,
        belt,
        drift,
        reach,
        near,
    );
    // A trunk that cannot stand is dropped above. The interface that was
    // waiting on it would otherwise stay as a raft in the air.
    drop_unfooted_interface(&mut layer.interface, below, part);
}

/// Narrow any disk that is wider than what holds it: a disk on the layer
/// below grown by one lean step and half a bead, or the part itself. The
/// top-down walk shrinks disks beside the part, so the disk above a squeezed
/// one would otherwise overhang it. A disk whose room is below the minimum
/// printable radius cannot stand; flooring it to that radius would print a
/// speck in the air, so the disk is dropped and the trunk above it has to
/// find its own footing.
fn settle_disks(
    disks: &mut Vec<Disk>,
    below: &[Disk],
    part: &[Loop],
    belt: Option<f64>,
    drift: f64,
    reach: f64,
    near: &mut Vec<usize>,
) {
    if disks.is_empty() {
        return;
    }
    // A disk farther than this leaves less than -1 mm of room, below
    // MIN_DISK_R, so it never changes which disks stay or how wide.
    let span = below.iter().map(|d| d.r).fold(0.0, f64::max) + reach + 1.0;
    let mut grid = CellGrid::new(span);
    for (k, b) in below.iter().enumerate() {
        grid.insert(k, b.xy);
    }
    disks.retain_mut(|d| {
        let c = d.xy;
        // Where the disk lands one layer down. A disk whose centre lands on
        // the belt stands on it.
        let fell = [c[0], c[1] + drift];
        if belt.is_some_and(|y_max| fell[1] > y_max) {
            return true;
        }
        grid.near(fell, span, near);
        let mut room = near
            .iter()
            .map(|&k| {
                let b = below[k];
                b.r + reach - (fell[0] - b.xy[0]).hypot(fell[1] - b.xy[1])
            })
            .fold(f64::NEG_INFINITY, f64::max);
        if !part.is_empty() && in_solid(part, c[0], c[1]) {
            room = room.max(distance_to_outline(part, c) + reach);
        }
        if room < MIN_DISK_R {
            return false;
        }
        d.r = d.r.min(room);
        true
    });
}

#[derive(Clone, Copy)]
pub(crate) struct Node {
    id: u32,
    xy: [f64; 2],
    /// Where its disk printed on the layer above, carried down by the fall to
    /// this layer, before this layer's step.
    above: [f64; 2],
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
fn organic_disks(nodes: &[Node], part: &[Loop], xy_gap: f64) -> Vec<Disk> {
    let mut disks = Vec::new();
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
        disks.push(Disk {
            xy: n.xy,
            r: n.radius.min(room).max(MIN_DISK_R),
            node: NodeId(n.id),
        });
    }
    disks
}

struct Grow {
    height: f64,
    lean: f64,
    tip_r: f64,
    trunk_r: f64,
    xy_gap: f64,
    next_is_bed: bool,
    load_factor: f64,
    /// Largest Y that still sits on the belt on the layer being stepped onto.
    /// `None` keeps the cartesian walk.
    floor_y_max: Option<f64>,
    /// Slice Y every unfrozen node falls toward the belt on this step. `0`
    /// off a belt, where nodes fall straight down.
    drift: f64,
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

/// Load a section of `radius` carries: `section_radius` the other way round.
fn section_load(radius: f64, tip_r: f64, load_factor: f64) -> f64 {
    load_factor.max(0.5) * (radius / tip_r).powi(2)
}

/// Radius a branch gains per millimetre it falls, so a lone branch still
/// widens toward its foot. Thickness mostly comes from merges, which add
/// section area, so a branch is thick where it carries many tips and thin
/// under the interface. Speed stays slim; toughness flares about twice as fast.
fn flare_per_mm(load_factor: f64) -> f64 {
    (0.09 / load_factor.max(0.5).sqrt()).clamp(0.03, 0.08)
}

/// Farthest two branches may lean toward each other to share a trunk.
const PAIR_REACH_MM: f64 = 22.0;

/// Step every unfrozen node down one layer: lean toward the branch it pairs
/// with, thicken for the load it already carries, merge when one trunk can hold both, and
/// stop on a supported mesh face. Frozen nodes are the interface tips and do not move.
/// Every node that does not reach the next layer is pushed onto `ended`.
/// `fixed` are kept knots on the next layer: pair targets, hosts, and obstacles.
fn propagate_nodes(
    nodes: Vec<Node>,
    below: &[Loop],
    below2: &[Loop],
    grow: &Grow,
    fixed: &mut Fixed,
    ended: &mut Vec<(NodeId, End)>,
) -> Vec<Node> {
    let max_step = (grow.height * grow.lean).clamp(0.05, 4.0);
    let (below, below2) = (LoopIndex::new(below), LoopIndex::new(below2));
    let mut next = Vec::with_capacity(nodes.len());
    for mut n in nodes {
        // A plumb trunk meets the tilted belt over several layers, so it
        // stops once its whole disk is past the belt.
        if grow
            .floor_y_max
            .is_some_and(|y_max| n.xy[1] - n.radius > y_max)
        {
            ended.push((NodeId(n.id), End::Landed));
            continue;
        }
        if n.freeze > 0 {
            n.freeze -= 1;
            next.push(n);
            continue;
        }
        if !below.is_empty() && below.contains(n.xy) {
            let supported = below2.is_empty() || below2.contains(n.xy);
            if supported {
                ended.push((NodeId(n.id), End::Landed));
                continue;
            }
        }
        next.push(n);
    }
    if grow.drift > 0.0 {
        for n in next.iter_mut().filter(|n| n.freeze == 0) {
            n.xy[1] += grow.drift;
        }
    }
    let steps = pair_steps(&next, &fixed.knots, grow, max_step);
    for (n, xy) in next.iter_mut().zip(steps) {
        n.above = n.xy;
        n.xy = xy;
    }
    let flare = flare_per_mm(grow.load_factor) * grow.height;
    let mut kept = Vec::with_capacity(next.len());
    for mut n in next {
        if n.freeze > 0 {
            kept.push(n);
            continue;
        }
        n.dist += grow.height;
        n.radius = (n.radius + flare)
            .max(section_radius(n.load, grow.tip_r, grow.load_factor))
            .min(grow.trunk_r);
        // A kept host has a smaller id than any new node, so it comes first.
        if let Some(into) = fixed.join(&n, grow, max_step) {
            ended.push((NodeId(n.id), End::Merged { into }));
            continue;
        }
        let clearance = grow.xy_gap + n.radius;
        let blocked = |p: [f64; 2]| {
            (!below.is_empty() && (below.contains(p) || below.within(p, clearance)))
                || fixed.blocks(p, &n, grow)
        };
        // A node the part blocks may also undo its fall, so on a belt it can
        // lean away from a wall that gravity runs along.
        let to = push_out(n.xy, blocked, max_step + grow.drift);
        n.xy = to;
        if below.contains(n.xy) {
            ended.push((NodeId(n.id), End::Pinched));
            continue;
        }
        if grow
            .floor_y_max
            .is_some_and(|y_max| n.xy[1] - n.radius > y_max)
        {
            ended.push((NodeId(n.id), End::Landed));
            continue;
        }
        kept.push(n);
    }
    merge_nodes(&mut kept, grow, max_step, ended);
    if grow.next_is_bed {
        for n in &mut kept {
            if n.freeze == 0 {
                n.radius = n.radius.max(grow.trunk_r * 0.95);
            }
        }
    }
    kept
}

/// Where each node stands on the next layer. Pairs are matched greedily,
/// closest first, and each pair walks toward its section-weighted meeting
/// point: the thicker branch stays nearly upright and the thinner one leans in.
/// A merged pair is matched again lower down, so neighbouring tips join into
/// branches and branches into trunks. Leaning toward the centroid of every
/// neighbour instead cancels out inside a row of tips, and the row falls as
/// parallel columns. A node whose neighbours are all taken leans toward the
/// nearest one and joins that branch after it merges. A `fixed` knot is
/// matched like a node but never moves: its partner walks all the way to it.
fn pair_steps(nodes: &[Node], fixed: &[Node], grow: &Grow, max_step: f64) -> Vec<[f64; 2]> {
    // A fixed knot past the pair reach of every node pairs with none, and
    // leaving it out keeps the order of the rest.
    let bounds = if fixed.is_empty() {
        None
    } else {
        loop_bounds(&[nodes.iter().map(|n| n.xy).collect()])
    };
    let fixed: Vec<Node> = match bounds {
        Some((lo, hi)) => fixed
            .iter()
            .filter(|k| {
                let reach = PAIR_REACH_MM + 1e-6;
                k.xy[0] >= lo[0] - reach
                    && k.xy[0] <= hi[0] + reach
                    && k.xy[1] >= lo[1] - reach
                    && k.xy[1] <= hi[1] + reach
            })
            .copied()
            .collect(),
        None => Vec::new(),
    };
    // Indices past the nodes are fixed knots.
    let all = nodes.len() + fixed.len();
    let node = |i: usize| {
        if i < nodes.len() {
            &nodes[i]
        } else {
            &fixed[i - nodes.len()]
        }
    };
    let mut live: Vec<usize> = (0..all).filter(|&i| node(i).freeze == 0).collect();
    live.sort_by(|&a, &b| node(a).xy[0].total_cmp(&node(b).xy[0]));
    let mut rank = vec![usize::MAX; all];
    for (r, &i) in live.iter().enumerate() {
        rank[i] = r;
    }
    let mut grid = CellGrid::new(PAIR_CELL_MM);
    for &i in &live {
        grid.insert(i, node(i).xy);
    }
    let pair = |u: usize, v: usize| -> Option<Pair> {
        let (a, b) = if rank[u] < rank[v] { (u, v) } else { (v, u) };
        if node(b).xy[0] - node(a).xy[0] > PAIR_REACH_MM {
            return None;
        }
        let met = match (a < nodes.len(), b < nodes.len()) {
            (true, true) => meet(node(a), node(b), grow),
            (true, false) => meet_fixed(node(a), node(b), grow),
            (false, true) => meet_fixed(node(b), node(a), grow),
            (false, false) => None,
        };
        met.map(|(d, at)| Pair { d, a, b, at })
    };
    // The best pair for `u` among nodes not in `taken`. Ring `r` of cells is
    // at least (r - 1) cells away, so the search stops once that passes the
    // best distance found, after every tie at that distance has been seen.
    let best_for = |u: usize, taken: &[bool]| -> Option<Pair> {
        let (cx, cy) = grid.key(node(u).xy[0], node(u).xy[1]);
        let mut best: Option<Pair> = None;
        for r in 0i64.. {
            let floor = (r - 1).max(0) as f64 * grid.cell - 1e-6;
            if floor > PAIR_REACH_MM || best.as_ref().is_some_and(|b| floor > b.d) {
                break;
            }
            for (x, y) in ring_cells(cx, cy, r) {
                for &v in grid.buckets.get(&(x, y)).map(Vec::as_slice).unwrap_or(&[]) {
                    if v == u || taken[v] {
                        continue;
                    }
                    if let Some(p) = pair(u, v) {
                        if best.as_ref().is_none_or(|b| p.before(b)) {
                            best = Some(p);
                        }
                    }
                }
            }
        }
        best
    };
    // Greedy matching over pairs sorted by (distance, x order) is the same as
    // matching mutual best pairs in any order: the smallest pair left is
    // always mutual, and matching elsewhere never changes a mutual pair.
    let none = vec![false; all];
    let mut best: Vec<Option<Pair>> = vec![None; all];
    let mut watchers: Vec<Vec<usize>> = vec![Vec::new(); all];
    for &u in &live {
        best[u] = best_for(u, &none);
        if let Some(p) = &best[u] {
            watchers[p.other(u)].push(u);
        }
    }
    let nearest: Vec<Option<[f64; 2]>> = best.iter().map(|p| p.as_ref().map(|p| p.at)).collect();
    let mut taken = vec![false; all];
    let mut target: Vec<Option<[f64; 2]>> = vec![None; all];
    let mut stack: Vec<usize> = live.iter().rev().copied().collect();
    while let Some(u) = stack.pop() {
        if taken[u] {
            continue;
        }
        let Some(p) = best[u] else {
            continue;
        };
        let v = p.other(u);
        if taken[v] {
            best[u] = best_for(u, &taken);
            if let Some(q) = &best[u] {
                watchers[q.other(u)].push(u);
                stack.push(u);
            }
            continue;
        }
        if best[v].as_ref().is_some_and(|q| q.other(v) == u) {
            taken[u] = true;
            taken[v] = true;
            target[u] = Some(p.at);
            target[v] = Some(p.at);
            stack.append(&mut std::mem::take(&mut watchers[u]));
            stack.append(&mut std::mem::take(&mut watchers[v]));
        }
    }
    nodes
        .iter()
        .enumerate()
        .map(|(i, n)| match target[i].or(nearest[i]) {
            Some(at) if n.freeze == 0 => step_toward(n.xy, at, max_step),
            _ => n.xy,
        })
        .collect()
}

const PAIR_CELL_MM: f64 = 3.0;

/// Two nodes that may walk toward each other: their distance, the earlier and
/// later node in x order, and where they meet.
#[derive(Clone, Copy)]
struct Pair {
    d: f64,
    a: usize,
    b: usize,
    at: [f64; 2],
}

impl Pair {
    fn other(&self, u: usize) -> usize {
        if self.a == u {
            self.b
        } else {
            self.a
        }
    }

    fn before(&self, other: &Pair) -> bool {
        self.d
            .total_cmp(&other.d)
            .then(self.a.cmp(&other.a))
            .then(self.b.cmp(&other.b))
            .is_lt()
    }
}

/// Distance and section-weighted meeting point, or `None` when the two may not pair.
fn meet(a: &Node, b: &Node, grow: &Grow) -> Option<(f64, [f64; 2])> {
    if a.to_bed != b.to_bed {
        return None;
    }
    let d = (a.xy[0] - b.xy[0]).hypot(a.xy[1] - b.xy[1]);
    if d > PAIR_REACH_MM {
        return None;
    }
    if grow.load_factor >= 3.0 && !carries(a, b, grow) {
        return None;
    }
    let (wa, wb) = (a.radius.powi(2), b.radius.powi(2));
    let at = [
        (a.xy[0] * wa + b.xy[0] * wb) / (wa + wb),
        (a.xy[1] * wa + b.xy[1] * wb) / (wa + wb),
    ];
    Some((d, at))
}

/// `meet` for a node and a kept knot, which stays where it is. The node
/// leans only toward a knot that can take it in.
fn meet_fixed(n: &Node, kept: &Node, grow: &Grow) -> Option<(f64, [f64; 2])> {
    let d = (n.xy[0] - kept.xy[0]).hypot(n.xy[1] - kept.xy[1]);
    (d <= PAIR_REACH_MM && can_carry(kept, n, grow)).then_some((d, kept.xy))
}

/// Cells at Chebyshev distance exactly `r` from (cx, cy).
fn ring_cells(cx: i64, cy: i64, r: i64) -> impl Iterator<Item = (i64, i64)> {
    let side = (-r..=r).flat_map(move |t| {
        let edges = [(cx + t, cy - r), (cx + t, cy + r)];
        let sides = [(cx - r, cy + t), (cx + r, cy + t)];
        let inner = t > -r && t < r;
        edges
            .into_iter()
            .chain(sides.into_iter().filter(move |_| inner))
    });
    let centre = std::iter::once((cx, cy)).filter(move |_| r == 0);
    centre.chain(side.filter(move |_| r > 0))
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

/// Step toward the nearest point that is not `blocked`, at most `max_step`.
/// A node that needs a longer move takes it over several layers, so every
/// disk still sits on the one under it.
fn push_out(xy: [f64; 2], blocked: impl Fn([f64; 2]) -> bool, max_step: f64) -> [f64; 2] {
    if !blocked(xy) {
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
/// and the merged trunk still holds both parent disks. The merged section is
/// the sum of both, up to the trunk cap. Nodes are scanned by id, so the host
/// keeps the smaller id. `max_step` is one lean step.
fn merge_nodes(nodes: &mut Vec<Node>, grow: &Grow, max_step: f64, ended: &mut Vec<(NodeId, End)>) {
    if nodes.len() < 2 {
        return;
    }
    let reach = max_step + BEAD_OVERHANG_MM;
    nodes.sort_by_key(|n| n.id);
    // `holds_both` needs d + r_host + r_guest <= 2 * (merged + reach), and the
    // merged radius is capped at the trunk, so no host sits farther than this.
    let span = 2.0 * (grow.trunk_r + reach) + 1e-3;
    let mut grid = CellGrid::new(span);
    let mut near = Vec::new();
    let mut kept: Vec<Node> = Vec::new();
    for n in nodes.drain(..) {
        if n.freeze > 0 {
            kept.push(n);
            continue;
        }
        grid.near(n.xy, span, &mut near);
        near.sort_unstable();
        let found = near.iter().copied().find(|&k| {
            let k = &kept[k];
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
            // Speed rates each trunk's load. A merge may not exceed it.
            let speed = grow.load_factor >= 3.0;
            if speed && !carries(k, &n, grow) {
                return false;
            }
            holds_both(k, &n, grow.trunk_r, max_step)
        });
        if let Some(at) = found {
            let host = &mut kept[at];
            let was = host.xy;
            host.xy = merge_point(host, &n, max_step);
            host.load += n.load;
            host.dist = host.dist.max(n.dist);
            // Section area adds up at a fork, so thickness follows the tips carried.
            host.radius = (host.radius.powi(2) + n.radius.powi(2))
                .sqrt()
                .max(section_radius(host.load, grow.tip_r, grow.load_factor))
                .min(grow.trunk_r);
            ended.push((
                NodeId(n.id),
                End::Merged {
                    into: NodeId(host.id),
                },
            ));
            grid.relocate(at, was, host.xy);
        } else {
            grid.insert(kept.len(), n.xy);
            kept.push(n);
        }
    }
    *nodes = kept;
}

/// Point indices bucketed by square cells. `near` returns every index whose
/// cell meets the square of half-width `r` around a point, so callers still
/// apply their exact test.
struct CellGrid {
    cell: f64,
    buckets: HashMap<(i64, i64), Vec<usize>>,
}

impl CellGrid {
    fn new(cell: f64) -> Self {
        Self {
            cell: cell.max(1e-3),
            buckets: HashMap::new(),
        }
    }

    fn key(&self, x: f64, y: f64) -> (i64, i64) {
        (
            (x / self.cell).floor() as i64,
            (y / self.cell).floor() as i64,
        )
    }

    fn insert(&mut self, i: usize, p: [f64; 2]) {
        let key = self.key(p[0], p[1]);
        self.buckets.entry(key).or_default().push(i);
    }

    fn relocate(&mut self, i: usize, from: [f64; 2], to: [f64; 2]) {
        let (old, new) = (self.key(from[0], from[1]), self.key(to[0], to[1]));
        if old == new {
            return;
        }
        if let Some(bucket) = self.buckets.get_mut(&old) {
            bucket.retain(|&k| k != i);
        }
        self.buckets.entry(new).or_default().push(i);
    }

    fn near(&self, p: [f64; 2], r: f64, out: &mut Vec<usize>) {
        out.clear();
        let (lo, hi) = (self.key(p[0] - r, p[1] - r), self.key(p[0] + r, p[1] + r));
        for cx in lo.0..=hi.0 {
            for cy in lo.1..=hi.1 {
                if let Some(bucket) = self.buckets.get(&(cx, cy)) {
                    out.extend_from_slice(bucket);
                }
            }
        }
    }

    /// `near` as an iterator, for lookups made too often to fill a list.
    fn around(&self, p: [f64; 2], r: f64) -> impl Iterator<Item = usize> + '_ {
        let (lo, hi) = (self.key(p[0] - r, p[1] - r), self.key(p[0] + r, p[1] + r));
        (lo.0..=hi.0)
            .flat_map(move |cx| (lo.1..=hi.1).filter_map(move |cy| self.buckets.get(&(cx, cy))))
            .flatten()
            .copied()
    }
}

/// Where a merged trunk stands: toward the point between the two, nearer the
/// thicker, as far as what is left of the host's lean step allows. A trunk
/// that takes in a fresh tip on every layer would otherwise walk with them.
fn merge_point(host: &Node, guest: &Node, max_step: f64) -> [f64; 2] {
    let w = (host.radius + guest.radius).max(1e-6);
    let between = [
        (host.xy[0] * host.radius + guest.xy[0] * guest.radius) / w,
        (host.xy[1] * host.radius + guest.xy[1] * guest.radius) / w,
    ];
    let leaned = (host.xy[0] - host.above[0]).hypot(host.xy[1] - host.above[1]);
    step_toward(host.xy, between, (max_step - leaned).max(0.0))
}

/// True when the merged disk still sits under both parent disks within one
/// lean step, as `settle_disks` tests it: from where each parent printed on
/// the layer above, not from where this layer's step moved it.
fn holds_both(host: &Node, guest: &Node, trunk_r: f64, max_step: f64) -> bool {
    let merged = (host.radius.powi(2) + guest.radius.powi(2))
        .sqrt()
        .min(trunk_r);
    let at = merge_point(host, guest, max_step);
    let reach = max_step + BEAD_OVERHANG_MM;
    let holds =
        |n: &Node| (n.above[0] - at[0]).hypot(n.above[1] - at[1]) + n.radius <= merged + reach;
    holds(host) && holds(guest)
}

/// True when one trunk at the cap radius can carry both loads at the longer fall.
fn carries(a: &Node, b: &Node, grow: &Grow) -> bool {
    let cap = tip_capacity(
        grow.trunk_r,
        a.dist.max(b.dist),
        grow.tip_r,
        grow.load_factor,
    );
    a.load + b.load <= cap + 1e-6
}

/// Where a fresh tip is born, and the part it might still lean onto.
struct Land<'a> {
    layer: usize,
    freeze: u32,
    lean: f64,
    bands: &'a [LayerBand],
    contours: &'a [Vec<Loop>],
    bounds: &'a [Option<([f64; 2], [f64; 2])>],
    /// The belt, toward which a trunk drifts as it falls.
    floor: Option<FloorPlane>,
}

/// True when a tip at `xy` can walk onto a roof before the bed. Horizontal
/// travel starts after the frozen interface layers, then grows by one lean
/// step per layer. A vertical wall is not a landing: the trunk is pushed
/// out of the mesh and keeps falling. Only a layer that sticks out past the
/// one above (or is the top of a column) can catch it.
fn reaches_model(xy: [f64; 2], land: &Land<'_>) -> bool {
    let first = land.layer.saturating_sub(land.freeze as usize + 1);
    let mut reach = 0.0;
    let mut xy = xy;
    for j in (0..=first).rev() {
        let from = j + 1;
        if from < land.bands.len() {
            reach += land.bands[from].height * land.lean;
            if let Some(floor) = land.floor {
                xy[1] += floor.fall(land.bands[from].height);
            }
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

impl Pitch {
    fn of(opts: &SupportOpts) -> Self {
        let density = opts.density.clamp(0.0, 1.0);
        // Fine grid finds concave overhangs. `keep` is the pitch we actually
        // leave standing: extra samples are packed onto a neighbour that can carry them.
        let fine = (opts.branch_spacing / (0.55 + 0.9 * density)).clamp(2.2, 9.0);
        let keep = tip_spacing(opts, fine);
        let tip_r = tip_radius(opts);
        Self {
            // A tighter knob than the fine grid has to actually sample tighter.
            fine: fine.min(keep),
            keep,
            capacity: tip_capacity(tip_r, 0.0, tip_r, load_factor_of(opts)),
        }
    }
}

fn tip_radius(opts: &SupportOpts) -> f64 {
    (opts.tip_diameter * 0.5).clamp(0.25, 1.6)
}

/// One packed tip per neighbourhood. A grid over the combined bbox, with the
/// bbox centre as a fallback, misses a concave patch (the centre sits in the
/// notch) and misses a second island when the first one already caught a sample.
/// Samples within half of `keep` fold into a neighbour that still has capacity,
/// so the interface bridges to that neighbour instead of growing a parallel trunk.
/// Tips that can lean onto the model and tips that have to reach the bed pack
/// separately: swallowing the second into the first deletes the bed trunk.
/// Each tip joins `carriers`.
fn sample_tips(
    region: &[Loop],
    carriers: &mut Carriers,
    held: &Nearby,
    pitch: &Pitch,
    land: &Land<'_>,
) -> Vec<([f64; 2], f64, bool)> {
    let mut pts = Vec::new();
    for comp in components(region) {
        let hit = tip_samples(&comp, carriers, held, pitch);
        let packed = pack_by_landing(hit, &comp, pitch, land);
        for tip in &packed {
            carriers.add(tip.0);
        }
        pts.extend(packed);
    }
    pts
}

/// Where a fresh sample would bear a tip on `comp`, less every sample a
/// carrier already holds.
///
/// A strip too thin for the fine grid takes one sample in each cell of a
/// grid fixed to the bed that it crosses, so a strip a block disk cuts
/// yields the cells of the strip it still covers and no more.
///
/// A sample folds into a carrier when `held`, the interface demanded on the
/// layer that `comp`'s interface stands on, touches `comp`. That interface
/// holds it from below, as each layer of a slope holds the next, so a tip
/// within a pitch is enough. An island has nothing under it and keeps its own.
fn tip_samples(comp: &[Loop], carriers: &Carriers, held: &Nearby, pitch: &Pitch) -> Vec<[f64; 2]> {
    let mut hit = sample_component(comp, pitch.fine);
    if hit.len() <= 1 && is_strip(comp, pitch) {
        let cells = sample_cells(comp, pitch.keep);
        if cells.len() > 1 {
            hit = cells;
        }
    }
    if hit.is_empty() {
        if let Some(p) = point_inside(comp) {
            hit.push(p);
        }
    }
    if hit.iter().any(|s| carriers.carries(*s)) && stands_on(comp, held) {
        hit.retain(|s| !carriers.carries(*s));
    }
    hit
}

/// True when `comp` is narrower than a quarter of the fine grid, so the grid misses
/// it, and longer than one tip's pitch.
fn is_strip(comp: &[Loop], pitch: &Pitch) -> bool {
    let Some((min, max)) = loop_bounds(comp) else {
        return false;
    };
    let perimeter: f64 = comp
        .iter()
        .map(|ring| {
            (0..ring.len())
                .map(|k| {
                    let (a, b) = (ring[k], ring[(k + 1) % ring.len()]);
                    (b[0] - a[0]).hypot(b[1] - a[1])
                })
                .sum::<f64>()
        })
        .sum();
    let width = 2.0 * solid_area(comp) / perimeter.max(1e-9);
    width < pitch.fine * 0.25 && (max[0] - min[0]).hypot(max[1] - min[1]) > pitch.keep
}

/// One point in each cell of a `cell` grid fixed to the bed that `comp`
/// crosses. A thin strip crosses only the cells its outline passes through.
fn sample_cells(comp: &[Loop], cell: f64) -> Vec<[f64; 2]> {
    let key = |p: [f64; 2]| ((p[0] / cell).floor() as i64, (p[1] / cell).floor() as i64);
    let mut cells: Vec<(i64, i64)> = Vec::new();
    for ring in comp {
        for (k, &a) in ring.iter().enumerate() {
            let b = ring[(k + 1) % ring.len()];
            let steps = ((b[0] - a[0]).hypot(b[1] - a[1]) / (cell * 0.5))
                .ceil()
                .max(1.0) as usize;
            for t in 0..=steps {
                let f = t as f64 / steps as f64;
                cells.push(key([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f]));
            }
        }
    }
    cells.sort_unstable_by_key(|&(cx, cy)| (cy, cx));
    cells.dedup();
    cells
        .into_iter()
        .filter_map(|(cx, cy)| {
            let (x, y) = (cx as f64 * cell, cy as f64 * cell);
            let square = vec![[x, y], [x + cell, y], [x + cell, y + cell], [x, y + cell]];
            let inside = boolean_intersect(comp, &[square]);
            if solid_area(&inside) < CELL_SPECK_MM2 {
                return None;
            }
            point_inside(&inside)
        })
        .collect()
}

/// Less of a strip than this in one cell bears no sample there, mm².
const CELL_SPECK_MM2: f64 = 0.05;

/// True when `held` foots `comp` as `drop_unfooted_interface` tests it.
fn stands_on(comp: &[Loop], held: &Nearby) -> bool {
    let Some(bounds) = loop_bounds(comp) else {
        return false;
    };
    let near = held.near(bounds, INTERFACE_FOOT_MM + 0.05);
    if near.is_empty() {
        return false;
    }
    overlaps(
        comp,
        &offset_loops(&resolve_nonzero(near), INTERFACE_FOOT_MM),
        0.02,
    )
}

/// The tips standing on a layer, or born on it, that a fresh sample within
/// `reach` folds into. A packed tip carries samples half a pitch to either
/// side of it, but a slope sweeps past a carrier on one side only, so a
/// reach of one pitch spaces slope tips as a flat patch spaces its tips.
struct Carriers {
    at: Vec<[f64; 2]>,
    grid: CellGrid,
    reach: f64,
}

impl Carriers {
    fn new(nodes: &[Node], reach: f64) -> Self {
        let mut carriers = Self {
            at: Vec::with_capacity(nodes.len()),
            grid: CellGrid::new(reach.max(0.5)),
            reach,
        };
        for n in nodes {
            carriers.add(n.xy);
        }
        carriers
    }

    fn add(&mut self, p: [f64; 2]) {
        self.grid.insert(self.at.len(), p);
        self.at.push(p);
    }

    fn carries(&self, s: [f64; 2]) -> bool {
        self.grid.around(s, self.reach).any(|k| {
            let p = self.at[k];
            (p[0] - s[0]).hypot(p[1] - s[1]) <= self.reach
        })
    }
}

fn pack_by_landing(
    hit: Vec<[f64; 2]>,
    region: &[Loop],
    pitch: &Pitch,
    land: &Land<'_>,
) -> Vec<([f64; 2], f64, bool)> {
    let reach = pitch.keep * 0.5;
    if hit.len() <= 1 {
        return pack_tips(hit, region, reach, pitch.capacity)
            .into_iter()
            .map(|(p, load)| (p, load, false))
            .collect();
    }
    let (on_model, to_bed): (Vec<_>, Vec<_>) =
        hit.into_iter().partition(|p| reaches_model(*p, land));
    let mut packed: Vec<_> = pack_tips(on_model, region, reach, pitch.capacity)
        .into_iter()
        .map(|(p, load)| (p, load, false))
        .collect();
    packed.extend(
        pack_tips(to_bed, region, reach, pitch.capacity)
            .into_iter()
            .map(|(p, load)| (p, load, true)),
    );
    packed
}

/// Greedy pack. Each keeper absorbs later samples within `reach` of its own
/// sample until `capacity` tip-units are used, and its tip stands at the centre
/// of the samples it carries so the patch overhangs it evenly. A sample the
/// keepers cannot carry stays as its own tip.
fn pack_tips(
    mut pts: Vec<[f64; 2]>,
    region: &[Loop],
    reach: f64,
    capacity: f64,
) -> Vec<([f64; 2], f64)> {
    if pts.len() <= 1 || reach <= 0.0 {
        return pts.into_iter().map(|p| (p, 1.0)).collect();
    }
    let cap = capacity.max(1.0);
    pts.sort_by(|a, b| a[0].total_cmp(&b[0]).then(a[1].total_cmp(&b[1])));
    // The keeper's own sample is first.
    let mut kept: Vec<Vec<[f64; 2]>> = Vec::new();
    for p in pts {
        let mut best: Option<(usize, f64)> = None;
        for (i, carried) in kept.iter().enumerate() {
            if carried.len() as f64 + 1.0 > cap + 1e-6 {
                continue;
            }
            let q = carried[0];
            let dist = (q[0] - p[0]).hypot(q[1] - p[1]);
            if dist > reach {
                continue;
            }
            if best.map(|(_, bd)| dist < bd).unwrap_or(true) {
                best = Some((i, dist));
            }
        }
        match best {
            Some((i, _)) => kept[i].push(p),
            None => kept.push(vec![p]),
        }
    }
    kept.into_iter()
        .map(|carried| (tip_centre(&carried, region), carried.len() as f64))
        .collect()
}

/// Centroid of the carried samples. On a ring around a post the centroid is
/// over the post, so the tip takes the carried sample nearest it instead.
fn tip_centre(carried: &[[f64; 2]], region: &[Loop]) -> [f64; 2] {
    if let [only] = carried {
        return *only;
    }
    let n = carried.len() as f64;
    let c = [
        carried.iter().map(|p| p[0]).sum::<f64>() / n,
        carried.iter().map(|p| p[1]).sum::<f64>() / n,
    ];
    if in_solid(region, c[0], c[1]) {
        return c;
    }
    let off = |p: &[f64; 2]| (p[0] - c[0]).hypot(p[1] - c[1]);
    carried
        .iter()
        .min_by(|a, b| off(a).total_cmp(&off(b)))
        .copied()
        .unwrap_or(c)
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

/// Give every interface component no node covers a tip, unless a carrier
/// holds it with `held`, the interface demanded on the layer below, under
/// it: see `tip_samples`. `freeze` is 1 so the disk prints on the next layer,
/// directly under this patch, instead of after the whole interface stack.
#[allow(clippy::too_many_arguments)]
fn seed_uncovered_interface(
    region: &[Loop],
    nodes: &mut Vec<Node>,
    next_id: &mut u32,
    tip_r: f64,
    carriers: &mut Carriers,
    held: &Nearby,
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
        let seeds = tip_samples(&comp, carriers, held, pitch);
        for (xy, load, to_bed) in pack_by_landing(seeds, &comp, pitch, land) {
            carriers.add(xy);
            nodes.push(Node {
                id: *next_id,
                xy,
                above: xy,
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

fn branch_foots(comp: &[Loop], disks: &[Disk]) -> bool {
    disks.iter().any(|d| {
        in_solid(comp, d.xy[0], d.xy[1])
            || distance_to_outline(comp, d.xy) <= d.r + INTERFACE_FOOT_MM
    })
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
        if branch_foots(&comp, &below.disks) {
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

/// Drop each interface piece that has no trunk, lower interface, or part
/// under it on the layer below.
fn drop_unfooted_interface(interface: &mut Vec<Loop>, below: &SupportLayer, part: &[Loop]) {
    if interface.is_empty() {
        return;
    }
    let pieces = interface_pieces(interface);
    // Most patches sit on a trunk tip. Skip the part-offset unless one does not.
    if pieces.iter().all(|comp| branch_foots(comp, &below.disks)) {
        return;
    }
    let mut ground = below.interface.clone();
    ground.extend(below.sparse.iter().cloned());
    ground.extend(part.iter().cloned());
    let ground = Nearby::new(ground);
    let mut gone: Vec<Loop> = Vec::new();
    for comp in pieces {
        if branch_foots(&comp, &below.disks) {
            continue;
        }
        let Some(bounds) = loop_bounds(&comp) else {
            continue;
        };
        // The footing is an offset of a union, so only loops within the
        // offset of this piece's box can reach it.
        let near = ground.near(bounds, INTERFACE_FOOT_MM + 0.05);
        let foot = if near.is_empty() {
            Vec::new()
        } else {
            offset_loops(&resolve_nonzero(near), INTERFACE_FOOT_MM)
        };
        if foot.is_empty() || !overlaps(&comp, &foot, 0.02) {
            gone = boolean_union(&gone, &comp);
        }
    }
    if !gone.is_empty() {
        // Subtract from the original so a kept ring does not lose its hole.
        *interface = drop_slivers(boolean_diff(interface, &gone), 0.05);
    }
}

/// A deck this short, held on two opposite sides, can bridge. Longer spans
/// and one-sided wings print in the air.
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
    let bed = Nearby::new(if lower.is_empty() {
        Vec::new()
    } else {
        offset_loops(lower, margin.max(0.0))
    });
    let boxes: Vec<Option<Bounds>> = comps.iter().map(|c| loop_bounds(c)).collect();
    let mut grounded: Vec<bool> = comps
        .iter()
        .zip(&boxes)
        .map(|(comp, bounds)| {
            solid_area(comp) >= 0.05
                && bounds.is_some_and(|b| overlaps(comp, &bed.near(b, 0.0), 0.05))
        })
        .collect();
    let mut grown: Vec<Option<Vec<Loop>>> = vec![None; comps.len()];
    let mut changed = true;
    while changed {
        changed = false;
        for i in 0..comps.len() {
            if grounded[i] {
                continue;
            }
            for j in 0..comps.len() {
                if i == j || !grounded[j] || !boxes_within(boxes[i], boxes[j], 0.8) {
                    continue;
                }
                let reach = grown[i].get_or_insert_with(|| offset_loops(&comps[i], 0.8));
                if overlaps(reach, &comps[j], 0.02) {
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
        // A point on the hole itself lies in its own outline and in no island
        // standing inside the hole. The hole's centroid can land on such an
        // island: a tray's cavity centred on a plate went to the plate, and
        // the tray outline became one solid overhang.
        let c = loop_[0];
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

type Bounds = ([f64; 2], [f64; 2]);

fn boxes_within(a: Option<Bounds>, b: Option<Bounds>, pad: f64) -> bool {
    match (a, b) {
        (Some((amn, amx)), Some((bmn, bmx))) => {
            amn[0] - pad <= bmx[0]
                && bmn[0] <= amx[0] + pad
                && amn[1] - pad <= bmx[1]
                && bmn[1] <= amx[1] + pad
        }
        _ => false,
    }
}

/// A layer-wide loop set that hands out only the loops near a box. Offsets
/// and overlaps are local, so a test against one component gives the same
/// answer on its neighbors as on the whole layer, at the cost of the neighbors.
struct Nearby {
    loops: Vec<Loop>,
    boxes: Vec<Option<Bounds>>,
}

impl Nearby {
    fn new(loops: Vec<Loop>) -> Self {
        let boxes = loops
            .iter()
            .map(|l| loop_bounds(std::slice::from_ref(l)))
            .collect();
        Self { loops, boxes }
    }

    fn near(&self, bounds: Bounds, pad: f64) -> Vec<Loop> {
        self.loops
            .iter()
            .zip(&self.boxes)
            .filter(|(_, b)| boxes_within(Some(bounds), **b, pad))
            .map(|(l, _)| l.clone())
            .collect()
    }
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

    #[test]
    fn a_hole_around_an_island_stays_with_its_own_outline() {
        let hole = |x0: f64, y0: f64, x1: f64, y1: f64| {
            let mut l = rect(x0, y0, x1, y1);
            l.reverse();
            l
        };
        let tray = rect(0.0, 0.0, 100.0, 100.0);
        let cavity = hole(5.0, 5.0, 95.0, 95.0);
        let plate = rect(30.0, 30.0, 70.0, 70.0);
        let plate_hole = hole(45.0, 45.0, 55.0, 55.0);
        let comps = components(&[tray, cavity, plate, plate_hole]);
        let mut nets: Vec<f64> = comps
            .iter()
            .map(|c| c.iter().map(|l| signed_area(l)).sum())
            .collect();
        nets.sort_by(f64::total_cmp);
        assert_eq!(nets, vec![1500.0, 1900.0]);
    }
    use crate::adaptive::LayerBand;

    /// The pairwise scan that `pair_steps` replaced.
    fn pair_steps_by_scan(nodes: &[Node], grow: &Grow, max_step: f64) -> Vec<[f64; 2]> {
        let mut live: Vec<usize> = (0..nodes.len()).filter(|&i| nodes[i].freeze == 0).collect();
        live.sort_by(|&a, &b| nodes[a].xy[0].total_cmp(&nodes[b].xy[0]));
        let meet = |a: &Node, b: &Node| -> Option<(f64, [f64; 2])> {
            if a.to_bed != b.to_bed {
                return None;
            }
            let d = (a.xy[0] - b.xy[0]).hypot(a.xy[1] - b.xy[1]);
            if d > PAIR_REACH_MM {
                return None;
            }
            if grow.load_factor >= 3.0 && !carries(a, b, grow) {
                return None;
            }
            let (wa, wb) = (a.radius.powi(2), b.radius.powi(2));
            let at = [
                (a.xy[0] * wa + b.xy[0] * wb) / (wa + wb),
                (a.xy[1] * wa + b.xy[1] * wb) / (wa + wb),
            ];
            Some((d, at))
        };
        let mut pairs: Vec<(f64, usize, usize, [f64; 2])> = Vec::new();
        for (k, &a) in live.iter().enumerate() {
            for &b in &live[k + 1..] {
                if nodes[b].xy[0] - nodes[a].xy[0] > PAIR_REACH_MM {
                    break;
                }
                if let Some((d, at)) = meet(&nodes[a], &nodes[b]) {
                    pairs.push((d, a, b, at));
                }
            }
        }
        pairs.sort_by(|p, q| p.0.total_cmp(&q.0).then(p.1.cmp(&q.1)).then(p.2.cmp(&q.2)));
        let mut target: Vec<Option<[f64; 2]>> = vec![None; nodes.len()];
        let mut nearest: Vec<Option<[f64; 2]>> = vec![None; nodes.len()];
        for &(_, a, b, at) in &pairs {
            for i in [a, b] {
                nearest[i] = nearest[i].or(Some(at));
            }
            if target[a].is_none() && target[b].is_none() {
                target[a] = Some(at);
                target[b] = Some(at);
            }
        }
        nodes
            .iter()
            .enumerate()
            .map(|(i, n)| match target[i].or(nearest[i]) {
                Some(at) if n.freeze == 0 => step_toward(n.xy, at, max_step),
                _ => n.xy,
            })
            .collect()
    }

    fn node_at(id: u32, xy: [f64; 2], radius: f64, load: f64, to_bed: bool, freeze: u32) -> Node {
        Node {
            id,
            xy,
            above: xy,
            radius,
            dist: (id % 7) as f64,
            freeze,
            load,
            to_bed,
        }
    }

    #[test]
    fn pair_steps_match_the_pairwise_scan() {
        let mut seed = 0x9e37_79b9_7f4a_7c15u64;
        let mut next = move || {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            (seed >> 11) as f64 / (1u64 << 53) as f64
        };
        for case in 0..60 {
            let lattice = case % 3 == 0;
            let count = 2 + (next() * 400.0) as usize;
            let extent = 10.0 + next() * 120.0;
            let nodes: Vec<Node> = (0..count)
                .map(|i| {
                    let mut xy = [next() * extent, next() * extent];
                    if lattice {
                        xy = [(xy[0] / 3.5).round() * 3.5, (xy[1] / 3.5).round() * 3.5];
                    }
                    let radius = [0.4, 0.4, 0.8, 1.3, 2.1][(next() * 5.0) as usize];
                    let load = 1.0 + (next() * 6.0).floor();
                    node_at(
                        i as u32 + 1,
                        xy,
                        radius,
                        load,
                        next() < 0.3,
                        u32::from(next() < 0.1),
                    )
                })
                .collect();
            for load_factor in [1.5, 5.2] {
                let grow = Grow {
                    height: 0.2,
                    lean: 0.84,
                    tip_r: 0.4,
                    trunk_r: 2.1,
                    xy_gap: 0.55,
                    next_is_bed: false,
                    load_factor,
                    floor_y_max: None,
                    drift: 0.0,
                };
                let got = pair_steps(&nodes, &[], &grow, 0.17);
                let want = pair_steps_by_scan(&nodes, &grow, 0.17);
                assert_eq!(got, want, "case {case} load factor {load_factor}");
            }
        }
    }

    pub(super) fn rect(x0: f64, y0: f64, x1: f64, y1: f64) -> Loop {
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

    pub(super) fn layers(n: usize) -> Vec<LayerBand> {
        (0..n).map(|i| band(i, (i as f64 + 1.0) * 0.2)).collect()
    }

    pub(super) fn unfooted_interface(
        layers: &[SupportLayer],
        contours: &[Vec<Loop>],
    ) -> Vec<(usize, f64)> {
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

    /// Farthest interface point from what holds it on the layer below: a trunk
    /// disk, lower interface, or the part. Probes on a 0.25 mm grid.
    fn worst_interface_reach(layers: &[SupportLayer], contours: &[Vec<Loop>]) -> (f64, usize) {
        let mut worst = 0.0f64;
        let mut probes = 0;
        for i in 1..layers.len() {
            let Some((min, max)) = loop_bounds(&layers[i].interface) else {
                continue;
            };
            let below = &layers[i - 1];
            let held: Vec<&[Loop]> = [below.interface.as_slice(), contours[i - 1].as_slice()]
                .into_iter()
                .filter(|l| !l.is_empty())
                .collect();
            let mut y = min[1];
            while y <= max[1] {
                let mut x = min[0];
                while x <= max[0] {
                    if in_solid(&layers[i].interface, x, y) {
                        probes += 1;
                        let mut d = f64::MAX;
                        for disk in &below.disks {
                            d = d.min(((x - disk.xy[0]).hypot(y - disk.xy[1]) - disk.r).max(0.0));
                        }
                        for loops in &held {
                            d = d.min(if in_solid(loops, x, y) {
                                0.0
                            } else {
                                distance_to_outline(loops, [x, y])
                            });
                        }
                        worst = worst.max(d);
                    }
                    x += 0.25;
                }
                y += 0.25;
            }
        }
        (worst, probes)
    }

    pub(super) fn band(index: usize, z: f64) -> LayerBand {
        LayerBand {
            index,
            z,
            height: 0.2,
        }
    }

    #[test]
    fn speed_branches_stay_thin_under_a_wide_overhang_and_thicken_toward_the_bed() {
        // 60 × 20 mm plate 20 mm up on the speed knobs. Tips pair off, pairs
        // join into branches, and only the trunks near the bed carry enough
        // tips to reach the 2.1 mm cap.
        let bands = layers(110);
        let mut contours = vec![Vec::new(); bands.len()];
        for contour in contours.iter_mut().skip(100) {
            *contour = vec![rect(0.0, 0.0, 60.0, 20.0)];
        }
        let built = Supports::build(
            &bands,
            &contours,
            &SupportOpts {
                style: SupportStyle::Tree,
                density: 0.15,
                load_factor: 5.2,
                max_tip_spacing: 10.8,
                ..SupportOpts::default()
            },
        )
        .unwrap()
        .layers;
        assert!(unfooted_interface(&built, &contours).is_empty());
        let top = built
            .iter()
            .rposition(|l| !l.disks.is_empty())
            .expect("the plate grew no tree");
        let band_radii = |from: usize, to: usize| -> (f64, f64) {
            let radii: Vec<f64> = built[from..to]
                .iter()
                .flat_map(|l| l.disks.iter().map(|d| d.r))
                .collect();
            let max = radii.iter().copied().fold(0.0, f64::max);
            (radii.iter().sum::<f64>() / radii.len().max(1) as f64, max)
        };
        // The 3 mm under the lowest interface layer, and the 3 mm above the bed.
        let (under_mean, under_max) = band_radii(top - 14, top + 1);
        let (foot_mean, _) = band_radii(1, 16);
        assert!(
            under_max <= 1.0,
            "a branch within 3 mm of the interface is {under_max:.2} mm thick"
        );
        assert!(
            foot_mean >= 1.5 * under_mean,
            "trunks should thicken toward the bed, under {under_mean:.2} foot {foot_mean:.2}"
        );
        let tips = built[top].disks.len();
        let feet = built[0].disks.len();
        assert!(
            feet * 2 <= tips,
            "branches should join on the way down, {tips} tips {feet} feet"
        );
    }

    #[test]
    fn a_disk_nothing_can_hold_is_dropped() {
        let bands = [band(0, 0.2), band(1, 0.4)];
        let mut layers = vec![
            SupportLayer {
                sparse: Vec::new(),
                interface: Vec::new(),
                disks: vec![Disk {
                    xy: [0.0, 0.0],
                    r: 1.2,
                    node: NodeId(0),
                }],
            },
            SupportLayer {
                sparse: Vec::new(),
                interface: Vec::new(),
                disks: vec![
                    Disk {
                        xy: [0.0, 0.0],
                        r: 1.2,
                        node: NodeId(1),
                    },
                    Disk {
                        xy: [8.0, 0.0],
                        r: 1.2,
                        node: NodeId(2),
                    },
                ],
            },
        ];
        project(
            &mut layers,
            1,
            &bands,
            &[Vec::new(), Vec::new()],
            0.8,
            None,
            &crate::progress::Watch::idle(),
            crate::cancel::Job::default(),
        );
        assert_eq!(layers[0].disks.len(), 1);
        let kept: Vec<([f64; 2], NodeId)> =
            layers[1].disks.iter().map(|d| (d.xy, d.node)).collect();
        assert_eq!(kept, vec![([0.0, 0.0], NodeId(1))]);
        assert!((layers[1].disks[0].r - 1.2).abs() < 1e-9);
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
            ..SupportOpts::default()
        };
        let built = Supports::build(&bands, &contours, &opts).unwrap().layers;
        let bad = unfooted_interface(&built, &contours);
        assert!(bad.is_empty(), "interface with nothing under it: {bad:?}");
        let trunks = built
            .iter()
            .filter(|layer| {
                layer
                    .disks
                    .iter()
                    .map(|d| d.xy)
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
            ..SupportOpts::default()
        };
        let built = Supports::build(&bands, &contours, &opts).unwrap().layers;
        let bad = unfooted_interface(&built, &contours);
        assert!(bad.is_empty(), "interface with nothing under it: {bad:?}");
        let right = built.iter().any(|layer| {
            layer
                .disks
                .iter()
                .map(|d| d.xy)
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
            ..SupportOpts::default()
        };
        let shared = Supports::build(&bands, &contours, &base).unwrap().layers;
        assert!(
            unfooted_interface(&shared, &contours).is_empty(),
            "packed tips left interface in the air"
        );
        let peak = shared.iter().map(|l| l.disks.len()).max().unwrap_or(0);
        let bed = shared[0].disks.len();
        assert!(peak >= 3, "expected several tips, peak {peak}");
        assert!(bed >= 1, "the plate grew no trunk");
        assert!(
            bed < peak,
            "branches should join on the way down, peak {peak} bed {bed}"
        );
        let sparse = Supports::build(
            &bands,
            &contours,
            &SupportOpts {
                load_factor: 8.0,
                max_tip_spacing: 10.0,
                ..base
            },
        )
        .unwrap()
        .layers;
        let dense = Supports::build(
            &bands,
            &contours,
            &SupportOpts {
                load_factor: 0.8,
                max_tip_spacing: 3.2,
                ..base
            },
        )
        .unwrap()
        .layers;
        assert!(unfooted_interface(&sparse, &contours).is_empty());
        assert!(unfooted_interface(&dense, &contours).is_empty());
        let sparse_peak = sparse.iter().map(|l| l.disks.len()).max().unwrap_or(0);
        let dense_peak = dense.iter().map(|l| l.disks.len()).max().unwrap_or(0);
        assert!(
            sparse_peak < dense_peak,
            "load factor and tip spacing should thin the peak, sparse {sparse_peak} dense {dense_peak}"
        );
        // A thin twig prints one small loop and a trunk two large ones, so the
        // printed support scales with summed disk perimeter, not disk count.
        let perimeter = |built: &[SupportLayer]| -> f64 {
            built
                .iter()
                .flat_map(|l| &l.disks)
                .map(|d| std::f64::consts::TAU * d.r)
                .sum()
        };
        let (sparse_len, dense_len) = (perimeter(&sparse), perimeter(&dense));
        assert!(
            sparse_len < dense_len * 0.75,
            "sparse perimeter {sparse_len:.0} mm should be well under dense {dense_len:.0} mm"
        );
    }

    /// Bands and contours for a 40 x 14 mm plate 15.2 mm above the bed.
    pub(super) fn plate() -> (Vec<LayerBand>, Vec<Vec<Loop>>) {
        let bands = layers(80);
        let mut contours = vec![Vec::new(); bands.len()];
        for contour in contours.iter_mut().skip(76) {
            *contour = vec![rect(0.0, 0.0, 40.0, 14.0)];
        }
        (bands, contours)
    }

    pub(super) fn plate_opts() -> SupportOpts {
        SupportOpts {
            style: SupportStyle::Tree,
            density: 0.15,
            interface_layers: 2,
            z_gap: 0.2,
            ..SupportOpts::default()
        }
    }

    /// The forest holds the walk: each layer's raw disks come back from the
    /// knots live on it, every printed disk sits on its own limb's knot, and
    /// every end agrees with where the limb's knots stop.
    fn assert_forest_matches(bands: &[LayerBand], contours: &[Vec<Loop>], opts: &SupportOpts) {
        let walked = Supports::walk(bands, contours, opts).unwrap();
        let built = Supports::build(bands, contours, opts).unwrap();
        let forest = &built.forest;
        let limb = |id: NodeId| &forest.limbs[id.0 as usize - 1];
        for (k, l) in forest.limbs.iter().enumerate() {
            assert!(
                l.knots.iter().all(|n| n.id as usize == k + 1),
                "limb {} holds another node's knot",
                k + 1
            );
        }
        for (i, part) in contours.iter().enumerate() {
            let live: Vec<Node> = forest
                .limbs
                .iter()
                .filter(|l| l.bottom() <= i && i <= l.top)
                .map(|l| l.knots[l.top - i])
                .collect();
            assert_eq!(
                organic_disks(&live, part, opts.xy_gap),
                walked.layers[i].disks,
                "layer {i}: the knots do not give back the walk's disks"
            );
            for d in &built.layers[i].disks {
                let l = limb(d.node);
                assert!(
                    l.bottom() <= i && i <= l.top,
                    "layer {i}: disk of {:?} has no knot here",
                    d.node
                );
                let knot = l.knots[l.top - i];
                assert_eq!(
                    knot.freeze, 0,
                    "layer {i}: {:?} printed a frozen knot",
                    d.node
                );
                assert_eq!(knot.xy, d.xy, "layer {i}: {:?} moved off its knot", d.node);
                assert!(
                    d.r <= knot.radius,
                    "layer {i}: {:?} is wider than its knot",
                    d.node
                );
            }
        }
        for (k, l) in forest.limbs.iter().enumerate() {
            let id = NodeId(k as u32 + 1);
            let last = l.knots[l.knots.len() - 1];
            match l.end {
                End::Bed => assert_eq!(l.bottom(), 0, "{id:?} stopped short of the bed"),
                End::Merged { into } => {
                    assert!(into < id, "{id:?} merged into younger {into:?}");
                    let host = limb(into);
                    let at = l.bottom() - 1;
                    assert!(
                        host.bottom() <= at && at <= host.top,
                        "{into:?} has no knot to carry {id:?} on layer {at}"
                    );
                }
                End::Landed => {
                    let at = l.bottom() - 1;
                    assert!(
                        in_solid(&contours[at], last.xy[0], last.xy[1]),
                        "{id:?} landed beside the part on layer {at}"
                    );
                }
                End::Pinched => assert!(l.bottom() > 0, "{id:?} was pinched under the bed"),
            }
        }
    }

    #[test]
    fn the_forest_records_every_limb_of_a_plate_walk() {
        let (bands, contours) = plate();
        let opts = plate_opts();
        assert_forest_matches(&bands, &contours, &opts);
        let forest = Supports::build(&bands, &contours, &opts).unwrap().forest;
        let ends: Vec<End> = forest.limbs.iter().map(|l| l.end).collect();
        let merged = ends
            .iter()
            .filter(|e| matches!(e, End::Merged { .. }))
            .count();
        assert!(
            merged >= 3,
            "the plate merged only {merged} limbs: {ends:?}"
        );
        assert!(
            ends.contains(&End::Bed),
            "no limb reached the bed: {ends:?}"
        );
    }

    #[test]
    fn a_seeded_tip_is_a_limb_born_where_it_was_seeded() {
        // The ear of the orphan-lobe case gets its trunk from
        // `seed_uncovered_interface`, frozen for one layer instead of three.
        let bands = layers(30);
        let mut contours = vec![Vec::new(); bands.len()];
        contours[29] = boolean_union(
            &boolean_union(&[rect(0.0, 0.0, 8.0, 8.0)], &[rect(7.9, 3.0, 10.0, 5.0)]),
            &[rect(9.9, 2.5, 13.0, 5.5)],
        );
        for contour in contours.iter_mut().take(27) {
            *contour = vec![rect(-1.0, -1.0, 10.4, 9.0)];
        }
        let opts = SupportOpts {
            style: SupportStyle::Tree,
            density: 0.0,
            branch_spacing: 5.0,
            interface_layers: 3,
            z_gap: 0.2,
            ..SupportOpts::default()
        };
        assert_forest_matches(&bands, &contours, &opts);
        let forest = Supports::build(&bands, &contours, &opts).unwrap().forest;
        let seeded: Vec<(usize, [f64; 2])> = forest
            .limbs
            .iter()
            .filter(|l| l.knots[0].freeze == 1)
            .map(|l| (l.top, l.knots[0].xy))
            .collect();
        assert!(
            seeded.iter().any(|&(_, xy)| xy[0] > 11.0),
            "no seeded limb on the ear: {seeded:?}"
        );
    }

    /// A 4 mm pad 30 mm up, over the flank of a stepped pyramid. The flank
    /// widens 0.2 mm a layer, faster than the trunk can step away, so the
    /// trunk is cut off: settling drops its disks and the pad's interface
    /// loses its footing.
    pub(super) fn pad_over_flank() -> (Vec<LayerBand>, Vec<Vec<Loop>>) {
        let bands = layers(170);
        let mut contours = vec![Vec::new(); bands.len()];
        for (i, contour) in contours.iter_mut().enumerate() {
            if i >= 150 {
                *contour = vec![rect(25.0, 5.0, 29.0, 9.0)];
            } else if i < 120 {
                let w = 3.0 + (120 - i) as f64 * 0.2;
                *contour = vec![rect(20.0 - w, 7.0 - w, 20.0 + w, 7.0 + w)];
            }
        }
        (bands, contours)
    }

    #[test]
    fn coverage_reports_the_cut_off_pad_and_nothing_under_a_held_plate() {
        let (bands, contours) = pad_over_flank();
        let supports = Supports::build(&bands, &contours, &plate_opts()).unwrap();
        let gaps = supports.coverage(&bands, &contours);
        assert_eq!(gaps.len(), 1, "{gaps:?}");
        let gap = &gaps[0];
        // Both interface layers under the pad, from its contact down.
        assert!(
            (gap.z[0] - 29.6).abs() < 1e-6 && (gap.z[1] - 29.8).abs() < 1e-6,
            "z {:?}",
            gap.z
        );
        assert!((gap.area_mm2 - 16.0).abs() < 0.1, "area {}", gap.area_mm2);
        assert_eq!((gap.min, gap.max), ([25.0, 5.0], [29.0, 9.0]));
        assert_eq!(gap.outline.len(), 1, "{:?}", gap.outline);

        let (bands, contours) = plate();
        let supports = Supports::build(&bands, &contours, &plate_opts()).unwrap();
        let printed = supports
            .layers
            .iter()
            .filter(|l| !l.interface.is_empty())
            .count();
        assert_eq!(printed, 2, "the plate should print both interface layers");
        assert_eq!(supports.coverage(&bands, &contours), Vec::new());
    }

    #[test]
    fn project_matches_settling_every_layer_before_dropping_interface() {
        let (bands, contours) = pad_over_flank();
        let opts = plate_opts();
        let raw = Supports::walk(&bands, &contours, &opts).unwrap().layers;
        let lean = lean_of(&opts);
        let mut fused = raw.clone();
        project(
            &mut fused,
            1,
            &bands,
            &contours,
            lean,
            None,
            &crate::progress::Watch::idle(),
            crate::cancel::Job::default(),
        );
        let mut apart = raw.clone();
        let mut near = Vec::new();
        for i in 1..apart.len() {
            let (lower, upper) = apart.split_at_mut(i);
            let reach = bands[i].height * lean + BEAD_OVERHANG_MM;
            let part = contours[i - 1].as_slice();
            settle_disks(
                &mut upper[0].disks,
                &lower[i - 1].disks,
                part,
                None,
                0.0,
                reach,
                &mut near,
            );
        }
        for i in 1..apart.len() {
            let (lower, upper) = apart.split_at_mut(i);
            drop_unfooted_interface(&mut upper[0].interface, &lower[i - 1], &contours[i - 1]);
        }
        let count = |layers: &[SupportLayer], f: fn(&SupportLayer) -> bool| {
            layers.iter().filter(|l| f(l)).count()
        };
        let disks = |l: &SupportLayer| !l.disks.is_empty();
        let interface = |l: &SupportLayer| !l.interface.is_empty();
        assert_eq!(
            (count(&raw, disks), count(&raw, interface)),
            (78, 2),
            "the walk grew a different pad"
        );
        assert_eq!(
            (count(&fused, disks), count(&fused, interface)),
            (0, 0),
            "the cut-off trunk and its interface should both drop"
        );
        assert_eq!(fused, apart);
    }

    #[test]
    fn tree_disks_on_a_layer_carry_distinct_nodes_in_walk_order() {
        let bands = layers(80);
        let mut contours = vec![Vec::new(); bands.len()];
        let plate = rect(0.0, 0.0, 40.0, 14.0);
        for contour in contours.iter_mut().skip(76) {
            *contour = vec![plate.clone()];
        }
        let built = Supports::build(
            &bands,
            &contours,
            &SupportOpts {
                style: SupportStyle::Tree,
                density: 0.15,
                interface_layers: 2,
                z_gap: 0.2,
                ..SupportOpts::default()
            },
        )
        .unwrap()
        .layers;
        let shared = built.iter().filter(|l| l.disks.len() >= 2).count();
        assert!(shared > 0, "no layer printed two disks");
        for (i, layer) in built.iter().enumerate() {
            let nodes: Vec<NodeId> = layer.disks.iter().map(|d| d.node).collect();
            assert!(
                nodes.windows(2).all(|w| w[0] < w[1]),
                "layer {i} disks are not in ascending node order: {nodes:?}"
            );
        }
    }

    #[test]
    fn speed_ledge_interface_stays_within_half_a_pitch_cell_of_a_trunk() {
        // samples/overhang_ledge.stl: a 24 mm block, and a 24 × 16 mm ledge
        // off its side from z 12 to 16. Speed packs tips on a 10.8 mm pitch.
        // Tips on that grid leave no point farther than half a cell diagonal,
        // 7.6 mm, from one. Tips parked on the patch's low-x edge overhang the
        // far edge by more than that.
        let bands = layers(80);
        let mut contours = vec![vec![rect(0.0, 0.0, 24.0, 24.0)]; 60];
        contours.extend(vec![vec![rect(24.0, 4.0, 48.0, 20.0)]; 20]);
        let built = Supports::build(
            &bands,
            &contours,
            &SupportOpts {
                style: SupportStyle::Tree,
                density: 0.15,
                load_factor: 5.2,
                max_tip_spacing: 10.8,
                ..SupportOpts::default()
            },
        )
        .unwrap()
        .layers;
        assert!(unfooted_interface(&built, &contours).is_empty());
        let (worst, probes) = worst_interface_reach(&built, &contours);
        assert!(
            probes > 1000,
            "the ledge printed no interface, {probes} probes"
        );
        assert!(
            worst <= 7.6,
            "interface overhangs its trunks by {worst:.2} mm"
        );
    }

    #[test]
    fn two_close_tips_become_one_trunk_before_the_bed() {
        let bands = layers(40);
        let mut contours = vec![Vec::new(); bands.len()];
        // Two 4 mm pads, centres 8 mm apart. Each is its own component, so
        // packing cannot delete one; the fall has to join them.
        contours[39] = boolean_union(&[rect(0.0, 0.0, 4.0, 4.0)], &[rect(8.0, 0.0, 12.0, 4.0)]);
        let built = Supports::build(
            &bands,
            &contours,
            &SupportOpts {
                style: SupportStyle::Tree,
                density: 0.0,
                load_factor: 0.8,
                max_tip_spacing: 3.0,
                interface_layers: 2,
                z_gap: 0.2,
                ..SupportOpts::default()
            },
        )
        .unwrap()
        .layers;
        assert!(unfooted_interface(&built, &contours).is_empty());
        let peak = built.iter().map(|l| l.disks.len()).max().unwrap_or(0);
        let bed = built[0].disks.len();
        let trace: Vec<(usize, usize)> = built
            .iter()
            .enumerate()
            .filter(|(_, l)| !l.disks.is_empty())
            .map(|(i, l)| (i, l.disks.len()))
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
        let packed = pack_tips(pts, &[rect(-1.0, -1.0, 13.0, 1.0)], 7.0, 2.0);
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
    fn a_speed_merge_never_loads_a_trunk_past_its_capacity() {
        // Two full trunks 0.5 mm apart, 20 mm down. The cone test takes
        // either one into the other. At speed one 4.2 mm trunk that long is
        // rated for 5.2 * (2.1 / 0.4)^2 / (1 + 20 / 28) = 83.6 tip-units.
        let grow = |load_factor| Grow {
            height: 0.2,
            lean: 0.84,
            tip_r: 0.4,
            trunk_r: 2.1,
            xy_gap: 0.55,
            next_is_bed: false,
            load_factor,
            floor_y_max: None,
            drift: 0.0,
        };
        let pair = |load| {
            vec![[0.0, 0.0], [0.5, 0.0]]
                .into_iter()
                .zip(1..)
                .map(|(xy, id)| Node {
                    id,
                    xy,
                    above: xy,
                    radius: 2.1,
                    dist: 20.0,
                    freeze: 0,
                    load,
                    to_bed: true,
                })
                .collect::<Vec<_>>()
        };
        let loads = |nodes: &[Node]| nodes.iter().map(|n| n.load).collect::<Vec<_>>();

        let mut ended = Vec::new();
        let mut over = pair(60.0);
        merge_nodes(&mut over, &grow(5.2), 0.17, &mut ended);
        assert_eq!(
            loads(&over),
            vec![60.0, 60.0],
            "120 tip-units on a trunk rated 83.6"
        );
        assert_eq!(ended, vec![]);

        let mut under = pair(30.0);
        merge_nodes(&mut under, &grow(5.2), 0.17, &mut ended);
        assert_eq!(loads(&under), vec![60.0]);
        let joined = (NodeId(2), End::Merged { into: NodeId(1) });
        assert_eq!(ended, vec![joined]);

        // Toughness has no load rating, so its cone merge stands.
        ended.clear();
        let mut tough = pair(60.0);
        merge_nodes(&mut tough, &grow(1.5), 0.17, &mut ended);
        assert_eq!(loads(&tough), vec![120.0]);
        assert_eq!(ended, vec![joined]);
    }

    #[test]
    fn a_packed_tip_stands_at_the_centre_of_the_samples_it_carries() {
        // An L of samples, all within 5 mm of the first. The tip moves off
        // the corner to their centroid.
        let pts = vec![[-4.75, -4.75], [-4.75, 0.0], [0.0, -4.75]];
        let square = [rect(-6.0, -6.0, 6.0, 6.0)];
        let packed = pack_tips(pts.clone(), &square, 5.0, 5.2);
        assert_eq!(
            packed.len(),
            1,
            "one keeper should carry all three: {packed:?}"
        );
        let (tip, load) = packed[0];
        assert!(
            (tip[0] + 19.0 / 6.0).abs() < 1e-9 && (tip[1] + 19.0 / 6.0).abs() < 1e-9,
            "tip {tip:?} is not at the centroid"
        );
        assert_eq!(load, 3.0);
        // The same samples on a ring around a post. The centroid is over the
        // post, so the tip stays on the ring at the sample nearest it.
        let ring = [rect(-6.0, -6.0, 6.0, 6.0), rect(-3.5, -3.5, 3.5, 3.5)];
        assert_eq!(pack_tips(pts, &ring, 5.0, 5.2), vec![([-4.75, -4.75], 3.0)]);
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
        let built = Supports::build(
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
                ..SupportOpts::default()
            },
        )
        .unwrap()
        .layers;
        assert!(
            unfooted_interface(&built, &contours).is_empty(),
            "outer ear interface was left in the air"
        );
        assert!(
            !built[0].disks.is_empty(),
            "the part of the ear past the lean cone lost its bed trunk"
        );
        let on_head = built.iter().enumerate().any(|(i, layer)| {
            (70..100).contains(&i)
                && layer
                    .disks
                    .iter()
                    .map(|d| d.xy)
                    .any(|c| (2.0..26.0).contains(&c[0]) && (2.0..19.5).contains(&c[1]))
        });
        assert!(on_head, "the ear over the head lost its footing");
    }

    #[test]
    fn a_trunk_under_a_sloped_underside_stays_inside_the_lean() {
        // A plate leaning 56° from vertical, 24 mm tall: each layer sticks out
        // 0.3 mm past the one under it, so a fresh tip is born every layer
        // along the underside. Branches may lean 40°, so no trunk can follow
        // the underside and stay inside the lean.
        let bands = layers(120);
        let contours: Vec<Vec<Loop>> = (0..120)
            .map(|i| {
                let x = 0.3 * i as f64;
                vec![rect(x, 0.0, x + 6.0, 10.0)]
            })
            .collect();
        let supports = Supports::build(
            &bands,
            &contours,
            &SupportOpts {
                style: SupportStyle::Tree,
                density: 0.15,
                load_factor: 5.2,
                max_tip_spacing: 10.8,
                ..SupportOpts::default()
            },
        )
        .unwrap();
        assert!(unfooted_interface(&supports.layers, &contours).is_empty());
        assert_eq!(supports.coverage(&bands, &contours), vec![]);
        let lean = 40f64.to_radians().tan();
        let mut worst = (0.0, 0.0, 0);
        for (k, limb) in supports.forest.limbs.iter().enumerate() {
            let live: Vec<[f64; 2]> = limb
                .knots
                .iter()
                .filter(|n| n.freeze == 0)
                .map(|n| n.xy)
                .collect();
            let travel: f64 = live
                .windows(2)
                .map(|w| (w[1][0] - w[0][0]).hypot(w[1][1] - w[0][1]))
                .sum();
            let fall = live.len().saturating_sub(1) as f64 * 0.2;
            if travel - lean * fall > worst.0 - lean * worst.1 {
                worst = (travel, fall, k + 1);
            }
        }
        let (travel, fall, id) = worst;
        assert!(
            travel <= lean * fall + 1.0,
            "limb {id} travelled {travel:.1} mm over a {fall:.1} mm fall"
        );
    }
}
